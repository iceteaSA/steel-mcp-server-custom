// -----------------------------------------------------------------------------
// manager.ts — BrowserManager and shared types.
//
// Extracted from index.ts lines 52–938. The BrowserManager class receives
// the parsed env object as a constructor parameter instead of closing over the
// module-level `env` constant.
//
// Credential helpers live in src/credentials-store.ts.
// Utility functions (sleep, globalWait, writeToFile) live in src/utils.ts.
// -----------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import { sleep } from "./utils.js";

import { chromium, Browser, BrowserContext, Page, Request, Response } from "playwright";
import { Steel } from "steel-sdk";
import { z } from "zod";
import { EnvSchema } from "./env";
import {
  filterNetworkEvents,
  isBrowserClosedError,
  isSteelSessionStuck,
  isValidProfileName,
  assertSafeProfilePath,
} from "./helpers";
import { clearSnapshot, clearAllSnapshots } from "./snapshot.js";
import { SETTLE_INIT_SCRIPT } from "./settle.js";

// Inferred type of the parsed env object.
export type Env = z.infer<typeof EnvSchema>;

// -----------------------------------------------------------------------------
// ConsoleMessage — index.ts lines 52–57
// -----------------------------------------------------------------------------

export type ConsoleMessage = {
  level: string;
  text: string;
  timestamp: number;
  tabId?: number;
  location?: { url: string; lineNumber: number; columnNumber: number };
};

// -----------------------------------------------------------------------------
// NetworkEvent — request/response metadata captured by BrowserManager
// -----------------------------------------------------------------------------

export interface NetworkEvent {
  id: number;
  tabId?: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  sizeBytes?: number;
  durationMs?: number;
  at: number;
  failed?: boolean;
  // Strong reference to the Playwright Response while the event lives in the
  // ring buffer; cleared on eviction so the body is released promptly.
  response?: Response;
}

// -----------------------------------------------------------------------------
// Error classes for owner-isolated tab access
// -----------------------------------------------------------------------------

/**
 * Thrown when an agent tries to access a tab owned by a different agent
 * without the `force: true` override.
 */
export class TabOwnershipError extends Error {
  constructor(
    public readonly tabId: number,
    public readonly tabOwner: string,
    public readonly caller: string,
  ) {
    super(
      `Tab ${tabId} belongs to owner "${tabOwner}" — you are "${caller}". ` +
        `Pass force:true to override, or target your own tab.`,
    );
    this.name = "TabOwnershipError";
  }
}

/**
 * Thrown when an owner-based lookup finds no open tab for the given owner.
 */
export class NoTabError extends Error {
  constructor(public readonly owner: string) {
    super(`No open tab for owner "${owner}" — call new_tab with your owner first.`);
    this.name = "NoTabError";
  }
}

// -----------------------------------------------------------------------------
// BrowserManager — index.ts lines 59–938
// -----------------------------------------------------------------------------

export class BrowserManager {
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

  // Per-owner active tab tracking. Updated whenever a tab is touched
  // with an explicit owner context (touchTab, newTab with owner).
  // resolveTab uses this for owner-only lookup (no explicit tabId).
  private ownerActiveTab = new Map<string, number>();

  // Profile management — multiple isolated BrowserContexts within one browser.
  // Each profile has its own cookies/localStorage/cache. Tabs from all profiles
  // share the global tabs map (globally unique tabId), so existing tools work
  // unchanged — agents just pass their tabId.
  private profiles: Map<string, { context: BrowserContext; tabIds: Set<number> }> = new Map();
  private tabToProfile: Map<number, string> = new Map(); // tabId → profileName

  // Tracks pages → tabIds for idempotent allocation. A context.on("page")
  // listener fires for ALL new pages including our own context.newPage()
  // calls — if allocateTab didn't deduplicate, every newTab/createProfile
  // page would be registered twice.
  private pageToTabId = new WeakMap<Page, number>();

  // Dialog management — per-tab policy + last dialog record.
  // Playwright dialogs block page operations until handled, so we resolve them
  // the instant they fire using a pre-armed policy (default: dismiss). The
  // previous pending/timer model allowed a later tool call to decide, but the
  // triggering action itself hangs until the dialog is resolved — a serial MCP
  // client cannot call handle_dialog until the action returns.
  private dialogPolicy = new Map<
    number,
    { action: "accept" | "dismiss"; promptText?: string; once?: boolean }
  >();
  private lastDialogs = new Map<
    number,
    {
      type: string;
      message: string;
      defaultValue: string;
      action: "accepted" | "dismissed";
      promptText?: string;
      autoHandled: boolean;
      reported: boolean;
      at: number;
    }
  >();

  // Network capture — request/response ring buffer shared across contexts.
  // Strong response refs live on the event until eviction; WeakSet prevents
  // double-wiring listeners on the same BrowserContext.
  private networkEvents: NetworkEvent[] = [];
  private nextNetworkEventId = 1;
  private requestStartTimes = new WeakMap<Request, number>();
  private wiredNetworkContexts = new WeakSet<BrowserContext>();

  // Last known URL per tab, used by crash recovery to re-navigate after a
  // page is detected as closed/crashed.
  private tabLastUrl = new Map<number, string>();

