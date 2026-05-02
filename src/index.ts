#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { Steel } from "steel-sdk";
import { EnvSchema } from "./env";
import {
  buildRadioSelector,
  capText,
  cleanErrorMessage,
  dedupeLinks,
  deriveDownloadFilename,
  detectFieldKind,
  findTitle,
  interpretCheckboxValue,
  isBotWall,
  isBrowserClosedError,
  isSteelSessionStuck,
  matchesCookieHost,
  mimeToExt,
  pickPrimaryLink,
  type Link,
} from "./helpers";
import { z } from "zod";

// -----------------------------------------------------------------------------
// MCP server instance
// -----------------------------------------------------------------------------
const server = new McpServer(
  { name: "Steel Browser MCP Server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const env = EnvSchema.parse(process.env);

// -----------------------------------------------------------------------------
// BrowserManager — wraps Playwright browser lifecycle (Steel or local)
// -----------------------------------------------------------------------------

type ConsoleMessage = {
  level: string;
  text: string;
  timestamp: number;
  location?: { url: string; lineNumber: number; columnNumber: number };
};

class BrowserManager {
  private browser: Browser | undefined;
  private browserContext: BrowserContext | undefined;
  private steelClient: Steel | undefined;
  private sessionId: string | undefined;
  public debugUrl: string | undefined;
  public sessionViewerUrl: string | undefined;
  public consoleLogs: ConsoleMessage[] = [];
  public initialized = false;

  // Tab management — integer IDs starting at 1.
  // Concurrency: multiple agents can share one browser. Tabs carry an
  // optional `owner` string so agents can clean up only their own tabs
  // via close_tabs_by_owner, not kill the whole session.
  // Idle sweeper: tabs untouched for TAB_IDLE_TIMEOUT_MS are auto-closed,
  // EXCEPT the primary tab (Steel's initial page or local-mode's initial
  // newPage). Closing the primary makes Steel's session refuse to reuse
  // with a "Failed to refresh primary page" 500.
  private tabs: Map<number, Page> = new Map();
  private tabOwners: Map<number, string> = new Map();
  private tabLastActivity: Map<number, number> = new Map();
  private primaryTabId: number | undefined;
  private idleSweeperHandle: NodeJS.Timeout | undefined;
  private nextTabId = 1;
  private currentTabId = 1;

  // Profile management — multiple isolated BrowserContexts within one browser.
  // Each profile has its own cookies/localStorage/cache. Tabs from all profiles
  // share the global tabs map (globally unique tabId), so existing tools work
  // unchanged — agents just pass their tabId.
  private profiles: Map<string, { context: BrowserContext; tabIds: Set<number> }> = new Map();
  private tabToProfile: Map<number, string> = new Map(); // tabId → profileName
  // Profile management — multiple isolated BrowserContexts within one browser.

  /** Mark a tab as recently used. Called on every page-interacting tool. */
  touchTab(tabId: number): void {
    if (this.tabs.has(tabId)) this.tabLastActivity.set(tabId, Date.now());
  }

  private allocateTab(page: Page, owner?: string): number {
    const id = this.nextTabId++;
    this.tabs.set(id, page);
    if (owner) this.tabOwners.set(id, owner);
    this.tabLastActivity.set(id, Date.now());
    this.attachConsoleListener(page);
    // Auto-cleanup tab bookkeeping if the page closes externally.
    page.on("close", () => {
      this.tabs.delete(id);
      this.tabOwners.delete(id);
      this.tabLastActivity.delete(id);
      const profileName = this.tabToProfile.get(id);
      if (profileName) {
        this.tabToProfile.delete(id);
        const profile = this.profiles.get(profileName);
        if (profile) profile.tabIds.delete(id);
      }
    });
    return id;
  }

  /** Start the idle sweeper. Idempotent; no-op if TAB_IDLE_TIMEOUT_MS=0. */
  private startIdleSweeper(): void {
    if (this.idleSweeperHandle) return;
    if (env.TAB_IDLE_TIMEOUT_MS <= 0) return;
    this.idleSweeperHandle = setInterval(() => {
      this.sweepIdleTabs().catch((err) => {
        console.error("[steel-mcp] idle sweep error:", (err as Error).message);
      });
    }, env.TAB_IDLE_SWEEP_INTERVAL_MS);
    // Don't block Node process exit waiting for this timer.
    this.idleSweeperHandle.unref?.();
  }

  /**
   * Close any tab whose last activity is older than TAB_IDLE_TIMEOUT_MS.
   * The primary tab (Steel's initial page or local-mode's initial page) is
   * NEVER swept — closing it poisons Steel's session reuse and causes a
   * "Failed to refresh primary page" 500 on subsequent connects.
   */
  async sweepIdleTabs(): Promise<number[]> {
    if (env.TAB_IDLE_TIMEOUT_MS <= 0) return [];
    const cutoff = Date.now() - env.TAB_IDLE_TIMEOUT_MS;
    const stale: number[] = [];
    for (const [id, last] of this.tabLastActivity) {
      if (id === this.primaryTabId) continue;
      if (last < cutoff) stale.push(id);
    }
    for (const id of stale) {
      try {
        await this.closeTab(id);
        console.error(`[steel-mcp] idle-sweep closed tab ${id} (${env.TAB_IDLE_TIMEOUT_MS}ms idle)`);
      } catch {
        /* ignore */
      }
    }
    return stale;
  }

  get currentPage(): Page | undefined {
    return this.tabs.get(this.currentTabId);
  }

  /**
   * Rewrite an internal Steel URL to the public-facing URL.
   * Only applies when STEEL_PUBLIC_URL and STEEL_BASE_URL are both set.
   * Used exclusively for display URLs (debug, interactive, viewer) — the CDP
   * WebSocket connection always uses the internal address.
   */
  private rewriteUrl(url: string): string {
    if (!env.STEEL_PUBLIC_URL || !env.STEEL_BASE_URL || !url) return url;
    const internal = env.STEEL_BASE_URL.replace(/\/$/, "");
    const pub = env.STEEL_PUBLIC_URL.replace(/\/$/, "");
    return url.replace(internal, pub);
  }

  /**
   * Create a fresh Steel session, connect Playwright CDP, wire the initial
   * page + context. Extracted so initialize() can retry it on a detected
   * stuck-session condition after clearing server-side state.
   */
  private async _connectSteel(): Promise<void> {
    this.steelClient = new Steel({
      steelAPIKey: env.STEEL_API_KEY ?? "local",
      ...(env.STEEL_BASE_URL ? { baseURL: env.STEEL_BASE_URL } : {}),
    });

    const session = await this.steelClient.sessions.create({
      timeout: env.SESSION_TIMEOUT_MS,
      ...(env.OPTIMIZE_BANDWIDTH ? { optimizeBandwidth: true } : {}),
    });
    this.sessionId = session.id;
    this.debugUrl = this.rewriteUrl(session.debugUrl);
    this.sessionViewerUrl = this.rewriteUrl(session.sessionViewerUrl);

    let wsUrl: string;
    if (env.STEEL_BASE_URL) {
      const base = env.STEEL_BASE_URL.replace(/\/$/, "");
      const wsBase = base.startsWith("https://")
        ? base.replace("https://", "wss://")
        : base.replace("http://", "ws://");
      wsUrl = `${wsBase}/v1/sessions/${session.id}/cdp`;
    } else {
      wsUrl = `${session.websocketUrl}&apiKey=${env.STEEL_API_KEY}`;
    }

    this.browser = await chromium.connectOverCDP(wsUrl);
    this.browserContext = this.browser.contexts()[0];
    const initialPage = this.browserContext.pages()[0];
    this.currentTabId = this.allocateTab(initialPage);
    // Mark as primary — idle sweeper must never close this tab, else Steel's
    // session refuses to reuse with a "page_refresh" 500.
    this.primaryTabId = this.currentTabId;
  }

  /**
   * Release every `live` session on the Steel server. Called as a recovery
   * step when we detect a stuck-session condition on connect — we can't
   * know which session is ours, so we clear them all. Safe for single-tenant
   * Steel instances; on a shared Steel you'd want to scope this by
   * `userMetadata` or a labelling convention.
   *
   * Uses the Steel REST API directly rather than the SDK so we don't have
   * to reason about SDK version differences.
   */
  private async _releaseAllLiveSessions(): Promise<void> {
    if (!env.STEEL_BASE_URL) {
      // Steel Cloud — we don't have blanket delete rights. Let the SDK retry
      // handle it; bubble the error out to the tool caller.
      console.error("[steel-mcp] Steel Cloud mode — skipping session sweep (no admin rights).");
      return;
    }
    const base = env.STEEL_BASE_URL.replace(/\/$/, "");
    const apiKey = env.STEEL_API_KEY;
    const authHeader: Record<string, string> = apiKey ? { "steel-api-key": apiKey } : {};
    try {
      const listRes = await fetch(`${base}/v1/sessions`, { headers: authHeader });
      if (!listRes.ok) {
        console.error(`[steel-mcp] sessions list failed: ${listRes.status} ${listRes.statusText}`);
        return;
      }
      const payload = (await listRes.json()) as { sessions?: Array<{ id: string; status: string }> };
      const live = (payload.sessions ?? []).filter((s) => s.status === "live");
      console.error(`[steel-mcp] releasing ${live.length} live session(s)`);
      for (const s of live) {
        try {
          const rel = await fetch(`${base}/v1/sessions/${s.id}/release`, {
            method: "POST",
            headers: authHeader,
          });
          if (rel.ok) {
            console.error(`[steel-mcp]   released ${s.id}`);
          } else {
            console.error(`[steel-mcp]   release failed ${s.id}: ${rel.status}`);
          }
        } catch (e) {
          console.error(`[steel-mcp]   release error ${s.id}:`, (e as Error).message);
        }
      }
    } catch (err) {
      console.error("[steel-mcp] session sweep failed:", (err as Error).message);
    }
  }

  async initialize() {
    if (this.initialized) return;

    if (env.BROWSER_MODE === "steel") {
      try {
        await this._connectSteel();
      } catch (err) {
        if (!isSteelSessionStuck(err)) throw err;
        console.error(
          "[steel-mcp] stuck Steel session detected on connect; releasing all live sessions and retrying. Cause:",
          (err as Error).message
        );
        await this._releaseAllLiveSessions();
        await sleep(1000);
        // Drop the previous Steel client and any dangling state, then retry
        // with a fresh connection.
        this.steelClient = undefined;
        this.sessionId = undefined;
        this.browser = undefined;
        this.browserContext = undefined;
        await this._connectSteel();
      }
    } else {
      // Local mode — launch Playwright Chromium directly.
      this.browser = await chromium.launch({ headless: false });
      this.browserContext = await this.browser.newContext({
        viewport: {
          width: env.DEFAULT_VIEWPORT_WIDTH,
          height: env.DEFAULT_VIEWPORT_HEIGHT,
        },
      });
      const initialPage = await this.browserContext.newPage();
      this.currentTabId = this.allocateTab(initialPage);
      // Mark primary — consistency with steel mode, and protects the only
      // viewport-ready page from being swept.
      this.primaryTabId = this.currentTabId;
    }

    this.initialized = true;
    this.startIdleSweeper();

    // Health check: prove the context is actually usable before returning.
    // Race condition guard — on some CDP connects, browserContext is reachable
    // but pages() throws or returns empty for a brief window. Block here so
    // the immediate next new_tab / getPage call doesn't race.
    try {
      const pages = this.browserContext!.pages();
      if (!pages || pages.length === 0) {
        // Context exists but has no pages — create a probe page to confirm.
        const probe = await this.browserContext!.newPage();
        await probe.close();
      }
    } catch (err) {
      // If the health check itself fails with a closed-browser error, reset
      // and let the next call trigger a fresh initialize via the retry path.
      if (isBrowserClosedError(err)) {
        await this.softReset();
        throw err;
      }
      // Other errors (timeouts etc) — log but don't fail hard.
      console.error("[steel-mcp] init health check warning:", (err as Error).message);
    }
  }

  /** Attach console log capture to a page (idempotent label via WeakSet). */
  private listenedPages = new WeakSet<Page>();
  private attachConsoleListener(page: Page) {
    if (this.listenedPages.has(page)) return;
    this.listenedPages.add(page);
    page.on("console", (msg) => {
      const loc = msg.location();
      this.consoleLogs.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
        location:
          loc && loc.url
            ? { url: loc.url, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }
            : undefined,
      });
      // Ring buffer — keep at most 500 entries.
      if (this.consoleLogs.length > 500) {
        this.consoleLogs.splice(0, this.consoleLogs.length - 500);
      }
    });
    // Also capture unhandled pageerror (thrown exceptions, promise rejections
    // not caught by page code). These don't appear on `console` — they surface
    // as `pageerror` events. Treat as level=error for user-facing filter.
    page.on("pageerror", (err) => {
      this.consoleLogs.push({
        level: "error",
        text: `[pageerror] ${err.name}: ${err.message}`,
        timestamp: Date.now(),
      });
      if (this.consoleLogs.length > 500) {
        this.consoleLogs.splice(0, this.consoleLogs.length - 500);
      }
    });
  }

  /**
   * Return the Page for `tabId` (if given) or the current active tab.
   * Auto-recovers from transient "browser has been closed" errors with one
   * soft-reset + retry. Use tabId for concurrent agent workflows where
   * different agents hold different tabs. Touches the tab's lastActivity
   * timestamp so the idle sweeper leaves active tabs alone.
   */
  async getPage(tabId?: number): Promise<Page> {
    await this.initialize();
    if (tabId !== undefined) {
      const page = this.tabs.get(tabId);
      if (!page) throw new Error(`Tab ${tabId} does not exist.`);
      if (page.isClosed()) throw new Error(`Tab ${tabId} is closed.`);
      this.touchTab(tabId);
      return page;
    }
    const page = this.currentPage;
    if (page && !page.isClosed()) {
      this.touchTab(this.currentTabId);
      return page;
    }
    // Current tab missing or closed — open a fresh one with retry guard.
    return this._openFreshPage();
  }

  private async _openFreshPage(): Promise<Page> {
    try {
      const newPage = await this.browserContext!.newPage();
      this.currentTabId = this.allocateTab(newPage);
      return newPage;
    } catch (err) {
      if (!isBrowserClosedError(err)) throw err;
      await this.softReset();
      await sleep(2000);
      await this.initialize();
      const newPage = await this.browserContext!.newPage();
      this.currentTabId = this.allocateTab(newPage);
      return newPage;
    }
  }

  /**
   * Open a new tab, register it, switch to it, and return its ID and page.
   * `owner` tag lets concurrent agents clean up only their own tabs later
   * via close_tabs_by_owner. Auto-retries on transient browser-closed errors.
   */
  async newTab(url?: string, owner?: string, profileName?: string): Promise<{ tabId: number; page: Page }> {
    await this.initialize();
    try {
      return await this._doNewTab(url, owner, profileName);
    } catch (err) {
      if (!isBrowserClosedError(err)) throw err;
      await this.softReset();
      await sleep(2000);
      await this.initialize();
      return await this._doNewTab(url, owner, profileName);
    }
  }

  private async _doNewTab(url?: string, owner?: string, profileName?: string): Promise<{ tabId: number; page: Page }> {
    // If a profile is specified, open the tab in that profile's context
    let context = this.browserContext!;
    if (profileName) {
      const profile = this.profiles.get(profileName);
      if (!profile) throw new Error(`Profile "${profileName}" not found. Create it with create_profile first.`);
      context = profile.context;
    }
    const page = await context.newPage();
    // Profile tabs get JS-level stealth via addInitScript (set on context creation).
    // HTTP UA in profiles shows HeadlessChrome — acceptable, see createProfile comment.
    const tabId = this.allocateTab(page, owner);
    this.currentTabId = tabId;
    // Track profile membership
    if (profileName) {
      const profile = this.profiles.get(profileName)!;
      profile.tabIds.add(tabId);
      this.tabToProfile.set(tabId, profileName);
    }
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return { tabId, page };
  }

  /**
   * Close all tabs owned by a given agent tag. Returns the list of closed
   * tab IDs. Does NOT stop the browser — other agents' tabs remain usable.
   */
  async closeTabsByOwner(owner: string): Promise<number[]> {
    const closed: number[] = [];
    const ids = Array.from(this.tabOwners.entries())
      .filter(([, o]) => o === owner)
      .map(([id]) => id);
    for (const id of ids) {
      // Belt-and-braces: even if the primary tab somehow got an owner tag,
      // never close it via this bulk path.
      if (id === this.primaryTabId) continue;
      try {
        await this.closeTab(id);
        closed.push(id);
      } catch {
        /* ignore individual failures */
      }
    }
    return closed;
  }

  /** Drop all state without trying to close a browser that may already be gone. */
  private async softReset(): Promise<void> {
    if (this.idleSweeperHandle) {
      clearInterval(this.idleSweeperHandle);
      this.idleSweeperHandle = undefined;
    }
    // Close all profile contexts (prevents leaked BrowserContexts)
    for (const [, profile] of this.profiles) {
      await profile.context.close().catch(() => {});
    }
    this.profiles.clear();
    this.tabToProfile.clear();
    this.tabs.clear();
    this.tabOwners.clear();
    this.tabLastActivity.clear();
    this.primaryTabId = undefined;
    this.nextTabId = 1;
    this.currentTabId = 1;
    this.browserContext = undefined;
    this.browser = undefined;
    this.consoleLogs = [];
    this.initialized = false;
  }

  /** Close a tab by ID (default: current). Switches to nearest remaining tab. */
  async closeTab(tabId?: number): Promise<void> {
    const id = tabId ?? this.currentTabId;
    const page = this.tabs.get(id);
    if (!page) throw new Error(`Tab ${id} does not exist.`);
    if (id === this.primaryTabId) {
      throw new Error(
        `Tab ${id} is the primary tab and cannot be closed. Closing it would poison Steel's session (page_refresh failure). Use stop_browser to end the session instead.`
      );
    }
    await page.close().catch(() => {});
    this.tabs.delete(id);
    this.tabOwners.delete(id);
    this.tabLastActivity.delete(id);

    // Clean up profile membership
    const profileName = this.tabToProfile.get(id);
    if (profileName) {
      this.tabToProfile.delete(id);
      const profile = this.profiles.get(profileName);
      if (profile) profile.tabIds.delete(id);
    }

    // If we closed the active tab, switch to the highest remaining tab.
    if (id === this.currentTabId) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.currentTabId = remaining[remaining.length - 1];
      }
      // If no tabs remain, next getPage() will open a fresh one.
    }
  }

  /** Return a snapshot of all open tabs, including owner tags. */
  async listTabs(): Promise<{ tabId: number; url: string; title: string; active: boolean; owner?: string; profile?: string }[]> {
    await this.initialize();
    const result: { tabId: number; url: string; title: string; active: boolean; owner?: string; profile?: string }[] = [];
    for (const [id, page] of this.tabs) {
      if (page.isClosed()) continue;
      const row: { tabId: number; url: string; title: string; active: boolean; owner?: string; profile?: string } = {
        tabId: id,
        url: page.url(),
        title: await page.title(),
        active: id === this.currentTabId,
      };
      const o = this.tabOwners.get(id);
      if (o) row.owner = o;
      const p = this.tabToProfile.get(id);
      if (p) row.profile = p;
      result.push(row);
    }
    return result;
  }

  /**
   * Create a named profile (isolated BrowserContext). Optionally restore
   * cookies from a previously saved profile JSON on disk. Returns the tab ID
   * of the initial page in the new context.
   */
  /**
   * Load the stealth init script for profile contexts. Chrome extensions
   * loaded via --load-extension only inject content scripts into the default
   * BrowserContext — additional contexts created via browser.newContext() get
   * nothing. We compensate by injecting the stealth overrides via addInitScript.
   */
  private async injectStealthIntoContext(context: BrowserContext): Promise<void> {
    // Try to read the unified fingerprint generated by the entrypoint
    let fpConfig: Record<string, unknown> | null = null;
    try {
      const raw = await fs.readFile("/tmp/steel-unified-fingerprint.json", "utf8");
      const fpResult = JSON.parse(raw);
      const fp = fpResult.fingerprint;
      const nav = fp?.navigator || {};
      const videoCard = fp?.videoCard || {};
      const uaData = nav.userAgentData || {};
      fpConfig = {
        userAgent: nav.userAgent,
        platform: nav.platform || "MacIntel",
        vendor: nav.vendor || "Google Inc.",
        deviceMemory: nav.deviceMemory || 8,
        hardwareConcurrency: nav.hardwareConcurrency || 8,
        maxTouchPoints: nav.maxTouchPoints || 0,
        languages: nav.languages || ["en-ZA", "en"],
        webglVendor: videoCard.vendor || "Google Inc. (Apple)",
        webglRenderer: videoCard.renderer || "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        brands: uaData.brands || [{ brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }],
        uaPlatform: uaData.platform || "macOS",
        uaMobile: uaData.mobile || false,
        platformVersion: uaData.platformVersion || "14.5.0",
        architecture: uaData.architecture || "arm",
        bitness: uaData.bitness || "64",
        uaFullVersion: (nav.userAgent?.match(/Chrome\/([0-9.]+)/)?.[1]) || "130.0.0.0",
      };
    } catch {
      // No unified fingerprint available — use defaults
      fpConfig = {
        platform: "MacIntel", vendor: "Google Inc.", deviceMemory: 8, hardwareConcurrency: 10,
        maxTouchPoints: 0, languages: ["en-ZA", "en"],
        webglVendor: "Google Inc. (Apple)",
        webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        brands: [{ brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }],
        uaPlatform: "macOS", uaMobile: false, platformVersion: "14.5.0",
        architecture: "arm", bitness: "64", uaFullVersion: "130.0.0.0",
      };
    }

    // HTTP-level UA is handled by context.route() in createProfile (not here).

    // Inject JS-level overrides via addInitScript (runs on every new page in this context)
    await context.addInitScript(`(() => {
      const cfg = ${JSON.stringify(fpConfig)};
      const seed = Math.random() * 10000;
      function noise(x) { const n = Math.sin(seed + x) * 10000; return n - Math.floor(n) - 0.5; }

      // Navigator overrides
      const navProps = {
        platform: cfg.platform, vendor: cfg.vendor, deviceMemory: cfg.deviceMemory,
        hardwareConcurrency: cfg.hardwareConcurrency, maxTouchPoints: cfg.maxTouchPoints,
        languages: cfg.languages, language: cfg.languages?.[0] || "en-ZA", webdriver: false,
      };
      if (cfg.userAgent) navProps.userAgent = cfg.userAgent;
      for (const [prop, value] of Object.entries(navProps)) {
        try { Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true }); } catch {}
      }

      // UserAgentData
      if (typeof NavigatorUAData !== "undefined" || navigator.userAgentData) {
        try {
          const uaObj = {
            brands: cfg.brands || [], mobile: cfg.uaMobile || false, platform: cfg.uaPlatform || "macOS",
            toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
            getHighEntropyValues: async (hints) => {
              const r = { brands: cfg.brands, mobile: cfg.uaMobile, platform: cfg.uaPlatform };
              for (const h of hints) {
                if (h==="platformVersion") r.platformVersion=cfg.platformVersion;
                if (h==="architecture") r.architecture=cfg.architecture;
                if (h==="bitness") r.bitness=cfg.bitness;
                if (h==="model") r.model="";
                if (h==="uaFullVersion") r.uaFullVersion=cfg.uaFullVersion;
                if (h==="fullVersionList") r.fullVersionList=(cfg.brands||[]).map(b=>({...b}));
              }
              return r;
            },
          };
          if (typeof NavigatorUAData !== "undefined") Object.setPrototypeOf(uaObj, NavigatorUAData.prototype);
          Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => uaObj, configurable: true });
        } catch {}
      }

      // Plugins
      try {
        const pluginData = [
          { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        ];
        const fakePlugins = pluginData.map(p => {
          const pl = Object.create(Plugin.prototype);
          Object.defineProperties(pl, { name:{get:()=>p.name}, filename:{get:()=>p.filename}, description:{get:()=>p.description}, length:{get:()=>2} });
          return pl;
        });
        const fakePA = Object.create(PluginArray.prototype);
        Object.defineProperty(fakePA, "length", { get: () => fakePlugins.length });
        fakePlugins.forEach((p,i) => { Object.defineProperty(fakePA, i, {get:()=>p, enumerable:true}); Object.defineProperty(fakePA, p.name, {get:()=>p}); });
        fakePA.item = i => fakePlugins[i]||null;
        fakePA.namedItem = n => fakePlugins.find(p=>p.name===n)||null;
        fakePA.refresh = ()=>{};
        fakePA[Symbol.iterator] = function*() { yield* fakePlugins; };
        Object.defineProperty(Navigator.prototype, "plugins", { get: () => fakePA, configurable: true });
      } catch {}

      // WebGL
      if (cfg.webglVendor && cfg.webglRenderer) {
        const origGC = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          const ctx = origGC.call(this, type, ...args);
          if (ctx && (type==="webgl"||type==="webgl2"||type==="experimental-webgl")) {
            const origGP = ctx.getParameter.bind(ctx);
            const origGE = ctx.getExtension.bind(ctx);
            ctx.getExtension = function(n) { if(n==="WEBGL_debug_renderer_info") return {UNMASKED_VENDOR_WEBGL:0x9245,UNMASKED_RENDERER_WEBGL:0x9246}; return origGE(n); };
            ctx.getParameter = function(p) { if(p===0x9245||p===0x1F00) return cfg.webglVendor; if(p===0x9246||p===0x1F01) return cfg.webglRenderer; try{return origGP(p)}catch{return null} };
          }
          return ctx;
        };
      }

      // Canvas noise
      const origTDU = HTMLCanvasElement.prototype.toDataURL;
      const origGID = CanvasRenderingContext2D.prototype.getImageData;
      function perturbCanvas(canvas) {
        try { const ctx=canvas.getContext("2d"); if(!ctx) return; const id=origGID.call(ctx,0,0,canvas.width,canvas.height); const d=id.data; let nz=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) nz++; if(nz<10) return; const s=Math.max(1,Math.floor(d.length/80)); for(let i=0;i<d.length;i+=s) if(i%4!==3&&d[i+(3-(i%4))]>0) d[i]=Math.max(0,Math.min(255,d[i]+noise(i)*2)); ctx.putImageData(id,0,0); } catch{}
      }
      HTMLCanvasElement.prototype.toDataURL = function(...a) { perturbCanvas(this); return origTDU.apply(this,a); };

      // Intl locale
      const fpLocale = cfg.languages?.[0] || "en-ZA";
      try {
        const OrigDTF = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function(l,o) { return new OrigDTF(l||fpLocale,o); };
        Intl.DateTimeFormat.prototype = OrigDTF.prototype;
        Intl.DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf;
        const OrigNF = Intl.NumberFormat;
        Intl.NumberFormat = function(l,o) { return new OrigNF(l||fpLocale,o); };
        Intl.NumberFormat.prototype = OrigNF.prototype;
        Intl.NumberFormat.supportedLocalesOf = OrigNF.supportedLocalesOf;
      } catch {}
    })();`);
  }

  async createProfile(name: string, url?: string): Promise<{ tabId: number; restored: boolean }> {
    await this.initialize();
    if (this.profiles.has(name)) {
      throw new Error(`Profile "${name}" already exists. Use delete_profile first.`);
    }
    // Extensions don't inject into non-default BrowserContexts, so
    // injectStealthIntoContext() handles all JS-level fingerprint overrides.

    // Connect directly to Chrome's debugger port for profiles.
    // Steel's session proxy (port 3000) doesn't forward CDP Emulation commands
    // to non-default BrowserContexts. Direct connection (port 9223) works.
    // Profiles use the same browser connection as Steel. HTTP User-Agent in
    // non-default contexts will show the real Chrome UA (HeadlessChrome) because
    // Steel's session proxy doesn't forward CDP Emulation commands to new contexts.
    // This is acceptable: most anti-bot detection happens client-side via JS,
    // where our addInitScript provides full fingerprint consistency.
    const context = await this.browser!.newContext({
      viewport: { width: env.DEFAULT_VIEWPORT_WIDTH, height: env.DEFAULT_VIEWPORT_HEIGHT },
    });

    // Inject stealth overrides (extensions don't work in non-default contexts)
    await this.injectStealthIntoContext(context);

    const page = await context.newPage();

    const tabId = this.allocateTab(page);
    this.currentTabId = tabId;

    const profile = { context, tabIds: new Set([tabId]) };
    this.profiles.set(name, profile);
    this.tabToProfile.set(tabId, name);

    // Restore saved state if it exists
    let restored = false;
    const savedPath = path.join(env.PROFILES_DIR, `${name}.json`);
    try {
      const raw = await fs.readFile(savedPath, "utf8");
      const state = JSON.parse(raw) as {
        cookies?: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" }>;
        localStorage?: Record<string, Record<string, string>>;
      };
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
        restored = true;
      }
      if (url && state.localStorage) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const origin = new URL(url).origin;
        const ls = state.localStorage[origin];
        if (ls) {
          await page.evaluate((entries: Record<string, string>) => {
            for (const [k, v] of Object.entries(entries)) {
              localStorage.setItem(k, v);
            }
          }, ls);
        }
        return { tabId, restored: true };
      }
    } catch {
      // No saved state — that's fine
    }

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return { tabId, restored };
  }

  /**
   * Save a profile's cookies + localStorage to disk as JSON.
   * localStorage is captured from all origins the profile has visited.
   */
  async saveProfile(name: string): Promise<string> {
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`Profile "${name}" is not active.`);

    const cookies = await profile.context.cookies();

    // Collect localStorage from all open pages in this profile
    const localStorage: Record<string, Record<string, string>> = {};
    for (const tabId of profile.tabIds) {
      const page = this.tabs.get(tabId);
      if (!page || page.isClosed()) continue;
      try {
        const origin = new URL(page.url()).origin;
        if (origin === "about:" || origin === "chrome:") continue;
        const ls = await page.evaluate(() => {
          const entries: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key) entries[key] = window.localStorage.getItem(key) ?? "";
          }
          return entries;
        });
        if (Object.keys(ls).length > 0) {
          localStorage[origin] = ls;
        }
      } catch {
        // Page might be on a special URL or crashed — skip
      }
    }

    const state = { cookies, localStorage, savedAt: new Date().toISOString() };
    const savedPath = path.join(env.PROFILES_DIR, `${name}.json`);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, JSON.stringify(state, null, 2));
    return savedPath;
  }

  /**
   * List all active profiles + any saved profiles on disk.
   */
  async listProfiles(): Promise<Array<{ name: string; active: boolean; tabCount: number; savedAt?: string }>> {
    const result: Array<{ name: string; active: boolean; tabCount: number; savedAt?: string }> = [];

    // Active profiles
    for (const [name, profile] of this.profiles) {
      const liveTabs = [...profile.tabIds].filter((id) => {
        const p = this.tabs.get(id);
        return p && !p.isClosed();
      });
      result.push({ name, active: true, tabCount: liveTabs.length });
    }

    // Saved profiles on disk (that aren't currently active)
    try {
      const dir = env.PROFILES_DIR;
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const name = f.replace(".json", "");
        if (this.profiles.has(name)) {
          // Already in the active list — add savedAt
          const existing = result.find((r) => r.name === name);
          if (existing) {
            try {
              const raw = await fs.readFile(path.join(dir, f), "utf8");
              const state = JSON.parse(raw);
              existing.savedAt = state.savedAt;
            } catch { /* */ }
          }
          continue;
        }
        let savedAt: string | undefined;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          const state = JSON.parse(raw);
          savedAt = state.savedAt;
        } catch { /* */ }
        result.push({ name, active: false, tabCount: 0, savedAt });
      }
    } catch {
      // profiles dir may not exist yet
    }

    return result;
  }

  /**
   * Delete a profile: close its context + all tabs, optionally remove saved state.
   */
  async deleteProfile(name: string, removeSaved = false): Promise<void> {
    const profile = this.profiles.get(name);
    if (profile) {
      // Close all tabs in this profile
      for (const tabId of profile.tabIds) {
        try {
          const page = this.tabs.get(tabId);
          if (page && !page.isClosed()) await page.close().catch(() => {});
          this.tabs.delete(tabId);
          this.tabOwners.delete(tabId);
          this.tabLastActivity.delete(tabId);
          this.tabToProfile.delete(tabId);
        } catch { /* */ }
      }
      // Close the context
      await profile.context.close().catch(() => {});
      this.profiles.delete(name);
    }

    if (removeSaved) {
      const savedPath = path.join(env.PROFILES_DIR, `${name}.json`);
      await fs.unlink(savedPath).catch(() => {});
    }
  }

  async stop() {
    if (this.steelClient && this.sessionId) {
      try {
        await this.steelClient.sessions.release(this.sessionId);
      } catch (err) {
        console.error(
          `Failed to release Steel session ${this.sessionId}:`,
          (err as Error).message
        );
      }
      this.sessionId = undefined;
    }

    // Close all profile contexts before closing the browser
    for (const [, profile] of this.profiles) {
      await profile.context.close().catch(() => {});
    }
    this.profiles.clear();
    this.tabToProfile.clear();

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
    }

    if (this.idleSweeperHandle) {
      clearInterval(this.idleSweeperHandle);
      this.idleSweeperHandle = undefined;
    }
    this.browserContext = undefined;
    this.tabs.clear();
    this.tabOwners.clear();
    this.tabLastActivity.clear();
    this.primaryTabId = undefined;
    this.nextTabId = 1;
    this.currentTabId = 1;
    this.consoleLogs = [];
    this.debugUrl = undefined;
    this.sessionViewerUrl = undefined;
    this.initialized = false;
  }
}