  // One-shot notices appended to the next tool result for a recovered tab.
  private recoveryNotices = new Map<number, string>();

  constructor(private readonly env: Env) {}

  /** Expose the default BrowserContext for tools that need direct cookie/request access. */
  get context(): BrowserContext | undefined {
    return this.browserContext;
  }

  /** Expose the active tab id for tests and tool-side pointer checks. */
  get activeTabId(): number {
    return this.currentTabId;
  }

  /**
   * Mark a tab as recently used. Called on every page-interacting tool.
   * When an owner is given, also updates the per-owner active tab pointer
   * so that owner-only resolveTab lookups find the right tab.
   */
  touchTab(tabId: number, owner?: string): void {
    if (this.tabs.has(tabId)) {
      this.tabLastActivity.set(tabId, Date.now());
      if (owner) this.ownerActiveTab.set(owner, tabId);
    }
  }

  /**
   * Resolve a tab ID from an optional explicit ID, owner context, and
   * force flag. This is the single ownership guard that all page-accessing
   * calls should route through.
   *
   * Rules (first match wins):
   * 1. explicit tabId + owner given AND tab has different owner AND !force →
   *    throw TabOwnershipError
   * 2. explicit tabId → return it (caller validates existence)
   * 3. owner given, no tabId → ownerActiveTab lookup; fall back to that
   *    owner's most-recently-touched surviving tab; none → NoTabError
   * 4. neither → return currentTabId (global active tab pointer)
   */
  resolveTab(opts: { tabId?: number; owner?: string; force?: boolean }): number {
    // Explicit tabId + optional ownership check
    if (opts.tabId !== undefined) {
      if (opts.owner) {
        const tabOwner = this.tabOwners.get(opts.tabId);
        if (tabOwner !== undefined && tabOwner !== opts.owner && !opts.force) {
          throw new TabOwnershipError(opts.tabId, tabOwner, opts.owner);
        }
      }
      return opts.tabId;
    }

    // Owner-based lookup (no explicit tabId)
    if (opts.owner) {
      // 3a. Check cached per-owner active tab — common case
      const active = this.ownerActiveTab.get(opts.owner);
      if (active !== undefined) {
        const page = this.tabs.get(active);
        if (page && !page.isClosed()) return active;
        // Stale pointer — page was closed externally. Fall through to scan.
      }

      // 3b. Fall back to most-recently-touched surviving tab for this owner
      let bestId: number | undefined;
      let bestTime = 0;
      for (const [id, last] of this.tabLastActivity) {
        if (this.tabOwners.get(id) === opts.owner && last > bestTime) {
          const page = this.tabs.get(id);
          if (page && !page.isClosed()) {
            bestId = id;
            bestTime = last;
          }
        }
      }
      if (bestId !== undefined) {
        // Repair the stale pointer
        this.ownerActiveTab.set(opts.owner, bestId);
        return bestId;
      }

      // 3c. Nothing found
      throw new NoTabError(opts.owner);
    }

    // Neither — legacy global active pointer
    return this.currentTabId;
  }

  private allocateTab(page: Page, owner?: string): number {
    // Idempotent: if this page was already registered (e.g. by the
    // context.on("page") listener that fires for ALL new pages including
    // our own context.newPage() calls), return the existing tabId.
    const existing = this.pageToTabId.get(page);
    if (existing !== undefined) {
      // Merge owner metadata: listener-registered pages have no owner, but
      // an explicit caller may supply one. Refresh activity so the tab stays
      // alive. Never steal a tab from its existing owner.
      if (owner) {
        const existingOwner = this.tabOwners.get(existing);
        if (existingOwner === undefined) {
          this.tabOwners.set(existing, owner);
        } else if (existingOwner !== owner) {
          console.error(
            `[steel-mcp] allocateTab re-registration warning: tab ${existing} already owned by "${existingOwner}"; ignoring owner "${owner}".`,
          );
        }
      }
      this.tabLastActivity.set(existing, Date.now());
      return existing;
    }

    const id = this.nextTabId++;
    this.tabs.set(id, page);
    if (owner) this.tabOwners.set(id, owner);
    this.tabLastActivity.set(id, Date.now());
    this.attachConsoleListener(page);
    this.attachPageListeners(page, id);
    this.pageToTabId.set(page, id);
    return id;
  }

  /**
   * Attach dialog + close listeners to a page. Extracted so crash recovery
   * can re-wire listeners on a replacement page without re-running the full
   * allocateTab allocation path. Guards ignore events from a page that has
   * been replaced in the tab registry.
   */
  private attachPageListeners(page: Page, id: number): void {
    // Dialog capture: Playwright dialogs block all page operations until
    // handled, so we resolve them immediately using the tab's pre-armed policy.
    // Default policy is dismiss (Playwright's conservative default). The agent
    // arms accept/accept+promptText via handle_dialog BEFORE the action that
    // triggers the dialog. beforeunload is always accepted so navigation isn't
    // blocked. The whole handler is wrapped in try/catch with a best-effort
    // dismiss fallback so a listener bug never wedges the tab.
    page.on("dialog", async (dialog) => {
      // Ignore events from a page that is no longer the registered one
      // (e.g. the original page was replaced during crash recovery).
      if (this.tabs.get(id) !== page) return;

      const type = dialog.type();
      const message = dialog.message();
      const defaultValue = dialog.defaultValue();

      try {
        if (type === "beforeunload") {
          // beforeunload: auto-accept — blocking navigation is never useful for an agent.
          await dialog.accept();
          this.lastDialogs.set(id, {
            type,
            message,
            defaultValue,
            action: "accepted",
            promptText: undefined,
            autoHandled: true,
            reported: true, // beforeunload is normal navigation noise; don't report
            at: Date.now(),
          });
          return;
        }

        const policy = this.dialogPolicy.get(id);
        const action = policy?.action ?? "dismiss";
        const promptText = policy?.promptText;

        if (action === "accept") {
          await dialog.accept(promptText);
        } else {
          await dialog.dismiss();
        }

        this.lastDialogs.set(id, {
          type,
          message,
          defaultValue,
          action: action === "accept" ? "accepted" : "dismissed",
          promptText,
          autoHandled: true,
          reported: false,
          at: Date.now(),
        });

        if (policy?.once) {
          this.dialogPolicy.delete(id);
        }
      } catch (err) {
        // Internal failure in the listener — dismiss best-effort so the
        // dialog does not wedge the tab permanently. Log the error so
        // operators can diagnose listener bugs.
        console.error(`[steel-mcp] dialog handler error for tab ${id}:`, (err as Error).message);
        try {
          await dialog.dismiss();
        } catch {
          // nothing more we can do
        }
      }
    });

    page.on("close", () => {
      // Ignore close events from a page that was replaced by crash recovery
      // so the new page's registry entry isn't wiped out.
      if (this.tabs.get(id) !== page) return;
      this.tabs.delete(id);
      this.tabOwners.delete(id);
      this.tabLastActivity.delete(id);
      this.tabLastUrl.delete(id);
      this.pageToTabId.delete(page);
      clearSnapshot(id);
      // Clean up ownerActiveTab if this was someone's active tab
      for (const [o, activeId] of this.ownerActiveTab) {
        if (activeId === id) this.ownerActiveTab.delete(o);
      }
      const profileName = this.tabToProfile.get(id);
      if (profileName) {
        this.tabToProfile.delete(id);
        const profile = this.profiles.get(profileName);
        if (profile) profile.tabIds.delete(id);
      }
      // Clear dialog state when page closes — dialogs are gone when the page is gone.
      this.dialogPolicy.delete(id);
      this.lastDialogs.delete(id);
    });
  }

  /**
   * Recreate a tab in-place: open a fresh page, swap it into the registry
   * under the same tabId, re-wire listeners, and re-navigate to the last known
   * URL. Sets a one-shot recovery notice for the tab.
   */
  private async _recoverTab(tabId: number): Promise<Page> {
    const replacePage = async (page: Page): Promise<Page> => {
      const oldPage = this.tabs.get(tabId);
      if (oldPage) this.pageToTabId.delete(oldPage);
      this.tabs.set(tabId, page);
      this.pageToTabId.set(page, tabId);
      this.tabLastActivity.set(tabId, Date.now());
      this.attachConsoleListener(page);
      this.attachPageListeners(page, tabId);
      const lastUrl = this.tabLastUrl.get(tabId) ?? "about:blank";
      try {
        await page.goto(lastUrl, { waitUntil: "commit", timeout: 10000 });
      } catch {
        // Navigation failure on a crashed tab is best-effort; the caller
        // still gets a live page to continue from.
      }
      this.tabLastUrl.set(tabId, page.url());
      this.recoveryNotices.set(tabId, `⚠ tab ${tabId} crashed and was restored to ${page.url()}`);
      return page;
    };

    try {
      const newPage = await this.browserContext!.newPage();
      return await replacePage(newPage);
    } catch (err) {
      if (!isBrowserClosedError(err)) throw err;
      await this.softReset();
      await sleep(2000);
      await this.initialize();
      const newPage = await this.browserContext!.newPage();
      return await replacePage(newPage);
    }
  }

  /** Return true if a page reference is unusable (closed or detached/crashed). */
  private async isPageDead(page?: Page): Promise<boolean> {
    if (!page || page.isClosed()) return true;
    try {
      page.url();
      await page.evaluate(() => 1);
      return false;
    } catch {
      return true;
    }
  }