const mgr = new BrowserManager();

// -----------------------------------------------------------------------------
// Credentials store — simple file-based JSON store for site credentials.
// Credentials are stored in plain JSON (CREDENTIALS_FILE env).
// For homelab use only — not suitable for production without encryption.
// -----------------------------------------------------------------------------

type Credential = {
  name: string;
  url: string;           // URL pattern or domain to match
  username: string;
  password: string;
  extra?: Record<string, string>; // additional fields (e.g., OTP secret, security question)
  createdAt: string;
  updatedAt: string;
};

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, "steel-mcp-creds", 32);
}

function encryptJSON(data: unknown, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptJSON(blob: string, passphrase: string): unknown {
  const key = deriveKey(passphrase);
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

async function loadCredentials(): Promise<Credential[]> {
  try {
    const raw = await fs.readFile(env.CREDENTIALS_FILE, "utf8");
    if (env.CREDENTIALS_PASSPHRASE) {
      return decryptJSON(raw.trim(), env.CREDENTIALS_PASSPHRASE) as Credential[];
    }
    return JSON.parse(raw) as Credential[];
  } catch {
    return [];
  }
}

async function saveCredentials(creds: Credential[]): Promise<void> {
  await fs.mkdir(path.dirname(env.CREDENTIALS_FILE), { recursive: true });
  if (env.CREDENTIALS_PASSPHRASE) {
    await fs.writeFile(env.CREDENTIALS_FILE, encryptJSON(creds, env.CREDENTIALS_PASSPHRASE));
  } else {
    await fs.writeFile(env.CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function globalWait() {
  if (env.GLOBAL_WAIT_SECONDS > 0) {
    await sleep(env.GLOBAL_WAIT_SECONDS * 1000);
  }
}

async function writeToFile(
  data: Buffer | string,
  defaultName: string,
  outputPath?: string
): Promise<string> {
  const filePath = outputPath ?? path.join(env.OUTPUT_DIR, defaultName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return filePath;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

// list_tabs -------------------------------------------------------------------
server.tool(
  "list_tabs",
  "List all open browser tabs with their tab ID, URL, title, active state, and owner tag (if set via new_tab). Owners let concurrent agents clean up only their own tabs via close_tabs_by_owner.",
  {},
  async () => {
    try {
      const tabs = await mgr.listTabs();
      if (tabs.length === 0) {
        return { content: [{ type: "text", text: "No open tabs." }] };
      }
      const lines = tabs.map(
        (t) =>
          `[Tab ${t.tabId}]${t.active ? " *" : ""}${t.profile ? ` [${t.profile}]` : ""}${t.owner ? ` (owner=${t.owner})` : ""}  ${t.url}  —  ${t.title}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// new_tab ---------------------------------------------------------------------
server.tool(
  "new_tab",
  `Open a new browser tab and switch to it. Optionally navigate to a URL immediately. Returns the new tab ID.

Concurrent agents: pass an \`owner\` tag (e.g. your agent/session label) so you can clean up only your own tabs later via close_tabs_by_owner. Tabs idle for longer than TAB_IDLE_TIMEOUT_MS (default 5min) are auto-closed.`,
  {
    url: z.string().optional().describe("URL to navigate to immediately after opening. Optional — omit to open a blank tab."),
    owner: z.string().optional().describe("Optional ownership tag (e.g. 'agent:my-scraper-1'). Lets you clean up only your own tabs later via close_tabs_by_owner."),
    profile: z.string().optional().describe("Open the tab in this profile's isolated BrowserContext (shares its cookies/localStorage). Must be an active profile created via create_profile."),
  },
  async ({ url, owner, profile }) => {
    try {
      const { tabId, page } = await mgr.newTab(url, owner, profile);
      await globalWait();
      const finalUrl = page.url();
      const title = await page.title();
      const ownerSuffix = owner ? ` (owner=${owner})` : "";
      return {
        content: [
          {
            type: "text",
            text: `Opened Tab ${tabId}${ownerSuffix}${url ? `\nURL: ${finalUrl}\nTitle: ${title}` : " (blank)"}`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// close_tabs_by_owner ---------------------------------------------------------
server.tool(
  "close_tabs_by_owner",
  `Close all tabs owned by a given agent tag. Use this at end-of-task instead of stop_browser, so other agents sharing the browser keep their tabs. Returns the list of closed tab IDs.

If no tabs match the owner tag, returns an empty list silently (not an error).`,
  {
    owner: z.string().describe("The owner tag to match (set via new_tab's `owner` parameter)."),
  },
  async ({ owner }) => {
    try {
      const closed = await mgr.closeTabsByOwner(owner);
      const text =
        closed.length === 0
          ? `No tabs found with owner=${owner}.`
          : `Closed ${closed.length} tab(s) owned by ${owner}: ${closed.join(", ")}`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// (switch_tab removed in 0.5.0 — use `tabId` parameter on every tool instead.
// Mutating a global "active tab" is not safe under concurrent agent use.)

// close_tab -------------------------------------------------------------------
server.tool(
  "close_tab",
  "Close a browser tab by ID. Defaults to the currently active tab. Automatically switches to the next available tab.",
  {
    tabId: z.number().int().min(1).optional().describe("Tab ID to close. Defaults to the currently active tab."),
  },
  async ({ tabId }) => {
    try {
      const tabs = await mgr.listTabs();
      const id = tabId ?? tabs.find((t) => t.active)?.tabId;
      if (!id) return { isError: true, content: [{ type: "text", text: "No active tab to close." }] };
      await mgr.closeTab(id);
      const remaining = await mgr.listTabs();
      const nowActive = remaining.find((t) => t.active);
      const suffix = nowActive
        ? `\nNow on Tab ${nowActive.tabId}: ${nowActive.url}`
        : "\nNo tabs remaining.";
      return { content: [{ type: "text", text: `Closed Tab ${id}.${suffix}` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_current_url -------------------------------------------------------------
server.tool(
  "get_current_url",
  "Return the URL and title of a tab. Defaults to the current active tab; pass tabId to target a specific tab (required for concurrent agents).",
  {
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      const url = page.url();
      const title = await page.title();
      return {
        content: [{ type: "text", text: `URL: ${url}\nTitle: ${title}` }],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_screenshot --------------------------------------------------------------
server.tool(
  "get_screenshot",
  `Take a screenshot of the current page.

CONTEXT BUDGET — screenshots can be large. Use outputMode: 'file' when you will process or upload the image separately rather than reading it into context. Use 'inline' (default) when you need immediate visual inspection; will auto-downgrade to 'file' if the output exceeds maxInlineBytes.

Reduce size with: scale < 1.0, format: 'jpeg' + lower quality, fullPage: false, or clip to a region.`,
  {
    outputMode: z
      .enum(["inline", "file"])
      .default("inline")
      .optional()
      .describe(
        "How to return the screenshot. 'inline' returns base64 data (auto-downgrades to 'file' if too large). 'file' saves to disk and returns only the path."
      ),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/screenshot_{timestamp}.{format}."
      ),
    format: z
      .enum(["png", "jpeg", "webp"])
      .default("webp")
      .optional()
      .describe(
        "Image format. 'webp' (default) = smallest files, requires Chromium ≥ 88 (uses CDP directly). 'jpeg' = smaller than PNG, widely supported. 'png' = lossless, largest."
      ),
    quality: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Quality 1–100. Used for 'jpeg' and 'webp'. Default: DEFAULT_SCREENSHOT_QUALITY env var (80). Ignored for 'png'."
      ),
    fullPage: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Capture full scrollable page (true) or visible viewport only (false). Default: false."
      ),
    scale: z
      .number()
      .min(0.1)
      .max(3.0)
      .default(1.0)
      .optional()
      .describe(
        "Viewport scale factor applied before capture. Use 0.5 to halve dimensions and file size. Range: 0.1–3.0. Default: 1.0."
      ),
    clip: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Capture only a rectangular region of the page. Optional. Mutually exclusive with `selector`."),
    selector: z
      .string()
      .optional()
      .describe(
        "CSS selector for a single element to screenshot. If set, captures just that element's bounding box — tighter output than fullPage + clip math. Mutually exclusive with `clip`."
      ),
    maxInlineBytes: z
      .number()
      .optional()
      .describe(
        "Max bytes before auto-switching to file mode. Default: MAX_INLINE_BYTES env var (512000). Set lower to protect context budget."
      ),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({
    outputMode = "inline",
    outputPath,
    format = "webp",
    quality,
    fullPage = false,
    scale = 1.0,
    clip,
    selector,
    maxInlineBytes,
    tabId,
  }) => {
    try {
      if (clip && selector) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pass either `clip` or `selector`, not both." }],
        };
      }
      if (clip) {
        // Validate clip dimensions up front — CDP returns a cryptic
        // "Protocol error (Page.captureScreenshot): Unable to capture
        // screenshot" for negative coords, zero/negative width or height,
        // and oversized regions (>16384 in any dimension per Chromium limit).
        const MAX_DIM = 16384;
        const issues: string[] = [];
        if (clip.width <= 0 || clip.height <= 0) {
          issues.push(`width/height must be > 0 (got ${clip.width}×${clip.height})`);
        }
        if (clip.width > MAX_DIM || clip.height > MAX_DIM) {
          issues.push(`width/height must be ≤ ${MAX_DIM} (got ${clip.width}×${clip.height})`);
        }
        if (clip.x < 0 || clip.y < 0) {
          issues.push(`x/y must be ≥ 0 (got ${clip.x},${clip.y})`);
        }
        if (issues.length > 0) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid clip region: ${issues.join("; ")}` }],
          };
        }
      }
      const page = await mgr.getPage(tabId);
      const effectiveQuality = quality ?? env.DEFAULT_SCREENSHOT_QUALITY;
      const effectiveMaxInlineBytes = maxInlineBytes ?? env.MAX_INLINE_BYTES;

      const origVp = page.viewportSize() ?? {
        width: env.DEFAULT_VIEWPORT_WIDTH,
        height: env.DEFAULT_VIEWPORT_HEIGHT,
      };

      let buffer: Buffer;
      try {
        if (scale !== 1.0) {
          await page.setViewportSize({
            width: Math.round(origVp.width * scale),
            height: Math.round(origVp.height * scale),
          });
        }
        if (format === "webp") {
          // Playwright screenshot API doesn't expose webp; go through CDP.
          const client = await page.context().newCDPSession(page);
          const cdpArgs: {
            format: string;
            quality: number;
            captureBeyondViewport?: boolean;
            clip?: { x: number; y: number; width: number; height: number; scale: number };
          } = { format: "webp", quality: effectiveQuality };
          if (fullPage) cdpArgs.captureBeyondViewport = true;
          if (selector) {
            const locator = page.locator(selector).first();
            const count = await locator.count();
            if (count === 0) {
              return {
                isError: true,
                content: [{ type: "text", text: `selector "${selector}" matched no elements.` }],
              };
            }
            const box = await locator.boundingBox();
            if (!box) {
              return {
                isError: true,
                content: [{ type: "text", text: `selector "${selector}" has no layout box (display:none?).` }],
              };
            }
            cdpArgs.clip = { ...box, scale: 1 };
          } else if (clip) {
            cdpArgs.clip = { ...clip, scale: 1 };
          }
          const { data } = await client.send("Page.captureScreenshot", cdpArgs);
          buffer = Buffer.from(data, "base64");
          await client.detach().catch(() => {});
        } else if (selector) {
          const locator = page.locator(selector).first();
          const count = await locator.count();
          if (count === 0) {
            return {
              isError: true,
              content: [{ type: "text", text: `selector "${selector}" matched no elements.` }],
            };
          }
          const elOpts: Parameters<typeof locator.screenshot>[0] = { type: format };
          if (format === "jpeg") elOpts.quality = effectiveQuality;
          buffer = await locator.screenshot(elOpts);
        } else {
          const opts: Parameters<typeof page.screenshot>[0] = { type: format, fullPage };
          if (format === "jpeg") opts.quality = effectiveQuality;
          if (clip) opts.clip = clip;
          buffer = await page.screenshot(opts);
        }
      } finally {
        if (scale !== 1.0) {
          await page.setViewportSize(origVp).catch(() => {});
        }
      }

      const effectiveMode =
        outputMode === "inline" && buffer.length > effectiveMaxInlineBytes
          ? "file"
          : outputMode;

      if (effectiveMode === "file") {
        const defaultName = `screenshot_${Date.now()}.${format}`;
        const filePath = await writeToFile(buffer, defaultName, outputPath);
        const autoNote =
          outputMode === "inline"
            ? `\n(Auto-switched to file mode: output exceeded ${effectiveMaxInlineBytes.toLocaleString()} bytes)`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Screenshot saved to: ${filePath}\nSize: ${buffer.length.toLocaleString()} bytes${autoNote}`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: "Screenshot taken." },
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: `image/${format}`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_page_text ---------------------------------------------------------------
server.tool(
  "get_page_text",
  `Get visible text content from the current page.

Single match (default): selector picks FIRST element, returns one text blob.
Multi match (matchAll: true): selector picks ALL elements (querySelectorAll), returns JSON array with per-element text + link data. Ideal for scraping list pages (article cards, product tiles, search results) — one call replaces N evaluate calls.

CONTEXT BUDGET — page text can be very large. Use maxChars to cap per-entry text, maxEntries to cap array length, outputMode: 'file' to save full output to disk without loading into context. Use a specific CSS selector; avoid dumping document.body.`,
  {
    selector: z
      .string()
      .optional()
      .describe(
        "CSS selector to scope extraction (e.g. 'article', 'main', '#content'). Defaults to document.body."
      ),
    maxChars: z
      .number()
      .default(10000)
      .optional()
      .describe(
        "Maximum characters to return inline. Default: 10000. Set to 0 for no limit (use with outputMode: 'file')."
      ),
    outputMode: z
      .enum(["inline", "file"])
      .default("inline")
      .optional()
      .describe(
        "Return text inline (default) or save to file and return path."
      ),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/page_text_{timestamp}.txt."
      ),
    includeLinks: z
      .boolean()
      .default(false)
      .optional()
      .describe("Append link URLs in brackets after each anchor's text. Default: false."),
    matchAll: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "If true, return a JSON array with one entry per element matching selector (querySelectorAll). Each entry: {text, title?, primaryLink?, links?}. title = text of anchor whose href matches primaryLink (use as headline). primaryLink picks the first link whose URL path depth >= 2 (skips nav/category). links = deduped [{text, href}] when includeLinks=true. maxChars applied per-entry. Designed for list-page scraping (article cards, product tiles, search results) in a single call. Default: false (returns single first match as string)."
      ),
    maxEntries: z
      .number()
      .default(20)
      .optional()
      .describe(
        "When matchAll=true, cap on number of entries returned. Default: 20. Set to 0 for no cap."
      ),
    pretty: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "When matchAll=true, pretty-print the inline JSON (2-space indent). Default: false (compact — one entry per line)."
      ),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({
    selector,
    maxChars = 10000,
    outputMode = "inline",
    outputPath,
    includeLinks = false,
    matchAll = false,
    maxEntries = 20,
    pretty = false,
    tabId,
  }) => {
    try {
      const page = await mgr.getPage(tabId);

      // --- matchAll: per-element structured output -----------------------
      if (matchAll) {
        // Evaluate returns raw per-element {text, rawLinks}. Dedup + primary
        // link + title + per-entry maxChars are all pure Node work — lives
        // in src/helpers.ts so it's unit-testable without a browser.
        const rawEntries = await page.evaluate(
          ({ sel, withLinks }: { sel: string | null; withLinks: boolean }) => {
            const roots = sel
              ? Array.from(document.querySelectorAll(sel))
              : [document.body];
            const collect = (root: Element) => {
              const rawLinks: Array<{ text: string; href: string }> = [];
              const blockTags = new Set(["P","DIV","LI","H1","H2","H3","H4","H5","H6","TR","BLOCKQUOTE","PRE","SECTION","ARTICLE","HEADER","FOOTER","NAV","ASIDE","MAIN","DETAILS","SUMMARY","FIGCAPTION","DT","DD"]);
              const walk = (node: Element): string => {
                if (node.tagName === "BR") return "\n";
                if (node.tagName === "A") {
                  const href = (node as HTMLAnchorElement).href;
                  const txt = (node.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim();
                  if (withLinks && href) rawLinks.push({ text: txt, href });
                  return txt;
                }
                const inner = Array.from(node.childNodes)
                  .map((n) =>
                    n.nodeType === 3
                      ? n.textContent ?? ""
                      : walk(n as Element)
                  )
                  .join("");
                return blockTags.has(node.tagName) ? "\n" + inner + "\n" : inner;
              };
              const text = walk(root).replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
              return { text, rawLinks };
            };
            return roots.map(collect);
          },
          { sel: selector ?? null, withLinks: includeLinks }
        );

        type MatchEntry = {
          text: string;
          title?: string;
          primaryLink?: string;
          links?: Link[];
        };
        const entries: MatchEntry[] = rawEntries.map((r) => {
          const entry: MatchEntry = { text: capText(r.text, maxChars) };
          if (includeLinks) {
            const links = dedupeLinks(r.rawLinks);
            entry.links = links;
            const primary = pickPrimaryLink(links);
            if (primary) {
              entry.primaryLink = primary;
              const title = findTitle(primary, links);
              if (title) entry.title = title;
            }
          }
          return entry;
        });

        const totalMatched = entries.length;
        const capped =
          maxEntries > 0 && entries.length > maxEntries
            ? entries.slice(0, maxEntries)
            : entries;

        if (outputMode === "file") {
          // File output: pretty-print for human inspection when saved to disk.
          const json = JSON.stringify(capped, null, 2);
          const filePath = await writeToFile(
            Buffer.from(json, "utf8"),
            `page_sections_${Date.now()}.json`,
            outputPath
          );
          return {
            content: [
              {
                type: "text",
                text: `Page sections saved to: ${filePath}\nMatched: ${totalMatched}\nReturned: ${capped.length}`,
              },
            ],
          };
        }

        // Inline output: compact (one-entry-per-line) by default to avoid \n
        // pollution in tool response wrappers. `pretty: true` uses 2-space indent.
        // Empty → clean `[]` instead of `[\n\n]` (was a formatting bug).
        const truncated = capped.length < totalMatched;
        const body =
          capped.length === 0
            ? `[]${selector ? `\n(selector "${selector}" matched no elements)` : ""}`
            : pretty
              ? JSON.stringify(capped, null, 2)
              : "[\n" + capped.map((e) => JSON.stringify(e)).join(",\n") + "\n]";
        return {
          content: [
            {
              type: "text",
              text:
                body +
                (truncated
                  ? `\n[CAPPED — ${totalMatched} total sections matched, returning first ${capped.length}. Raise maxEntries or use outputMode: "file" for full list.]`
                  : ""),
            },
          ],
        };
      }

      // --- single-match path (original behavior) ------------------------
      // Returns a sentinel {__noMatch:true} when a selector is supplied but
      // doesn't match anything, so the caller can produce an explicit
      // "no match" message instead of a bare empty string that mcporter
      // formats as the raw tool response object.
      type SingleResult = { __noMatch?: true; text?: string };
      const rawResult: SingleResult = includeLinks
        ? await page.evaluate((sel: string | null) => {
            const root = sel ? document.querySelector(sel) : document.body;
            if (!root) return sel ? { __noMatch: true } : { text: "" };
            const blockTags = new Set(["P","DIV","LI","H1","H2","H3","H4","H5","H6","TR","BLOCKQUOTE","PRE","SECTION","ARTICLE","HEADER","FOOTER","NAV","ASIDE","MAIN","DETAILS","SUMMARY","FIGCAPTION","DT","DD"]);
            const walk = (node: Element): string => {
              if (node.tagName === "BR") return "\n";
              if (node.tagName === "A") {
                const href = (node as HTMLAnchorElement).href;
                return `${node.textContent?.trim()} [${href}]`;
              }
              const inner = Array.from(node.childNodes)
                .map((n) => (n.nodeType === 3 ? n.textContent ?? "" : walk(n as Element)))
                .join("");
              return blockTags.has(node.tagName) ? "\n" + inner + "\n" : inner;
            };
            return { text: walk(root as Element) };
          }, selector ?? null)
        : await page.evaluate((sel: string | null) => {
            const root = sel ? document.querySelector(sel) : document.body;
            if (!root) return sel ? { __noMatch: true } : { text: "" };
            return { text: (root as HTMLElement)?.innerText ?? "" };
          }, selector ?? null);

      if (rawResult.__noMatch) {
        return {
          content: [
            {
              type: "text",
              text: `(selector "${selector}" matched no elements)`,
            },
          ],
        };
      }
      // Collapse horizontal whitespace (spaces/tabs) but preserve newlines.
      // Then collapse 3+ consecutive newlines into double newline.
      let text: string = (rawResult.text ?? "")
        .replace(/[^\S\n]+/g, " ")       // collapse spaces/tabs (not \n)
        .replace(/\n{3,}/g, "\n\n")       // 3+ newlines → 2
        .trim();

      if (outputMode === "file") {
        const filePath = await writeToFile(
          Buffer.from(text, "utf8"),
          `page_text_${Date.now()}.txt`,
          outputPath
        );
        return {
          content: [
            {
              type: "text",
              text: `Page text saved to: ${filePath}\nTotal chars: ${text.length.toLocaleString()}`,
            },
          ],
        };
      }

      const truncated = maxChars > 0 && text.length > maxChars;
      const output = truncated ? text.slice(0, maxChars) : text;
      return {
        content: [
          {
            type: "text",
            text:
              output +
              (truncated
                ? `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 with outputMode: "file" to get full content.]`
                : ""),
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_links ------------------------------------------------------------------
server.tool(
  "get_links",
  `Extract anchor URLs from the current page.

Simpler than get_page_text(matchAll) when you only need URLs — no per-element text tree walking. Returns a JSON array of {text, href} objects. Deduped by href (fragment stripped). Optional urlPattern filters to regex-matching hrefs only.

Use cases: scraping article list URLs, link indexes, sitemap-like extraction.`,
  {
    selector: z
      .string()
      .optional()
      .describe(
        "CSS scope for anchor search (e.g. 'main', 'article', '#results'). Defaults to document.body."
      ),
    urlPattern: z
      .string()
      .optional()
      .describe(
        "Optional JS regex pattern (without slashes) to filter hrefs. Case-insensitive. Examples: '/articles/[a-z-]+-\\\\d{8}', 'example\\\\.com/.+/\\\\d{4}/\\\\d{2}/'."
      ),
    limit: z
      .number()
      .default(50)
      .optional()
      .describe("Max results. Default: 50. Set 0 for no cap."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, urlPattern, limit = 50, tabId }) => {
    try {
      // Validate the regex up front so we return a clean user-facing error
      // (`Invalid regular expression: …`) instead of letting it throw from
      // inside page.evaluate with a noisy JS call stack.
      if (urlPattern) {
        try {
          new RegExp(urlPattern, "i");
        } catch (reErr) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `urlPattern is not a valid regex: ${(reErr as Error).message}`,
              },
            ],
          };
        }
      }
      const page = await mgr.getPage(tabId);
      // Evaluate returns raw anchor list (possibly with dupes). Node-side
      // dedup via shared helper — testable, matches matchAll semantics.
      const rawLinks = await page.evaluate(
        ({ sel, pat }: { sel: string | null; pat: string | null }) => {
          // When selector set, scope to querySelectorAll — any element matching
          // the selector contributes its descendant anchors. This mirrors the
          // expected "scope by list item" semantics used elsewhere in the MCP.
          const roots: Element[] = sel
            ? Array.from(document.querySelectorAll(sel))
            : [document.body];
          if (roots.length === 0) return [];
          const re = pat ? new RegExp(pat, "i") : null;
          const out: Array<{ text: string; href: string }> = [];
          for (const root of roots) {
            const anchors = Array.from(root.querySelectorAll("a[href]"));
            for (const a of anchors) {
              const href = (a as HTMLAnchorElement).href;
              if (!href) continue;
              if (re && !re.test(href)) continue;
              const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
              out.push({ text, href });
            }
          }
          return out;
        },
        { sel: selector ?? null, pat: urlPattern ?? null }
      );

      const links: Link[] = dedupeLinks(rawLinks);
      const capped = limit > 0 ? links.slice(0, limit) : links;
      const truncated = capped.length < links.length;
      // Empty → clean `[]` + note instead of `[\n\n]` malformed array.
      const body =
        capped.length === 0
          ? `[]${selector ? `\n(no anchors found in elements matching "${selector}"${urlPattern ? ` for pattern /${urlPattern}/i` : ""})` : urlPattern ? `\n(no anchors matched pattern /${urlPattern}/i)` : ""}`
          : "[\n" + capped.map((l) => JSON.stringify(l)).join(",\n") + "\n]";
      return {
        content: [
          {
            type: "text",
            text:
              body +
              (truncated
                ? `\n[CAPPED — ${links.length} total links matched, returning first ${capped.length}. Raise limit.]`
                : ""),
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_attrs -------------------------------------------------------------------
server.tool(
  "get_attrs",
  `Extract specific attributes from elements matching a CSS selector.

Returns a JSON array of objects — one per matched element — containing only the attributes you asked for. Special values: "text" returns the element's innerText (preserves whitespace between block-level children, same as what users see), "html" returns outerHTML.

Use when matchAll + links aren't enough — e.g. scraping data-id, data-price, aria-label, src, alt, or structured data from custom markup.`,
  {
    selector: z
      .string()
      .describe(
        "CSS selector for elements to extract from (e.g. 'article', '.product-card')."
      ),
    attrs: z
      .array(z.string())
      .describe(
        "Attribute names to extract. Special: 'text' = innerText (visible text with proper whitespace), 'html' = outerHTML. Examples: ['href', 'data-id'], ['src', 'alt', 'text']."
      ),
    limit: z
      .number()
      .default(50)
      .optional()
      .describe("Max elements to return. Default: 50. 0 = no cap."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, attrs, limit = 50, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      const results = await page.evaluate(
        ({ sel, attrNames }: { sel: string; attrNames: string[] }) => {
          const nodes = Array.from(document.querySelectorAll(sel));
          return nodes.map((el) => {
            const out: Record<string, string | null> = {};
            for (const name of attrNames) {
              if (name === "text") {
                // Use innerText (layout-aware, inserts whitespace between
                // block-level children) then collapse runs. textContent drops
                // all visual whitespace → "Header1h agoTitle" style jams.
                const raw =
                  (el as HTMLElement).innerText ?? el.textContent ?? "";
                out[name] = raw.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
              } else if (name === "html") {
                out[name] = (el as HTMLElement).outerHTML ?? null;
              } else {
                out[name] = (el as Element).getAttribute(name);
              }
            }
            return out;
          });
        },
        { sel: selector, attrNames: attrs }
      );

      const capped = limit > 0 ? results.slice(0, limit) : results;
      const truncated = capped.length < results.length;
      const body =
        capped.length === 0
          ? `[]\n(selector "${selector}" matched no elements)`
          : "[\n" + capped.map((r) => JSON.stringify(r)).join(",\n") + "\n]";
      return {
        content: [
          {
            type: "text",
            text:
              body +
              (truncated
                ? `\n[CAPPED — ${results.length} total matches, returning first ${capped.length}. Raise limit.]`
                : ""),
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// click -----------------------------------------------------------------------
server.tool(
  "click",
  `Click an element on the page identified by a CSS selector.

Use this for buttons, links, checkboxes, or any clickable element. If the selector matches multiple elements, the first visible one is clicked.

After clicking, use wait_for to confirm the expected result before proceeding.`,
  {
    selector: z
      .string()
      .describe("CSS selector of the element to click (e.g. 'button[type=submit]', '#login', 'a.nav-link')."),
    timeout: z
      .number()
      .min(100)
      .max(30000)
      .default(10000)
      .optional()
      .describe("Max time in ms to wait for the element to be clickable. Default: 10000."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, timeout = 10000, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      await page.click(selector, { timeout });
      await globalWait();
      return { content: [{ type: "text", text: `Clicked: ${selector}` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// type ------------------------------------------------------------------------
server.tool(
  "type",
  `Type text into an input field, textarea, or other editable element.

Use clear: true to replace existing content (recommended for form fields). Use submit: true to press Enter after typing (useful for search boxes).

After typing, use wait_for to confirm the expected result or get_screenshot to verify the input.`,
  {
    selector: z
      .string()
      .describe("CSS selector of the input element (e.g. 'input[name=q]', '#email', 'textarea')."),
    text: z
      .string()
      .describe("Text to type into the element."),
    clear: z
      .boolean()
      .default(true)
      .optional()
      .describe("Replace any existing content before typing. Default: true."),
    submit: z
      .boolean()
      .default(false)
      .optional()
      .describe("Press Enter after typing (e.g. to submit a search form). Default: false."),
    timeout: z
      .number()
      .min(100)
      .max(30000)
      .default(10000)
      .optional()
      .describe("Max time in ms to wait for the element. Default: 10000."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, text, clear = true, submit = false, timeout = 10000, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      if (clear) {
        // fill() replaces content atomically — preferred over triple-click + type.
        await page.fill(selector, text, { timeout });
      } else {
        await page.type(selector, text, { timeout });
      }
      if (submit) {
        await page.press(selector, "Enter");
      }
      await globalWait();
      const action = clear ? "Filled" : "Typed into";
      const suffix = submit ? " and pressed Enter" : "";
      return {
        content: [{ type: "text", text: `${action} ${selector}${suffix}.` }],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// select ----------------------------------------------------------------------
server.tool(
  "select",
  "Select an option from a <select> dropdown element by its value, label, or index.",
  {
    selector: z
      .string()
      .describe("CSS selector of the <select> element (e.g. 'select[name=country]', '#sort-by')."),
    value: z
      .string()
      .optional()
      .describe("The option value attribute to select (e.g. 'us', 'price-asc')."),
    label: z
      .string()
      .optional()
      .describe("The visible option text to select (e.g. 'United States', 'Price: Low to High')."),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Zero-based index of the option to select."),
    timeout: z
      .number()
      .min(100)
      .max(30000)
      .default(10000)
      .optional()
      .describe("Max time in ms to wait for the element. Default: 10000."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, value, label, index, timeout = 10000, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);

      if (value === undefined && label === undefined && index === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: "At least one of 'value', 'label', or 'index' must be provided." }],
        };
      }

      let selectArg: string | { value: string } | { label: string } | { index: number };
      if (value !== undefined) {
        selectArg = { value };
      } else if (label !== undefined) {
        selectArg = { label };
      } else {
        selectArg = { index: index! };
      }

      const selected = await page.selectOption(selector, selectArg, { timeout });
      await globalWait();
      return {
        content: [{ type: "text", text: `Selected option(s): ${selected.join(", ")} in ${selector}` }],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// fill_form -------------------------------------------------------------------
server.tool(
  "fill_form",
  `Fill multiple form fields in one call. Replaces N separate tool calls for sign-in, sign-up, checkout, and search forms.

Auto-detects field type and dispatches correctly:
- \`<input type=text/email/tel/password/search/url/number/hidden>\` / \`<textarea>\` → page.fill
- \`<input type=checkbox>\` — three value shapes:
    - truthy token ("true"/"1"/"on"/"yes"/"checked"/"y") → page.check
    - falsy token ("false"/"0"/"off"/"no"/"unchecked"/"n"/"") → page.uncheck
    - other → targets the checkbox whose \`value\` attribute matches that string (same shape as radio); useful for groups like \`{selector: "input[name=topping]", value: "cheese"}\`
- \`<input type=radio>\` → click the radio whose \`value\` attribute matches the given value (selector + value disambiguation)
- \`<select>\` → page.selectOption (value by default; override per-field with \`kind: "selectLabel"\` or \`kind: "selectIndex"\`)
- \`<input type=date/time/datetime-local/month/week>\` → page.fill (ISO format, e.g. "2026-04-18")

Per-field \`kind\` override forces a specific dispatch if auto-detect is wrong.

Processes fields sequentially; fails fast on the first missing selector unless \`skipMissing\` is set. Pass \`submitSelector\` to click a submit button after all fields are filled.`,
  {
    fields: z
      .array(
        z.object({
          selector: z.string().describe("CSS selector. For radios: match the group (e.g. 'input[name=size]') — value param picks which option."),
          value: z.string().describe("Value to set. For radios/selects: the option value. For checkboxes: truthy/falsy string."),
          submit: z.boolean().optional().describe("Press Enter after this field. Default: false."),
          kind: z
            .enum(["text", "check", "radio", "select", "selectLabel", "selectIndex"])
            .optional()
            .describe("Force a specific dispatch. Omit for auto-detect."),
        })
      )
      .min(1)
      .describe("Ordered list of fields to fill."),
    submitSelector: z
      .string()
      .optional()
      .describe("CSS selector of a submit button to click after all fields are filled. Optional."),
    skipMissing: z
      .boolean()
      .default(false)
      .optional()
      .describe("If true, fields whose selector doesn't match are silently skipped. Default: false (first miss = isError)."),
    timeout: z
      .number()
      .min(100)
      .max(30000)
      .default(10000)
      .optional()
      .describe("Per-field wait timeout in ms. Default: 10000."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ fields, submitSelector, skipMissing = false, timeout = 10000, tabId }) => {
    const detectKind = async (
      page: Page,
      selector: string
    ): Promise<"text" | "check" | "radio" | "select"> => {
      const info = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const tag = el.tagName;
        const type = (el as HTMLInputElement).type ?? "";
        return { tag, type };
      }, selector);
      if (!info) return "text";
      return detectFieldKind(info.tag, info.type);
    };

    try {
      const page = await mgr.getPage(tabId);
      const filled: Array<{ selector: string; kind: string }> = [];
      const skipped: string[] = [];

      for (const f of fields) {
        try {
          const kind = f.kind ?? (await detectKind(page, f.selector));
          if (kind === "select" || kind === "selectLabel" || kind === "selectIndex") {
            if (kind === "selectLabel") {
              await page.selectOption(f.selector, { label: f.value }, { timeout });
            } else if (kind === "selectIndex") {
              const idx = parseInt(f.value, 10);
              if (Number.isNaN(idx)) throw new Error(`selectIndex expects numeric value, got "${f.value}"`);
              await page.selectOption(f.selector, { index: idx }, { timeout });
            } else {
              await page.selectOption(f.selector, f.value, { timeout });
            }
            filled.push({ selector: f.selector, kind });
          } else if (kind === "check") {
            const intent = interpretCheckboxValue(f.value);
            if (intent === "check") {
              await page.check(f.selector, { timeout });
              filled.push({ selector: f.selector, kind });
            } else if (intent === "uncheck") {
              await page.uncheck(f.selector, { timeout });
              filled.push({ selector: f.selector, kind });
            } else {
              // selectByValue — value is neither truthy nor falsy token, so
              // treat like radio and target the checkbox whose value attr matches.
              // Mirrors user intuition for checkbox groups like
              // `{selector: "input[name=topping]", value: "cheese"}`.
              const fullSel = buildRadioSelector(f.selector, f.value);
              await page.check(fullSel, { timeout });
              filled.push({ selector: fullSel, kind: "check-by-value" });
            }
          } else if (kind === "radio") {
            const fullSel = buildRadioSelector(f.selector, f.value);
            await page.click(fullSel, { timeout });
            filled.push({ selector: fullSel, kind });
          } else {
            // text / date / time / textarea / password / email / etc. — page.fill handles all
            await page.fill(f.selector, f.value, { timeout });
            filled.push({ selector: f.selector, kind });
          }
          if (f.submit) await page.press(f.selector, "Enter");
        } catch (err) {
          if (skipMissing) {
            skipped.push(f.selector);
            continue;
          }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed on field "${f.selector}": ${(err as Error).message}\nFilled before failure: ${filled.map((x) => x.selector).join(", ") || "(none)"}`,
              },
            ],
          };
        }
      }
      if (submitSelector) {
        await page.click(submitSelector, { timeout });
      }
      await globalWait();
      const lines = [`Filled ${filled.length}/${fields.length} field(s).`];
      if (filled.length) {
        const byKind = filled.map((x) => `${x.selector} [${x.kind}]`).join(", ");
        lines.push(`  ok: ${byKind}`);
      }
      if (skipped.length) lines.push(`  skipped: ${skipped.join(", ")}`);
      if (submitSelector) lines.push(`Clicked submit: ${submitSelector}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// get_cookies -----------------------------------------------------------------
server.tool(
  "get_cookies",
  `Return browser cookies for the shared context. Filter by URL(s) or domain(s).

Use for debugging auth flows or persisting a session to re-inject later via \`set_cookies\`.

CONTEXT BUDGET — shared browser contexts can hold hundreds of cookies across many sites. Unfiltered calls are capped by \`limit\` (default 50). Prefer \`domain\` for site-scoped queries — simpler and more reliable than \`urls\` which must exactly match host + path + scheme.`,
  {
    urls: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of full URLs to filter by (Playwright-style match: host + path + scheme). If Playwright's exact-match returns nothing, falls back to host-contains match."
      ),
    domain: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Optional domain substring(s) to filter by (e.g. 'github.com' matches '.github.com' + 'www.github.com'). Preferred over `urls` for site-scoped queries."
      ),
    limit: z
      .number()
      .optional()
      .describe("Max cookies returned. Default 50. Set 0 for no cap."),
  },
  async ({ urls, domain, limit }) => {
    try {
      await mgr.initialize();
      const cap = limit === undefined ? 50 : limit;
      let cookies = await mgr.browserContext!.cookies(urls);

      // Fallback: if urls filter returned nothing, some sites store cookies
      // with domain shapes Playwright's matcher rejects (trailing dot, case).
      // Retry with full-context scan + host-contains match.
      if (urls && urls.length > 0 && cookies.length === 0) {
        const all = await mgr.browserContext!.cookies();
        const hosts = urls
          .map((u) => {
            try {
              return new URL(u).hostname;
            } catch {
              return u;
            }
          })
          .filter(Boolean);
        cookies = all.filter((c) =>
          hosts.some((h) => matchesCookieHost(c.domain, h))
        );
      }

      // Domain filter (substring match — handles leading-dot + subdomain quirks)
      if (domain) {
        const domains = (Array.isArray(domain) ? domain : [domain]).map((d) => d.toLowerCase());
        cookies = cookies.filter((c) => {
          const cd = (c.domain || "").toLowerCase();
          return domains.some((d) => cd.includes(d));
        });
      }

      const total = cookies.length;
      const truncated = cap > 0 && total > cap;
      if (truncated) {
        cookies = cookies.slice(0, cap);
      }

      if (total === 0) {
        const hint = urls
          ? " (no match for urls; try the `domain` param instead)"
          : domain
            ? " (no match for domain)"
            : "";
        return {
          content: [{ type: "text", text: `No cookies in the browser context.${hint}` }],
        };
      }

      const body = JSON.stringify(cookies, null, 2);
      const footer = truncated
        ? `\n\n[CAPPED — ${total} total cookies in context, returning first ${cap}. Set limit=0 or use domain/urls filter for full list.]`
        : "";

      return {
        content: [{ type: "text", text: body + footer }],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// set_cookies -----------------------------------------------------------------
server.tool(
  "set_cookies",
  `Inject cookies into the shared browser context. Each cookie must have \`name\` + \`value\` and either \`url\` or (\`domain\` + \`path\`).

Use to restore a logged-in session from a saved dump without running the login flow in-browser.`,
  {
    cookies: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            url: z.string().optional(),
            domain: z.string().optional(),
            path: z.string().optional(),
            expires: z.number().optional().describe("Unix epoch seconds. Omit for a session cookie."),
            httpOnly: z.boolean().optional(),
            secure: z.boolean().optional(),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          })
          .passthrough()
      )
      .min(1)
      .describe("Array of Playwright-shaped cookie objects."),
  },
  async ({ cookies }) => {
    try {
      await mgr.initialize();
      await mgr.browserContext!.addCookies(cookies as Parameters<BrowserContext["addCookies"]>[0]);
      return {
        content: [{ type: "text", text: `Set ${cookies.length} cookie(s) on the shared browser context.` }],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// download_file ---------------------------------------------------------------
server.tool(
  "download_file",
  `Fetch a URL and save its body to disk. Handles two delivery shapes:

1) **Attachment downloads** — URLs that serve \`Content-Disposition: attachment\`
   (or a MIME that Chromium saves by default). Uses Playwright's
   \`waitForEvent('download')\` — works even when \`page.goto\` raises \`ERR_ABORTED\`.
2) **Inline binaries** — URLs that serve \`application/octet-stream\`, PDFs, CSVs,
   or API-served bytes WITHOUT a Content-Disposition header. Chromium views
   these inline, so no download event fires. When the download event times out,
   this tool falls back to \`context.request.fetch(url)\` — reuses the browser
   session's cookies/auth headers — and writes the body directly to disk.

Output path defaults to \`OUTPUT_DIR/<suggestedFilename>\`. Pass \`outputPath\` to override.`,
  {
    url: z.string().describe("The download URL to fetch."),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute path to save the download under. Defaults to OUTPUT_DIR/<suggestedFilename>."),
    timeout: z
      .number()
      .min(1000)
      .max(120000)
      .default(30000)
      .optional()
      .describe("Timeout in ms for the download event (before falling back to fetch). Default: 30000."),
    forceFetch: z
      .boolean()
      .default(false)
      .optional()
      .describe("Skip the download-event path and go straight to context.request.fetch. Useful when you know the URL has no Content-Disposition."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ url, outputPath, timeout = 30000, forceFetch = false, tabId }) => {
    const saveViaFetch = async (via: string): Promise<string> => {
      const resp = await mgr.browserContext!.request.fetch(url, { timeout: timeout + 5000 });
      if (!resp.ok()) {
        throw new Error(`fetch fallback HTTP ${resp.status()} ${resp.statusText()}`);
      }
      const body = await resp.body();
      let suggested = deriveDownloadFilename(url);
      if (!path.extname(suggested)) {
        const ext = mimeToExt(resp.headers()["content-type"] ?? null);
        if (ext) suggested += ext;
      }
      const savePath = outputPath ?? path.join(env.OUTPUT_DIR, suggested);
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, body);
      const stat = await fs.stat(savePath);
      return `Downloaded ${suggested} [via ${via}]\nSaved to: ${savePath}\nSize: ${stat.size.toLocaleString()} bytes`;
    };

    try {
      if (forceFetch) {
        return {
          content: [{ type: "text", text: await saveViaFetch("forceFetch") }],
        };
      }

      const page = await mgr.getPage(tabId);
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout }),
          // `page.goto` on a direct download URL raises various messages
          // depending on how Chromium decides to handle the response:
          //   - ERR_ABORTED               (typical for attachment disposition)
          //   - "Download is starting"    (newer Playwright/Chromium)
          //   - "Cannot load download URL" (older Chromium)
          // All three are expected — the download-event listener catches them.
          page.goto(url).catch((err) => {
            const msg = (err as Error).message;
            if (
              !/ERR_ABORTED|net::ERR_ABORTED|Download is starting|Cannot load download URL/i.test(
                msg
              )
            ) {
              throw err;
            }
          }),
        ]);
        const suggested = download.suggestedFilename() || deriveDownloadFilename(url);
        const savePath = outputPath ?? path.join(env.OUTPUT_DIR, suggested);
        await fs.mkdir(path.dirname(savePath), { recursive: true });
        try {
          await download.saveAs(savePath);
        } catch (saveErr) {
          // Steel's remote browser writes the download to its own container's
          // /tmp. saveAs() then tries to copyfile from that path, which only
          // exists on the remote host — ENOENT. Fall through to fetch path
          // using the same session's cookies so auth-scoped downloads work.
          const sMsg = (saveErr as Error).message;
          if (/ENOENT|no such file or directory|copyfile/i.test(sMsg)) {
            return {
              content: [{ type: "text", text: await saveViaFetch("fetch-fallback-after-saveAs-ENOENT") }],
            };
          }
          throw saveErr;
        }
        const stat = await fs.stat(savePath);
        return {
          content: [
            {
              type: "text",
              text: `Downloaded ${suggested} [via download-event]\nSaved to: ${savePath}\nSize: ${stat.size.toLocaleString()} bytes`,
            },
          ],
        };
      } catch (err) {
        const msg = (err as Error).message;
        // Timeout is the expected failure mode for inline-served binaries.
        // Fall through to the HTTP fetch fallback. Re-throw for other errors.
        if (!/waitForEvent.*[Tt]imeout|Timeout.*waitForEvent|Timeout.*download/.test(msg)) {
          throw err;
        }
        return {
          content: [{ type: "text", text: await saveViaFetch("fetch-fallback") }],
        };
      }
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// evaluate --------------------------------------------------------------------
server.tool(
  "evaluate",
  `Execute JavaScript in the page context and return the result as JSON.

Use this as an escape hatch when no other tool covers your need: reading computed styles, extracting structured data, manipulating the DOM, calling page-level APIs.

When \`selector\` is set, the expression runs with a local \`el\` bound to \`document.querySelector(selector)\`. Use \`el.textContent\`, \`el.getAttribute(...)\`, etc. Returns null if the selector matches nothing.

CONTEXT BUDGET — results are serialised to JSON; large objects can be very large. Keep expressions targeted. The expression must be a valid JS expression (not a statement); wrap multi-line logic in an IIFE: (() => { ... })()`,
  {
    expression: z
      .string()
      .describe(
        "JavaScript expression to evaluate in the page context. Must return a JSON-serialisable value. If `selector` is set, reference the matched element as `el`."
      ),
    selector: z
      .string()
      .optional()
      .describe(
        "Optional CSS selector. When set, the expression runs with `el` bound to the first matching element (null if none)."
      ),
    waitAfter: z
      .boolean()
      .default(false)
      .optional()
      .describe("Call the global wait after evaluation (useful if the expression triggers async side effects). Default: false."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ expression, selector, waitAfter = false, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      let result: unknown;
      if (selector) {
        // Wrap expression so `el` is bound to the matched element.
        // JSON.stringify the selector defends against injection.
        const wrapped = `(function(){ const el = document.querySelector(${JSON.stringify(
          selector
        )}); if (!el) return null; return (${expression}); })()`;
        result = await page.evaluate(wrapped);
      } else {
        result = await page.evaluate(expression);
      }
      if (waitAfter) await globalWait();
      const text = result === undefined ? "undefined" : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text: text }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// wait_for --------------------------------------------------------------------
server.tool(
  "wait_for",
  `Wait for a condition on the page before proceeding — more reliable than sleeping.

Use after an action that triggers async changes (form submit, click, navigation) when you need to confirm the page has updated before reading or screenshotting.

Conditions (at least one required): selector, text, textGone. Returns elapsed time or error on timeout.`,
  {
    selector: z.string().optional().describe("CSS selector to wait for (e.g. '#results', '.loaded')."),
    text: z.string().optional().describe("Text string to wait for anywhere on the page."),
    textGone: z.string().optional().describe("Text string to wait for to disappear from the page."),
    timeout: z
      .number()
      .min(100)
      .max(60000)
      .default(10000)
      .optional()
      .describe("Maximum time to wait in milliseconds. Default: 10000 (10s). Max: 60000 (60s)."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ selector, text, textGone, timeout = 10000, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);

      if (!selector && !text && !textGone) {
        return {
          isError: true,
          content: [{ type: "text", text: "At least one of 'selector', 'text', or 'textGone' must be provided." }],
        };
      }

      const start = Date.now();
      const conditions: Promise<void>[] = [];

      if (selector) {
        conditions.push(page.waitForSelector(selector, { timeout }).then(() => undefined));
      }
      if (text) {
        conditions.push(
          page.waitForFunction(
            (t: string) => document.body?.innerText?.includes(t),
            text,
            { timeout }
          ).then(() => undefined)
        );
      }
      if (textGone) {
        conditions.push(
          page.waitForFunction(
            (t: string) => !document.body?.innerText?.includes(t),
            textGone,
            { timeout }
          ).then(() => undefined)
        );
      }

      await Promise.all(conditions);
      const elapsed = Date.now() - start;

      const parts: string[] = [];
      if (selector) parts.push(`selector "${selector}"`);
      if (text) parts.push(`text "${text}"`);
      if (textGone) parts.push(`text gone "${textGone}"`);

      return {
        content: [{ type: "text", text: `Condition met: ${parts.join(", ")} — elapsed ${elapsed}ms.` }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: `wait_for timed out or failed: ${cleanErrorMessage(error)}` }],
      };
    }
  }
);

// console_log -----------------------------------------------------------------
server.tool(
  "console_log",
  `Return browser console messages captured since the browser was started or last cleared.

CONTEXT BUDGET — console output can be large on noisy pages. Use the level filter to limit to errors/warnings. Use clear: true to reset the buffer after reading.`,
  {
    level: z
      .enum(["all", "error", "warning", "info", "log"])
      .default("all")
      .optional()
      .describe("Filter by severity. 'all' returns everything. Default: 'all'."),
    maxEntries: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .optional()
      .describe("Maximum number of entries to return (most recent). Default: 50."),
    clear: z
      .boolean()
      .default(false)
      .optional()
      .describe("Clear the captured log buffer after returning results. Default: false."),
  },
  async ({ level = "all", maxEntries = 50, clear = false }) => {
    try {
      await mgr.initialize();

      let logs = mgr.consoleLogs;
      if (level !== "all") logs = logs.filter((m) => m.level === level);
      const slice = logs.slice(-maxEntries);

      if (clear) mgr.consoleLogs = [];

      if (slice.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No console messages captured${level !== "all" ? ` at level '${level}'` : ""}.`,
            },
          ],
        };
      }

      const formatted = slice
        .map((m) => {
          const base = `[${new Date(m.timestamp).toISOString()}] [${m.level.toUpperCase()}] ${m.text}`;
          if (!m.location || !m.location.url) return base;
          const { url, lineNumber, columnNumber } = m.location;
          const locStr =
            lineNumber || columnNumber ? `${url}:${lineNumber}:${columnNumber}` : url;
          return `${base}\n    at ${locStr}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${slice.length} console message(s)${level !== "all" ? ` (level: ${level})` : ""}:\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// scroll ----------------------------------------------------------------------
server.tool(
  "scroll",
  `Scroll the page by a number of pixels in either direction.

Merges the old scroll_up / scroll_down tools (0.4.0+). Pass direction="up" or "down".`,
  {
    direction: z
      .enum(["up", "down"])
      .describe("Scroll direction: 'up' or 'down'."),
    pixels: z
      .number()
      .default(500)
      .optional()
      .describe("Number of pixels to scroll. Default: 500."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ direction, pixels = 500, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      const dy = direction === "up" ? -pixels : pixels;
      // Capture actual scroll position before/after so we can report the
      // real delta — agents get misled when a fixed-viewport page silently
      // refuses to scroll. Force `behavior: "instant"` so CSS
      // `scroll-behavior: smooth` doesn't make scrollBy async (without this
      // the after-value would still be the before-value and we'd mis-report
      // every scroll on smooth-scrolling sites as a no-op).
      const result = await page.evaluate(
        ({ yDelta }: { yDelta: number }) => {
          const before = window.scrollY;
          window.scrollBy({ left: 0, top: yDelta, behavior: "instant" as ScrollBehavior });
          return { before, after: window.scrollY };
        },
        { yDelta: dy }
      );
      await globalWait();
      const actual = Math.abs(result.after - result.before);
      const noOp = actual === 0;
      const suffix = noOp
        ? ` (no-op — page not scrollable in that direction, or already at edge)`
        : actual !== pixels
          ? ` (actual: ${actual}px — reached document edge)`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Scrolled ${direction} by ${pixels} pixels${suffix}.`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// history ---------------------------------------------------------------------
server.tool(
  "history",
  `Navigate the current (or specified) tab through its browser history.

Merges the old go_back / go_forward / refresh tools (0.4.0+). Pass action="back", "forward", or "reload".`,
  {
    action: z
      .enum(["back", "forward", "reload"])
      .describe("History action: 'back' (previous page), 'forward' (next page), 'reload' (refresh current page)."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ action, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      const beforeUrl = page.url();
      let navResult: Awaited<ReturnType<typeof page.goBack>> | null = null;
      if (action === "back") {
        navResult = await page.goBack({ waitUntil: "commit", timeout: 10000 });
      } else if (action === "forward") {
        navResult = await page.goForward({ waitUntil: "commit", timeout: 10000 });
      } else {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      }
      await globalWait();
      const afterUrl = page.url();
      const verb =
        action === "back" ? "Went back" : action === "forward" ? "Went forward" : "Reloaded";
      // back/forward returns null when history entry missing — Chromium stays put.
      // Require BOTH signals (null response AND URL unchanged) to flag a no-op,
      // because Playwright sometimes returns null even on successful nav to
      // about:blank or a data-URL (known edge case; URL comparison is the truth).
      const noOp =
        (action === "back" || action === "forward") &&
        navResult === null &&
        beforeUrl === afterUrl;
      const suffix = noOp
        ? ` (no-op — no ${action === "back" ? "previous" : "next"} entry in tab history; URL unchanged)`
        : "";
      return { content: [{ type: "text", text: `${verb}${suffix}.\nCurrent URL: ${afterUrl}` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// (google_search removed in 0.4.0 — prefer OpenClaw's `web_search` built-in,
// or use `go_to_url` with "https://www.google.com/search?q=..." when you
// specifically need to interact with the SERP in the browser.)

// go_to_url -------------------------------------------------------------------
server.tool(
  "go_to_url",
  `Navigate the browser to the specified URL.

Optional waitFor: wait for a CSS selector to appear after navigation (saves a separate wait_for call). Returns isError if the destination page is a bot-check wall (Cloudflare "Just a moment", "Attention Required", or /cdn-cgi/challenge-platform/ redirect).`,
  {
    url: z.string().describe("The URL to navigate to."),
    waitFor: z
      .string()
      .optional()
      .describe(
        "Optional CSS selector to wait for after navigation. Replaces a separate wait_for call for list-page scraping. Defaults to no wait."
      ),
    waitTimeout: z
      .number()
      .default(10000)
      .optional()
      .describe("Timeout in ms for waitFor. Default: 10000."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID. Omit to use the current active tab."),
  },
  async ({ url, waitFor, waitTimeout = 10000, tabId }) => {
    try {
      const page = await mgr.getPage(tabId);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await globalWait();

      const finalUrl = page.url();

      // Bot-check / Cloudflare detection (pure helper — tested in helpers.test.ts)
      const title = await page.title().catch(() => "");
      if (isBotWall(title, finalUrl)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Bot-check wall detected. title="${title}" url=${finalUrl}. Hand off to user via start_browser (Interactive URL).`,
            },
          ],
        };
      }

      // Optional wait for content selector
      let waitMsg = "";
      if (waitFor) {
        try {
          await page.waitForSelector(waitFor, { timeout: waitTimeout });
          waitMsg = `\nwaitFor "${waitFor}" matched.`;
        } catch {
          waitMsg = `\nwaitFor "${waitFor}" TIMED OUT after ${waitTimeout}ms (page loaded but selector missing).`;
        }
      }

      const navLine =
        finalUrl !== url
          ? `Navigated to ${url}\nFinal URL: ${finalUrl}`
          : `Navigated to ${finalUrl}`;
      return { content: [{ type: "text", text: navLine + waitMsg }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// start_browser ---------------------------------------------------------------
server.tool(
  "start_browser",
  `Start the browser if it is not already running. Returns a Steel debug URL when running in steel mode.

When running in steel mode, returns three URLs:
- Session Viewer: read-only live view of the browser session
- Interactive URL: lets a human take control (click, type, solve CAPTCHAs, enter credentials)

If you need the user to intervene (CAPTCHA, login, 2FA), give them the Interactive URL and wait for them to confirm they are done before continuing.`,
  {},
  async () => {
    try {
      await mgr.initialize();
      const lines: string[] = ["Browser started."];
      if (mgr.sessionViewerUrl) {
        lines.push(`Session Viewer: ${mgr.sessionViewerUrl}`);
      }
      if (mgr.debugUrl) {
        lines.push(`Interactive URL: ${mgr.debugUrl}?interactive=true&showControls=true`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// store_credential ------------------------------------------------------------
server.tool(
  "store_credential",
  `Store, update, or delete a named credential for a site. Credentials persist across sessions.

Use for login automation: store credentials once, then use use_credential to auto-fill login forms.`,
  {
    name: z.string().describe("Unique name for this credential (e.g., 'github', 'aws-prod')."),
    url: z.string().optional().describe("URL pattern or domain to associate with this credential (e.g., 'github.com', 'https://console.aws.amazon.com')."),
    username: z.string().optional().describe("Username or email."),
    password: z.string().optional().describe("Password."),
    extra: z.string().optional().describe("Additional fields as JSON string (e.g., '{\"otp_secret\": \"...\", \"company\": \"...\"}')."),
    remove: z.boolean().optional().describe("Set true to delete this credential instead of storing/updating it."),
  },
  async ({ name, url, username, password, extra, remove }) => {
    try {
      const creds = await loadCredentials();

      if (remove) {
        const idx = creds.findIndex((c) => c.name === name);
        if (idx === -1) return { content: [{ type: "text", text: `Credential "${name}" not found.` }] };
        creds.splice(idx, 1);
        await saveCredentials(creds);
        return { content: [{ type: "text", text: `Credential "${name}" deleted.` }] };
      }

      if (!url || !username || !password) {
        return { isError: true, content: [{ type: "text", text: "url, username, and password are required for storing a credential." }] };
      }

      const existing = creds.findIndex((c) => c.name === name);
      const now = new Date().toISOString();
      let parsedExtra: Record<string, string> | undefined;
      if (extra) {
        try { parsedExtra = JSON.parse(extra); } catch { parsedExtra = { raw: extra }; }
      }
      const cred: Credential = {
        name, url, username, password,
        ...(parsedExtra ? { extra: parsedExtra } : {}),
        createdAt: existing >= 0 ? creds[existing].createdAt : now,
        updatedAt: now,
      };

      if (existing >= 0) {
        creds[existing] = cred;
      } else {
        creds.push(cred);
      }
      await saveCredentials(creds);
      return { content: [{ type: "text", text: `Credential "${name}" ${existing >= 0 ? "updated" : "stored"} for ${url}.` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// use_credential --------------------------------------------------------------
server.tool(
  "use_credential",
  `Retrieve a stored credential by name and optionally auto-fill a login form on the current page.

Without selectors: returns the credential (username + password + any extra fields).
With selectors: fills the form fields on the page and optionally clicks submit.`,
  {
    name: z.string().describe("Name of the stored credential to use."),
    usernameSelector: z.string().optional().describe("CSS selector for the username/email input field."),
    passwordSelector: z.string().optional().describe("CSS selector for the password input field."),
    submitSelector: z.string().optional().describe("CSS selector for the submit/login button. If provided, clicks it after filling."),
    tabId: z.number().int().min(1).optional().describe("Optional tab ID for the page to fill."),
  },
  async ({ name, usernameSelector, passwordSelector, submitSelector, tabId }) => {
    try {
      const creds = await loadCredentials();
      const cred = creds.find((c) => c.name === name);
      if (!cred) {
        return { isError: true, content: [{ type: "text", text: `Credential "${name}" not found. Use store_credential to save it first.` }] };
      }

      // If no selectors, just return the credential info
      if (!usernameSelector && !passwordSelector) {
        const info: Record<string, string> = {
          name: cred.name,
          url: cred.url,
          username: cred.username,
          password: "***" + cred.password.slice(-3),
        };
        if (cred.extra) Object.assign(info, cred.extra);
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      // Fill the form
      const page = await mgr.getPage(tabId);
      const filled: string[] = [];

      if (usernameSelector) {
        await page.fill(usernameSelector, cred.username);
        filled.push("username");
      }
      if (passwordSelector) {
        await page.fill(passwordSelector, cred.password);
        filled.push("password");
      }
      if (submitSelector) {
        await page.click(submitSelector);
        filled.push("submitted");
      }

      await globalWait();
      return { content: [{ type: "text", text: `Credential "${name}" applied: ${filled.join(", ")}.` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// list_credentials ------------------------------------------------------------
server.tool(
  "list_credentials",
  `List all stored credentials (passwords masked).`,
  {},
  async () => {
    try {
      const creds = await loadCredentials();
      if (creds.length === 0) {
        return { content: [{ type: "text", text: "No stored credentials. Use store_credential to add one." }] };
      }
      const lines = creds.map((c) =>
        `  ${c.name}: ${c.username} @ ${c.url}${c.extra ? ` (+${Object.keys(c.extra).length} extra fields)` : ""}`
      );
      return { content: [{ type: "text", text: "Credentials:\n" + lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// captcha_status --------------------------------------------------------------
server.tool(
  "captcha_status",
  `Check CapSolver CAPTCHA solving status: API balance and whether the extension is loaded. Useful before tasks that may encounter CAPTCHAs.`,
  {},
  async () => {
    try {
      // Check CapSolver balance via API
      const apiKey = process.env.CAPSOLVER_API_KEY;
      let balance: number | null = null;
      let apiError: string | undefined;

      if (apiKey) {
        try {
          const res = await fetch("https://api.capsolver.com/getBalance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey }),
          });
          const data = (await res.json()) as { balance?: number; errorId?: number; errorDescription?: string };
          if (data.errorId && data.errorId !== 0) {
            apiError = data.errorDescription || "Unknown API error";
          } else {
            balance = data.balance ?? null;
          }
        } catch (err) {
          apiError = (err as Error).message;
        }
      }

      const lines: string[] = [];
      lines.push(`CapSolver API key: ${apiKey ? "configured" : "NOT SET"}`);
      if (balance !== null) lines.push(`Balance: $${balance.toFixed(2)}`);
      if (apiError) lines.push(`API error: ${apiError}`);
      lines.push(`Extension: loaded in Steel container (token mode)`);
      lines.push(`Supported: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, AWS WAF, GeeTest, DataDome, ImageToText`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// create_profile --------------------------------------------------------------
server.tool(
  "create_profile",
  `Create a named browser profile (isolated BrowserContext) with its own cookies, localStorage, and cache. If a saved profile with this name exists on disk, its cookies/localStorage are restored automatically.

Use profiles for:
- Concurrent agents that need separate auth sessions
- Persisting login state across browser restarts
- Isolating scraping sessions to avoid cross-contamination

Returns a tabId for the new profile's initial page. Use this tabId with all subsequent tools.`,
  {
    name: z.string().describe("Profile name (e.g., 'shopping', 'research', 'agent-1'). Must be unique among active profiles."),
    url: z.string().optional().describe("Optional URL to navigate to immediately after creating the profile."),
  },
  async ({ name, url }) => {
    try {
      const { tabId, restored } = await mgr.createProfile(name, url);
      const parts = [`Profile "${name}" created. Tab ID: ${tabId}`];
      if (restored) parts.push("(restored saved cookies/localStorage)");
      if (url) parts.push(`Navigated to ${url}`);
      return { content: [{ type: "text", text: parts.join(" ") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// list_profiles ---------------------------------------------------------------
server.tool(
  "list_profiles",
  `List all browser profiles — both active (with live BrowserContexts) and saved (on disk). Shows tab count for active profiles and last saved timestamp for persisted ones.`,
  {},
  async () => {
    try {
      const profiles = await mgr.listProfiles();
      if (profiles.length === 0) {
        return { content: [{ type: "text", text: "No profiles. Use create_profile to create one." }] };
      }
      const lines = profiles.map((p) => {
        const status = p.active ? `active (${p.tabCount} tab${p.tabCount !== 1 ? "s" : ""})` : "saved";
        const saved = p.savedAt ? ` | saved: ${p.savedAt}` : "";
        return `  ${p.name}: ${status}${saved}`;
      });
      return { content: [{ type: "text", text: "Profiles:\n" + lines.join("\n") }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// save_profile ----------------------------------------------------------------
server.tool(
  "save_profile",
  `Persist a profile's cookies and localStorage to disk as JSON. The saved state can be restored later by create_profile with the same name. Useful for preserving login sessions across browser restarts.`,
  {
    name: z.string().describe("Name of the active profile to save."),
  },
  async ({ name }) => {
    try {
      const savedPath = await mgr.saveProfile(name);
      return { content: [{ type: "text", text: `Profile "${name}" saved to ${savedPath}` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// delete_profile --------------------------------------------------------------
server.tool(
  "delete_profile",
  `Delete a browser profile. Closes its BrowserContext and all tabs. Optionally removes the saved state from disk.`,
  {
    name: z.string().describe("Name of the profile to delete."),
    removeSaved: z.boolean().optional().default(false).describe("Also remove the saved profile JSON from disk. Default: false (keep saved state for future restoration)."),
  },
  async ({ name, removeSaved }) => {
    try {
      await mgr.deleteProfile(name, removeSaved);
      const extra = removeSaved ? " (saved state also removed)" : "";
      return { content: [{ type: "text", text: `Profile "${name}" deleted${extra}.` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// stop_browser ----------------------------------------------------------------
server.tool(
  "stop_browser",
  "Stop the browser and clean up resources. Releases the Steel session if one is active.",
  {},
  async () => {
    try {
      await mgr.stop();
      return { content: [{ type: "text", text: "Browser stopped." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
    }
  }
);

// -----------------------------------------------------------------------------
// Server lifecycle
// -----------------------------------------------------------------------------
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Steel MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.error("Received SIGINT, cleaning up...");
  await mgr.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Received SIGTERM, cleaning up...");
  await mgr.stop();
  process.exit(0);
});