  /** Start the idle sweeper. Idempotent; no-op if TAB_IDLE_TIMEOUT_MS=0. */
  private startIdleSweeper(): void {
    if (this.idleSweeperHandle) return;
    if (this.env.TAB_IDLE_TIMEOUT_MS <= 0) return;
    this.idleSweeperHandle = setInterval(() => {
      this.sweepIdleTabs().catch((err) => {
        console.error("[steel-mcp] idle sweep error:", (err as Error).message);
      });
    }, this.env.TAB_IDLE_SWEEP_INTERVAL_MS);
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
    if (this.env.TAB_IDLE_TIMEOUT_MS <= 0) return [];
    const cutoff = Date.now() - this.env.TAB_IDLE_TIMEOUT_MS;
    const stale: number[] = [];
    for (const [id, last] of this.tabLastActivity) {
      if (id === this.primaryTabId) continue;
      if (last < cutoff) stale.push(id);
    }
    for (const id of stale) {
      try {
        await this.closeTab(id);
        console.error(
          `[steel-mcp] idle-sweep closed tab ${id} (${this.env.TAB_IDLE_TIMEOUT_MS}ms idle)`,
        );
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
    if (!this.env.STEEL_PUBLIC_URL || !this.env.STEEL_BASE_URL || !url) return url;
    const internal = this.env.STEEL_BASE_URL.replace(/\/$/, "");
    const pub = this.env.STEEL_PUBLIC_URL.replace(/\/$/, "");
    return url.replace(internal, pub);
  }

  /**
   * Create a fresh Steel session, connect Playwright CDP, wire the initial
   * page + context. Extracted so initialize() can retry it on a detected
   * stuck-session condition after clearing server-side state.
   */
  private async _connectSteel(): Promise<void> {
    this.steelClient = new Steel({
      steelAPIKey: this.env.STEEL_API_KEY ?? "local",
      ...(this.env.STEEL_BASE_URL ? { baseURL: this.env.STEEL_BASE_URL } : {}),
    });

    const session = await this.steelClient.sessions.create({
      timeout: this.env.SESSION_TIMEOUT_MS,
      ...(this.env.OPTIMIZE_BANDWIDTH ? { optimizeBandwidth: true } : {}),
    });
    this.sessionId = session.id;
    this.debugUrl = this.rewriteUrl(session.debugUrl);
    this.sessionViewerUrl = this.rewriteUrl(session.sessionViewerUrl);

    let wsUrl: string;
    if (this.env.STEEL_BASE_URL) {
      const base = this.env.STEEL_BASE_URL.replace(/\/$/, "");
      const wsBase = base.startsWith("https://")
        ? base.replace("https://", "wss://")
        : base.replace("http://", "ws://");
      wsUrl = `${wsBase}/v1/sessions/${session.id}/cdp`;
    } else {
      wsUrl = `${session.websocketUrl}&apiKey=${this.env.STEEL_API_KEY}`;
    }

    this.browser = await chromium.connectOverCDP(wsUrl);
    this.browserContext = this.browser.contexts()[0];
    // Settle detection init runs before any page script on future pages;
    // the first page (already loaded) will be guarded by the undefined probe.
    await this.browserContext.addInitScript(SETTLE_INIT_SCRIPT);
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
    if (!this.env.STEEL_BASE_URL) {
      // Steel Cloud — we don't have blanket delete rights. Let the SDK retry
      // handle it; bubble the error out to the tool caller.
      console.error("[steel-mcp] Steel Cloud mode — skipping session sweep (no admin rights).");
      return;
    }
    const base = this.env.STEEL_BASE_URL.replace(/\/$/, "");
    const apiKey = this.env.STEEL_API_KEY;
    const authHeader: Record<string, string> = apiKey ? { "steel-api-key": apiKey } : {};
    try {
      const listRes = await fetch(`${base}/v1/sessions`, { headers: authHeader });
      if (!listRes.ok) {
        console.error(`[steel-mcp] sessions list failed: ${listRes.status} ${listRes.statusText}`);
        return;
      }
      const payload = (await listRes.json()) as {
        sessions?: Array<{ id: string; status: string }>;
      };
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

    if (this.env.BROWSER_MODE === "steel") {
      try {
        await this._connectSteel();
      } catch (err) {
        if (!isSteelSessionStuck(err)) throw err;
        console.error(
          "[steel-mcp] stuck Steel session detected on connect; releasing all live sessions and retrying. Cause:",
          (err as Error).message,
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
          width: this.env.DEFAULT_VIEWPORT_WIDTH,
          height: this.env.DEFAULT_VIEWPORT_HEIGHT,
        },
      });
      await this.browserContext.addInitScript(SETTLE_INIT_SCRIPT);
      const initialPage = await this.browserContext.newPage();
      this.currentTabId = this.allocateTab(initialPage);
      // Mark primary — consistency with steel mode, and protects the only
      // viewport-ready page from being swept.
      this.primaryTabId = this.currentTabId;
    }

    this.initialized = true;

    // Wire network capture before popup capture so requests made by the
    // initial page are recorded from the start.
    this._wireNetworkCapture(this.browserContext!);

    // Register popup/new-page detection. Pages created by the site
    // (target=_blank, window.open) bypass allocateTab — this listener
    // catches them and wires them into the tab registry.
    this._wirePopupCapture(this.browserContext!);

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

  /**
   * Wire request/response capture on a BrowserContext. Idempotent per context;
   * skipped entirely when NETWORK_BUFFER_SIZE is 0.
   */
  private _wireNetworkCapture(context: BrowserContext): void {
    if (this.env.NETWORK_BUFFER_SIZE <= 0) return;
    if (this.wiredNetworkContexts.has(context)) return;
    this.wiredNetworkContexts.add(context);

    context.on("request", (request) => {
      try {
        this.requestStartTimes.set(request, Date.now());
      } catch {
        // Never let a listener bug escape into Playwright.
      }
    });

    context.on("response", async (response) => {
      try {
        const request = response.request();
        const start = this.requestStartTimes.get(request);
        const page = request.frame()?.page();
        const tabId = page ? this.pageToTabId.get(page) : undefined;
        const headers = response.headers();
        const contentType = headers["content-type"];
        const contentLength = headers["content-length"];
        const sizeBytes = contentLength ? parseInt(contentLength, 10) : undefined;

        this.pushNetworkEvent({
          id: this.nextNetworkEventId++,
          tabId,
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          status: response.status(),
          contentType,
          sizeBytes,
          durationMs: start ? Date.now() - start : undefined,
          at: Date.now(),
          response,
        });
      } catch {
        // best-effort capture
      }
    });

    context.on("requestfailed", (request) => {
      try {
        const page = request.frame()?.page();
        const tabId = page ? this.pageToTabId.get(page) : undefined;
        this.pushNetworkEvent({
          id: this.nextNetworkEventId++,
          tabId,
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          failed: true,
          at: Date.now(),
        });
      } catch {
        // best-effort capture
      }
    });
  }

  /** Append a network event to the ring buffer and evict oldest if over capacity. */
  private pushNetworkEvent(event: NetworkEvent): void {
    if (this.env.NETWORK_BUFFER_SIZE <= 0) return;
    this.networkEvents.push(event);
    if (this.networkEvents.length > this.env.NETWORK_BUFFER_SIZE) {
      const evicted = this.networkEvents.splice(
        0,
        this.networkEvents.length - this.env.NETWORK_BUFFER_SIZE,
      );
      for (const e of evicted) {
        e.response = undefined;
      }
    }
  }

  /**
   * Return network events matching the given filter. Results are chronological
   * (oldest first) with the newest `limit` entries when capped. Owner filtering
   * is applied here because only the manager knows tab ownership.
   */
  getNetworkEvents(filter?: {
    urlPattern?: string;
    resourceType?: string;
    status?: string;
    tabId?: number;
    owner?: string;
    limit?: number;
  }): NetworkEvent[] {
    let events = this.networkEvents.slice();

    if (filter?.owner) {
      const ownedIds = new Set<number>();
      for (const [id, owner] of this.tabOwners) {
        if (owner === filter.owner) ownedIds.add(id);
      }
      events = events.filter((e) => e.tabId !== undefined && ownedIds.has(e.tabId!));
    }

    return filterNetworkEvents(events, {
      urlPattern: filter?.urlPattern,
      resourceType: filter?.resourceType,
      status: filter?.status,
      tabId: filter?.tabId,
      limit: filter?.limit,
    }) as NetworkEvent[];
  }

  /**
   * Fetch the response body for a buffered network event. Throws if the event
   * has been evicted or the response reference was collected.
   */
  async getResponseBody(id: number): Promise<string> {
    const event = this.networkEvents.find((e) => e.id === id);
    if (!event?.response) {
      throw new Error("body no longer available");
    }
    const body = await event.response.body();
    return body.toString();
  }

  /**
   * Record the last known URL for a tab. Called by navigation tools after a
   * successful navigation so crash recovery can restore to the right place.
   */
  setTabLastUrl(tabId: number, url: string): void {
    this.tabLastUrl.set(tabId, url);
  }

  /**
   * Consume and return the recovery notice for a tab, if any. The notice is
   * cleared after the first read so it is appended to only one tool result.
   */
  consumeRecoveryNotice(tabId: number): string {
    const notice = this.recoveryNotices.get(tabId);
    if (!notice) return "";
    this.recoveryNotices.delete(tabId);
    return notice;
  }

  /**
   * Wire popup/page capture on a BrowserContext so pages opened by the site
   * (target=_blank, window.open) are registered in the tab bookkeeping
   * with full dialog + console capture. Idempotent per context.
   */
  private _wirePopupCapture(context: BrowserContext): void {
    context.on("page", (popup) => {
      // allocateTab is idempotent — pages already registered (e.g.
      // through _doNewTab) just return their existing tabId.
      this.allocateTab(popup);
    });
  }
  private attachConsoleListener(page: Page) {
    if (this.listenedPages.has(page)) return;
    this.listenedPages.add(page);

    // Resolve page → tabId once per entry so messages are taggable.
    // The page may have been recreated after a crash — if not in the
    // registry, tabId stays undefined (harmless, messages still land).
    const resolveTabId = () => {
      for (const [id, p] of this.tabs) {
        if (p === page) return id;
      }
      return undefined;
    };

    page.on("console", (msg) => {
      const loc = msg.location();
      this.consoleLogs.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
        tabId: resolveTabId(),
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
        tabId: resolveTabId(),
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
   * different agents hold different tabs.
   *
   * Overload 1: legacy — `getPage(tabId?)` for backward compatibility.
   * Overload 2: owner-aware — `getPage({ tabId?, owner?, force? })` routes
   *             through resolveTab to enforce per-agent tab isolation.
   */
  async getPage(tabId?: number): Promise<Page>;
  async getPage(opts: { tabId?: number; owner?: string; force?: boolean }): Promise<Page>;
  async getPage(arg?: number | { tabId?: number; owner?: string; force?: boolean }): Promise<Page> {
    await this.initialize();

    let tabId: number | undefined;
    let owner: string | undefined;
    let force = false;

    if (typeof arg === "number") {
      tabId = arg;
    } else if (arg) {
      tabId = arg.tabId;
      owner = arg.owner;
      force = arg.force ?? false;
    }

    // Owner-aware path: resolveTab handles ownership validation + lookup
    if (tabId !== undefined || owner) {
      const resolved = this.resolveTab({ tabId, owner, force });
      const page = this.tabs.get(resolved);
      if (!page || (await this.isPageDead(page))) {
        const recovered = await this._recoverTab(resolved);
        if (await this.isPageDead(recovered)) {
          throw new Error(`Tab ${resolved} crashed and could not be restored.`);
        }
        this.touchTab(resolved, owner);
        this.tabLastUrl.set(resolved, recovered.url());
        return recovered;
      }
      this.touchTab(resolved, owner);
      this.tabLastUrl.set(resolved, page.url());
      return page;
    }

    // Legacy path: getPage() with no args at all
    const page = this.currentPage;
    if (!(await this.isPageDead(page))) {
      this.touchTab(this.currentTabId);
      this.tabLastUrl.set(this.currentTabId, page!.url());
      return page!;
    }

    // Current tab missing or closed/crashed — recreate in-place and retry once.
    const recovered = await this._recoverTab(this.currentTabId);
    if (await this.isPageDead(recovered)) {
      throw new Error(`Tab ${this.currentTabId} crashed and could not be restored.`);
    }
    this.touchTab(this.currentTabId);
    this.tabLastUrl.set(this.currentTabId, recovered.url());
    return recovered;
  }

  /**
   * Open a new tab, register it, and return its ID and page.
   * When `activate` is true (the default), the new tab becomes the active
   * tab (currentTabId is updated).  When false, the tab is created in the
   * background — the caller's active tab pointer is unchanged.  This is
   * the right choice for temporary tabs that are created and immediately
   * closed (e.g. download_file, fetch_urls) so they don't silently move
   * the active pointer out from under the caller.
   *
   * `owner` tag lets concurrent agents clean up only their own tabs later
   * via close_tabs_by_owner.  Auto-retries on transient browser-closed errors.
   */
  async newTab(
    url?: string,
    owner?: string,
    profileName?: string,
    activate = true,
  ): Promise<{ tabId: number; page: Page }> {
    await this.initialize();
    try {
      return await this._doNewTab(url, owner, profileName, activate);
    } catch (err) {
      if (!isBrowserClosedError(err)) throw err;
      await this.softReset();
      await sleep(2000);
      await this.initialize();
      return await this._doNewTab(url, owner, profileName, activate);
    }
  }

  private async _doNewTab(
    url?: string,
    owner?: string,
    profileName?: string,
    activate = true,
  ): Promise<{ tabId: number; page: Page }> {
    // If a profile is specified, open the tab in that profile's context
    let context = this.browserContext!;
    if (profileName) {
      const profile = this.profiles.get(profileName);
      if (!profile)
        throw new Error(`Profile "${profileName}" not found. Create it with create_profile first.`);
      context = profile.context;
    }
    const page = await context.newPage();
    // Profile tabs get JS-level stealth via addInitScript (set on context creation).
    // HTTP UA in profiles shows HeadlessChrome — acceptable, see createProfile comment.
    const tabId = this.allocateTab(page, owner);
    if (activate) {
      this.currentTabId = tabId;
      // Track per-owner active tab so owner-only resolveTab works
      if (owner) this.ownerActiveTab.set(owner, tabId);
    }
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

  /**
   * Return a snapshot of live tabs grouped by owner. Used by stop_browser
   * safety guards: if other agents still have tabs open, the guard can
   * warn or block. Passing `excludeOwner` omits that owner from the result
   * — e.g. the agent requesting the stop.
   */
  ownersWithLiveTabs(excludeOwner?: string): Array<{ owner: string; tabIds: number[] }> {
    const byOwner = new Map<string, number[]>();
    for (const [id, owner] of this.tabOwners) {
      if (excludeOwner !== undefined && owner === excludeOwner) continue;
      const page = this.tabs.get(id);
      if (page && !page.isClosed()) {
        const list = byOwner.get(owner);
        if (list) list.push(id);
        else byOwner.set(owner, [id]);
      }
    }
    return Array.from(byOwner, ([owner, tabIds]) => ({ owner, tabIds }));
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
    // Clear per-tab dialog state.
    this.dialogPolicy.clear();
    this.lastDialogs.clear();
    this.profiles.clear();
    this.tabToProfile.clear();
    this.tabs.clear();
    this.tabOwners.clear();
    this.tabLastActivity.clear();
    this.tabLastUrl.clear();
    this.ownerActiveTab.clear();
    this.recoveryNotices.clear();
    clearAllSnapshots();
    this.primaryTabId = undefined;
    this.nextTabId = 1;
    this.currentTabId = 1;
    this.browserContext = undefined;
    this.browser = undefined;
    this.consoleLogs = [];
    this.networkEvents = [];
    this.nextNetworkEventId = 1;
    this.initialized = false;
  }

  /** Close a tab by ID (default: current). Switches to nearest remaining tab. */
  async closeTab(tabId?: number): Promise<void> {
    const id = tabId ?? this.currentTabId;
    const page = this.tabs.get(id);
    if (!page) throw new Error(`Tab ${id} does not exist.`);
    if (id === this.primaryTabId) {
      throw new Error(
        `Tab ${id} is the primary tab and cannot be closed. Closing it would poison Steel's session (page_refresh failure). Use stop_browser to end the session instead.`,
      );
    }

    // Run bookkeeping BEFORE page.close() so the close-event listener
    // (registered by allocateTab) doesn't race ahead and delete entries
    // before the fallback logic can repair ownerActiveTab pointers.
    this.tabs.delete(id);
    this.tabOwners.delete(id);
    this.tabLastActivity.delete(id);
    clearSnapshot(id);

    // Clean up ownerActiveTab entries pointing at the closed tab.
    // For each owner whose active tab was this one, fall back to that
    // owner's most-recently-touched surviving tab; delete the entry if
    // no tabs remain.
    for (const [owner, activeId] of this.ownerActiveTab) {
      if (activeId === id) {
        let bestId: number | undefined;
        let bestTime = 0;
        for (const [tid, last] of this.tabLastActivity) {
          if (this.tabOwners.get(tid) === owner && last > bestTime) {
            const p = this.tabs.get(tid);
            if (p && !p.isClosed()) {
              bestId = tid;
              bestTime = last;
            }
          }
        }
        if (bestId !== undefined) {
          this.ownerActiveTab.set(owner, bestId);
        } else {
          this.ownerActiveTab.delete(owner);
        }
      }
    }

    // Clean up profile membership
    const profileName = this.tabToProfile.get(id);
    if (profileName) {
      this.tabToProfile.delete(id);
      const profile = this.profiles.get(profileName);
      if (profile) profile.tabIds.delete(id);
    }

    // Clear per-tab dialog policy and last dialog record.
    this.dialogPolicy.delete(id);
    this.lastDialogs.delete(id);

    // Fire the actual page close — the allocateTab listener will run its
    // own cleanup as a safety net (no-op since entries already deleted).
    await page.close().catch(() => {});

    // If we closed the active tab, switch to the highest remaining tab.
    if (id === this.currentTabId) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.currentTabId = remaining[remaining.length - 1];
      }
      // If no tabs remain, next getPage() will open a fresh one.
    }
  }

  /** Return a snapshot of all open tabs, including owner tags and idle age. */
  async listTabs(): Promise<
    {
      tabId: number;
      url: string;
      title: string;
      active: boolean;
      owner?: string;
      profile?: string;
      idleSeconds: number;
    }[]
  > {
    await this.initialize();
    const now = Date.now();
    const openTabs = Array.from(this.tabs).filter(([, page]) => !page.isClosed());

    // Fetch all titles in parallel — each wrapped to handle closed pages.
    const titlePromises = openTabs.map(([, page]) => page.title().catch(() => "<unavailable>"));
    const titles = await Promise.all(titlePromises);

    const result: {
      tabId: number;
      url: string;
      title: string;
      active: boolean;
      owner?: string;
      profile?: string;
      idleSeconds: number;
    }[] = [];
    for (let i = 0; i < openTabs.length; i++) {
      const [id, page] = openTabs[i];
      const lastActivity = this.tabLastActivity.get(id);
      const idleSeconds = lastActivity ? Math.round((now - lastActivity) / 1000) : 0;
      const row: {
        tabId: number;
        url: string;
        title: string;
        active: boolean;
        owner?: string;
        profile?: string;
        idleSeconds: number;
      } = {
        tabId: id,
        url: page.url(),
        title: titles[i],
        active: id === this.currentTabId,
        idleSeconds,
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
        webglRenderer:
          videoCard.renderer ||
          "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        brands: uaData.brands || [
          { brand: "Chromium", version: "130" },
          { brand: "Google Chrome", version: "130" },
        ],
        uaPlatform: uaData.platform || "macOS",
        uaMobile: uaData.mobile || false,
        platformVersion: uaData.platformVersion || "14.5.0",
        architecture: uaData.architecture || "arm",
        bitness: uaData.bitness || "64",
        uaFullVersion: nav.userAgent?.match(/Chrome\/([0-9.]+)/)?.[1] || "130.0.0.0",
      };
    } catch {
      // No unified fingerprint available — use defaults
      fpConfig = {
        platform: "MacIntel",
        vendor: "Google Inc.",
        deviceMemory: 8,
        hardwareConcurrency: 10,
        maxTouchPoints: 0,
        languages: ["en-ZA", "en"],
        webglVendor: "Google Inc. (Apple)",
        webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        brands: [
          { brand: "Chromium", version: "130" },
          { brand: "Google Chrome", version: "130" },
        ],
        uaPlatform: "macOS",
        uaMobile: false,
        platformVersion: "14.5.0",
        architecture: "arm",
        bitness: "64",
        uaFullVersion: "130.0.0.0",
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
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
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
      viewport: {
        width: this.env.DEFAULT_VIEWPORT_WIDTH,
        height: this.env.DEFAULT_VIEWPORT_HEIGHT,
      },
    });

    // Inject stealth overrides (extensions don't work in non-default contexts)
    await this.injectStealthIntoContext(context);
    // Settle detection for profile pages
    await context.addInitScript(SETTLE_INIT_SCRIPT);

    // Wire network + popup capture on profile contexts so profile tabs get
    // the same request/response and new-page tracking as the default context.
    this._wireNetworkCapture(context);
    this._wirePopupCapture(context);

    const page = await context.newPage();

    const tabId = this.allocateTab(page);
    this.currentTabId = tabId;

    const profile = { context, tabIds: new Set([tabId]) };
    this.profiles.set(name, profile);
    this.tabToProfile.set(tabId, name);

    // Restore saved state if it exists
    let restored = false;
    const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
    try {
      const raw = await fs.readFile(savedPath, "utf8");
      const state = JSON.parse(raw) as {
        cookies?: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires?: number;
          httpOnly?: boolean;
          secure?: boolean;
          sameSite?: "Strict" | "Lax" | "None";
        }>;
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
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
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
    const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, JSON.stringify(state, null, 2));

    // Return summary for LLM context
    const lsDomains = Object.keys(localStorage);
    const cookieDomains = [...new Set(cookies.map((c) => c.domain))];
    const summary = [savedPath];
    summary.push(
      `  ${cookies.length} cookie(s)${cookieDomains.length ? ` from ${cookieDomains.join(", ")}` : ""}`,
    );
    if (lsDomains.length) summary.push(`  localStorage from ${lsDomains.join(", ")}`);
    return summary.join("\n");
  }

  /**
   * List all active profiles + any saved profiles on disk.
   */
  async listProfiles(): Promise<
    Array<{ name: string; active: boolean; tabCount: number; savedAt?: string }>
  > {
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
      const dir = this.env.PROFILES_DIR;
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
            } catch {
              /* */
            }
          }
          continue;
        }
        let savedAt: string | undefined;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          const state = JSON.parse(raw);
          savedAt = state.savedAt;
        } catch {
          /* */
        }
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
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
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
        } catch {
          /* */
        }
      }
      // Close the context
      await profile.context.close().catch(() => {});
      this.profiles.delete(name);
    }

    if (removeSaved) {
      const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
      await fs.unlink(savedPath).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Dialog management — per-tab policy + last dialog record
  // ---------------------------------------------------------------------------

  /**
   * Arm a dialog policy for a tab. Dialogs raised by the next action(s) on
   * this tab will be accepted/dismissed immediately as they fire. once=true
   * removes the policy after it is applied once, reverting to the default.
   */
  setDialogPolicy(
    tabId: number,
    policy: { action: "accept" | "dismiss"; promptText?: string; once?: boolean },
  ): void {
    this.dialogPolicy.set(tabId, policy);
  }

  /**
   * Return the armed dialog policy for a tab, or undefined if no policy is set
   * (the default is dismiss).
   */
  getDialogPolicy(
    tabId: number,
  ): { action: "accept" | "dismiss"; promptText?: string; once?: boolean } | undefined {
    return this.dialogPolicy.get(tabId);
  }

  /**
   * Return the last dialog record for a tab, or null if none.
   */
  getLastDialog(tabId: number): {
    type: string;
    message: string;
    defaultValue: string;
    action: "accepted" | "dismissed";
    promptText?: string;
    autoHandled: boolean;
    reported: boolean;
    at: number;
  } | null {
    const d = this.lastDialogs.get(tabId);
    if (!d) return null;
    return { ...d };
  }

  /**
   * Return a dialog-status notice string for action-tool output.
   * Reports the last auto-handled dialog once, within a 5-second window of
   * when it fired, so the just-completed action can mention it. Empty string
   * when there is nothing to report.
   */
  dialogNotice(tabId: number): string {
    const last = this.lastDialogs.get(tabId);
    if (last && last.autoHandled && !last.reported && Date.now() - last.at < 5000) {
      last.reported = true;
      const actionWord = last.action === "accepted" ? "accepted" : "dismissed";
      return `\n⚠ dialog appeared: ${last.type} "${last.message}" — auto-${actionWord}. (Pre-set behavior with handle_dialog before the action to change it.)`;
    }
    return "";
  }

  async stop() {
    if (this.steelClient && this.sessionId) {
      try {
        await this.steelClient.sessions.release(this.sessionId);
      } catch (err) {
        console.error(`Failed to release Steel session ${this.sessionId}:`, (err as Error).message);
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
    this.tabLastUrl.clear();
    this.ownerActiveTab.clear();
    this.dialogPolicy.clear();
    this.lastDialogs.clear();
    this.recoveryNotices.clear();
    this.primaryTabId = undefined;
    this.nextTabId = 1;
    this.currentTabId = 1;
    this.consoleLogs = [];
    this.networkEvents = [];
    this.nextNetworkEventId = 1;
    this.debugUrl = undefined;
    this.sessionViewerUrl = undefined;
    clearAllSnapshots();
    this.initialized = false;
  }
}
