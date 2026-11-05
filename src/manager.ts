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
import {
  withProfileWrite,
  readProfileData,
  httpOrigin,
  writeProfileData,
  removeProfileData,
  profileRevision,
  mergeProfileData,
} from "./profile-store.js";
import path from "path";
import { sleep } from "./utils.js";

import { chromium, Browser, BrowserContext, Page, Request, Response } from "patchright";
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
    public readonly caller: string | undefined,
  ) {
    const who =
      caller !== undefined
        ? `you are "${caller}"`
        : `you passed no owner. Pass owner:"${tabOwner}" or force:true.`;
    super(
      `Tab ${tabId} belongs to owner "${tabOwner}" — ${who}. ` +
        `Pass force:true to override, or target your own tab.`,
    );
    this.name = "TabOwnershipError";
  }
}

/**
 * Tab route — a pattern+owner pair tracked in the per-tab route registry.
 * Closed over by addRoute for tear-down on tab close or removeRoutes.
 */
export interface TabRoute {
  pattern: string;
  owner: string;
  unroute: () => Promise<void>;
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
  private initializing: Promise<void> | undefined;
  private laneContext = false;
  private laneProfileName?: string;
  private laneClosed = false;
  private lanesEnabled = false;
  private allocateId: (() => number) | undefined;
  private onTabCreated: ((tabId: number) => void) | undefined;
  private sessionEnded = false;
  private sessionEndListeners = new Set<() => void>();
  private watchedBrowsers = new WeakSet<Browser>();

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
  private profileVersions = new Map<string, number>();
  private tabToProfile: Map<number, string> = new Map(); // tabId → profileName

  // Tracks pages → tabIds for idempotent allocation. A context.on("page")
  // listener fires for ALL new pages including our own context.newPage()
  // calls — if allocateTab didn't deduplicate, every newTab/createProfile
  // page would be registered twice.
  private pageToTabId = new WeakMap<Page, number>();

  // Request interception — per-tab route registry, tab-scoped and
  // owner-tagged. Routes are registered via page.route() (never
  // context.route, which would poison every owner's tabs).
  private tabRoutes = new Map<number, TabRoute[]>();

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
  // Response bodies are kept via WeakRef so busy pages cannot pin hundreds of
  // full Response objects in memory; the map entry is deleted on eviction/stop.
  private networkEvents: NetworkEvent[] = [];
  private nextNetworkEventId = 1;
  private requestStartTimes = new WeakMap<Request, number>();
  private responsesById = new Map<number, WeakRef<Response>>();
  private wiredNetworkContexts = new WeakSet<BrowserContext>();

  // Last known URL per tab, used by crash recovery to re-navigate after a
  // page is detected as closed/crashed.
  private tabLastUrl = new Map<number, string>();

  // One-shot notices appended to the next tool result for a recovered tab.
  private recoveryNotices = new Map<number, string>();

  constructor(private readonly env: Env) {}

  enableLanes(): void {
    this.lanesEnabled = true;
  }

  onSessionEnded(listener: () => void): () => void {
    this.sessionEndListeners.add(listener);
    return () => {
      this.sessionEndListeners.delete(listener);
    };
  }

  private watchBrowser(): void {
    const browser = this.browser;
    if (!this.lanesEnabled || !browser || this.watchedBrowsers.has(browser)) return;
    this.watchedBrowsers.add(browser);
    const disconnected = () => {
      if (this.browser !== browser) return;
      this.sessionEnded = true;
      this.initialized = false;
      this.browser = undefined;
      this.browserContext = undefined;
      this.primaryTabId = undefined;
      for (const id of this.tabIds) this.clearTabState(id);
      this.consoleLogs = [];
      this.networkEvents = [];
      this.responsesById.clear();
      for (const listener of this.sessionEndListeners) listener();
    };
    browser.once("disconnected", disconnected);
    if (!browser.isConnected()) disconnected();
  }

  hasTab(id: number): boolean {
    return this.tabs.has(id);
  }

  get tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  async createLane(
    allocateId: () => number,
    onTabCreated?: (tabId: number) => void,
  ): Promise<BrowserManager> {
    await this.initialize();
    const browser = this.browser;
    if (!browser?.isConnected()) throw new Error("lane_closed: shared browser session ended.");
    const context = await browser.newContext({
      viewport: {
        width: this.env.DEFAULT_VIEWPORT_WIDTH,
        height: this.env.DEFAULT_VIEWPORT_HEIGHT,
      },
    });
    if (browser !== this.browser || !browser.isConnected()) {
      await context.close().catch(() => {});
      throw new Error("lane_closed: shared browser session ended during lane startup.");
    }
    const lane = new BrowserManager(this.env);
    lane.browser = this.browser;
    lane.browserContext = context;
    lane.laneContext = true;
    lane.allocateId = allocateId;
    lane.onTabCreated = onTabCreated;
    lane.currentTabId = 0;
    lane.initialized = true;
    lane.debugUrl = this.debugUrl;
    lane.sessionViewerUrl = this.sessionViewerUrl;
    lane._wireNetworkCapture(context);
    lane._wirePopupCapture(context);
    context.on("close", () => {
      lane.laneClosed = true;
    });
    return lane;
  }

  get isLaneClosed(): boolean {
    return this.laneClosed;
  }

  get isLaneContext(): boolean {
    return this.laneContext;
  }

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
   * Return the owner string for `tabId`, or undefined if the tab is unknown
   * or unowned. Public surface so tool handlers (e.g. get_network's
   * cross-tab body gate) can ask without reaching into private state.
   */
  getTabOwner(tabId: number): string | undefined {
    return this.tabOwners.get(tabId);
  }

  /**
   * Register a page-scoped route handler for a tab. Routes are scoped to
   * the individual page (never context.route — that would poison every
   * owner's tabs) and tagged with the owning agent so clearTabState
   * teardown and closeTabsByOwner can clean them up.
   */
  async addRoute(
    tabId: number,
    owner: string,
    pattern: string,
    handler: (route: import("patchright").Route) => Promise<void>,
  ): Promise<void> {
    const page = this.tabs.get(tabId);
    if (!page) throw new Error(`No tab ${tabId}`);
    await page.route(pattern, handler);
    const list = this.tabRoutes.get(tabId) ?? [];
    list.push({ pattern, owner, unroute: () => page.unroute(pattern, handler) });
    this.tabRoutes.set(tabId, list);
  }

  /**
   * List active routes for a tab — used by the intercept tool's `list` action.
   */
  listRoutes(tabId: number): { pattern: string; owner: string }[] {
    return (this.tabRoutes.get(tabId) ?? []).map(({ pattern, owner }) => ({
      pattern,
      owner,
    }));
  }

  /**
   * Remove routes for a tab. When `pattern` is given, only routes matching
   * that pattern are removed; otherwise all routes for the tab are dropped.
   * Returns the number of routes removed.
   */
  async removeRoutes(tabId: number, pattern?: string): Promise<number> {
    const list = this.tabRoutes.get(tabId) ?? [];
    const drop = list.filter((r) => !pattern || r.pattern === pattern);
    const keep = pattern ? list.filter((r) => r.pattern !== pattern) : [];
    for (const r of drop) {
      try {
        await r.unroute();
      } catch {
        /* page may be gone */
      }
    }
    if (keep.length) this.tabRoutes.set(tabId, keep);
    else this.tabRoutes.delete(tabId);
    return drop.length;
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
    if (this.laneContext) {
      if (this.laneClosed)
        throw new Error("lane_closed: context closed; open a fresh lane without a tabId.");
      const id = opts.tabId ?? this.currentTabId;
      if (!this.tabs.has(id)) throw new Error("lane_closed: tab is no longer available.");
      return id;
    }
    // Explicit tabId + ownership enforcement
    if (opts.tabId !== undefined) {
      const tabOwner = this.tabOwners.get(opts.tabId);
      // Owner-isolation: if the tab has an owner, the caller MUST present the
      // matching owner (or force). Omitting owner on an owned tab is treated as
      // cross-owner (we cannot distinguish the real owner who forgot from an
      // attacker), so it is denied. Closes the tabId-no-owner bypass across
      // every tool that resolves a tab through here.
      if (tabOwner !== undefined && !opts.force && opts.owner !== tabOwner) {
        throw new TabOwnershipError(opts.tabId, tabOwner, opts.owner);
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

    const id = this.allocateId ? this.allocateId() : this.nextTabId++;
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
        // dialog does not wedge the tab permanently. Only log when the
        // fallback dismiss ALSO fails (i.e. the dialog is truly stuck) —
        // a known accept-throw under policy=accept is expected, the
        // dismiss fallback handles it, and operators don't need a
        // console.error for the expected path (which also keeps the gate
        // output pristine).
        try {
          await dialog.dismiss();
        } catch (fallbackErr) {
          console.error(
            `[steel-mcp] dialog handler error for tab ${id}: accept threw (${(err as Error).message}) AND dismiss fallback failed (${(fallbackErr as Error).message}); dialog may wedge the tab.`,
          );
        }
      }
    });

    page.on("close", () => {
      // Ignore close events from a page that was replaced by crash recovery
      // so the new page's registry entry isn't wiped out.
      if (this.tabs.get(id) !== page) return;
      this.clearTabState(id);
    });

    // Settle-counter injection. MUST NOT use page/context.addInitScript:
    // patchright implements addInitScript via an internal catch-all
    // route('**/*') document-interception (installInjectRoute), which breaks
    // EVERY page-context WebSocket upgrade (ws:// and wss://) — patchright
    // issue #31, upstream wontfix. Instead we (re)inject SETTLE_INIT_SCRIPT via
    // page.evaluate on each document load. Use the main world because
    // waitForFunction polls there. Evaluation installs no request route.
    // WebSockets work and the counter is visible to the poll. The script
    // is idempotent (early-returns if window.__steelSettle already exists).
    page.on("domcontentloaded", () => {
      if (this.tabs.get(id) !== page) return;
      page.evaluate(SETTLE_INIT_SCRIPT, undefined, undefined, false).catch(() => {
        // best-effort: navigation may destroy the context mid-eval; settle is
        // a nicety and waitForSettled no-ops when the counter is absent.
      });
    });
  }

  /**
   * Recreate a tab in-place: open a fresh page, swap it into the registry
   * under the same tabId, re-wire listeners, and re-navigate to the last known
   * URL. Sets a one-shot recovery notice for the tab.
   *
   * Owner / per-owner-active / profile / dialog metadata is *preserved*
   * across recovery — the recovery path is a page-replacement, not a
   * tab-disposal. softReset() is destructive and DOES drop owner state
   * (browser death means no surviving tabs to keep track of).
   */
  private async _recoverTab(tabId: number): Promise<Page> {
    // Snapshot metadata BEFORE any allocation so the replacement page can
    // inherit it even when the allocation path triggers a transient-id
    // remap that overwrites the original tabId's owner.
    const priorOwner = this.tabOwners.get(tabId);
    const priorProfile = this.tabToProfile.get(tabId);
    const replacePage = async (page: Page): Promise<Page> => {
      const oldPage = this.tabs.get(tabId);
      if (oldPage) this.pageToTabId.delete(oldPage);

      // Route the replacement page through the idempotent allocation path.
      // The context "page" listener fires for context.newPage() too, so it
      // may have already registered this page under a transient tabId. Using
      // allocateTab merges that registration; we then remap to the original
      // tabId and drop any transient entry so the registry stays coherent.
      const allocatedId = this.allocateTab(page, priorOwner);
      if (allocatedId !== tabId) {
        this.tabs.delete(allocatedId);
        this.tabOwners.delete(allocatedId);
        this.tabLastActivity.delete(allocatedId);
      }

      this.tabs.set(tabId, page);
      this.pageToTabId.set(page, tabId);
      this.tabLastActivity.set(tabId, Date.now());
      // Restore owner / profile metadata — allocateTab may have set owner
      // on the transient id; we copy it back onto the original tabId and
      // repair ownerActiveTab if the cached pointer was dropped.
      if (priorOwner !== undefined) this.tabOwners.set(tabId, priorOwner);
      if (priorProfile !== undefined) {
        this.tabToProfile.set(tabId, priorProfile);
        const profile = this.profiles.get(priorProfile);
        if (profile && !profile.tabIds.has(tabId)) profile.tabIds.add(tabId);
      }
      if (priorOwner !== undefined && this.ownerActiveTab.get(priorOwner) === undefined) {
        this.ownerActiveTab.set(priorOwner, tabId);
      }
      // allocateTab already wired console listeners; re-wire page-specific
      // listeners so they reference the original tabId (the transient-id
      // listeners will ignore events once the transient entry is gone).
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
      // Browser death: every tab is dead too — softReset clears all owner
      // state by design (no surviving tabs to keep track of). The caller
      // will re-create the requested tab on the fresh context.
      await this.softReset();
      await sleep(2000);
      await this.initialize();
      const newPage = await this.browserContext!.newPage();
      return await replacePage(newPage);
    }
  }

  /**
   * Single-source per-tab cleanup. Drops every per-tab map entry that
   * belongs to `id` — tabs, owners, activity, lastUrl, recoveryNotices,
   * pageToTabId, dialogPolicy, lastDialogs, snapshot store, profile
   * membership, and any ownerActiveTab pointer that pointed here.
   *
   * Called from:
   *   - closeTab (manual close)
   *   - the page.on("close") listener (Playwright-driven close)
   *   - softReset / stop (full teardown — loops every id through this)
   *
   * Centralizing keeps the close-listener path and the manual-close path
   * in lockstep so cleanup parity can't drift.
   */
  private clearTabState(id: number): void {
    const page = this.tabs.get(id);

    this.tabs.delete(id);
    this.tabOwners.delete(id);
    this.tabLastActivity.delete(id);
    this.tabLastUrl.delete(id);
    this.recoveryNotices.delete(id);
    this.dialogPolicy.delete(id);
    this.lastDialogs.delete(id);
    this.tabRoutes.delete(id);
    if (page) this.pageToTabId.delete(page);

    clearSnapshot(id);

    for (const [o, activeId] of this.ownerActiveTab) {
      if (activeId === id) this.ownerActiveTab.delete(o);
    }

    const profileName = this.tabToProfile.get(id);
    if (profileName) {
      this.tabToProfile.delete(id);
      const profile = this.profiles.get(profileName);
      if (profile) profile.tabIds.delete(id);
    }
  }

  /**
   * Return true if a page reference is unusable (closed or detached/crashed).
   * `page.isClosed()` is free. `page.url()` is synchronous and throws on a
   * detached/crashed target, so it adds no healthy-path CDP round-trip.
   */
  private isPageDead(page?: Page): boolean {
    if (!page || page.isClosed()) return true;
    try {
      page.url();
      return false;
    } catch {
      return true;
    }
  }

  /** Start the idle sweeper. Idempotent; no-op if TAB_IDLE_TIMEOUT_MS=0. */
  private startIdleSweeper(): void {
    if (this.lanesEnabled || this.laneContext) return;
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
    if (this.lanesEnabled || this.laneContext) return [];
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
    // Settle detection is injected per-page via a domcontentloaded listener
    // in attachPageListeners (NOT addInitScript — that breaks WebSockets under
    // patchright; see the listener comment). The first page is wired below.
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
    if (this.laneClosed)
      throw new Error("lane_closed: context closed; open a fresh lane without a tabId.");
    if (this.initializing) return this.initializing;
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.initializeBrowser().finally(() => {
        this.initializing = undefined;
      });
    }
    return this.initializing;
  }

  private async initializeBrowser(): Promise<void> {
    if (this.sessionEnded) {
      if (this.steelClient && this.sessionId) {
        await this.steelClient.sessions.release(this.sessionId).catch(() => {});
      }
      this.steelClient = undefined;
      this.sessionId = undefined;
      this.debugUrl = undefined;
      this.sessionViewerUrl = undefined;
      this.sessionEnded = false;
    }

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
      // Prefer the real system Chrome (patchright best practice for stealth:
      // channel:"chrome" + headless:false + no custom UA). Fall back to
      // bundled Chromium if the channel isn't installed on this host.
      try {
        this.browser = await chromium.launch({ headless: false, channel: "chrome" });
      } catch {
        this.browser = await chromium.launch({ headless: false });
      }
      this.browserContext = await this.browser.newContext({
        viewport: {
          width: this.env.DEFAULT_VIEWPORT_WIDTH,
          height: this.env.DEFAULT_VIEWPORT_HEIGHT,
        },
      });
      // Settle detection is injected per-page via the domcontentloaded
      // listener in attachPageListeners (NOT addInitScript — breaks WebSockets
      // under patchright).
      const initialPage = await this.browserContext.newPage();
      this.currentTabId = this.allocateTab(initialPage);
      // Mark primary — consistency with steel mode, and protects the only
      // viewport-ready page from being swept.
      this.primaryTabId = this.currentTabId;
    }

    this.initialized = true;
    this.watchBrowser();
    if (this.lanesEnabled && !this.browser)
      throw new Error("lane_closed: session ended during browser startup.");

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

        const event = {
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
        };
        this.pushNetworkEvent(event);
        this.responsesById.set(event.id, new WeakRef(response));
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
        this.responsesById.delete(e.id);
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
   * has been evicted or the WeakRef Response was collected.
   */
  async getResponseBody(id: number): Promise<string> {
    const event = this.networkEvents.find((e) => e.id === id);
    if (!event) {
      throw new Error("body no longer available");
    }
    const ref = this.responsesById.get(id);
    const response = ref?.deref();
    if (!response) {
      throw new Error("body no longer available");
    }
    const body = await response.body();
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
    if (
      this.laneContext &&
      this.tabs.size === 0 &&
      (arg === undefined || (typeof arg === "object" && arg.tabId === undefined))
    ) {
      return (await this.newTab()).page;
    }

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
      if (!page || this.isPageDead(page)) {
        const recovered = await this._recoverTab(resolved);
        if (this.isPageDead(recovered)) {
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
    if (!this.isPageDead(page)) {
      this.touchTab(this.currentTabId);
      this.tabLastUrl.set(this.currentTabId, page!.url());
      return page!;
    }

    // Current tab missing or closed/crashed — recreate in-place and retry once.
    const recovered = await this._recoverTab(this.currentTabId);
    if (this.isPageDead(recovered)) {
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
      this.assertLaneProfile(profileName);
      if (this.laneContext && !this.profiles.has(profileName)) {
        const previousTab = this.currentTabId;
        const { tabId } = await this.createProfile(profileName, url);
        if (!activate) this.currentTabId = previousTab;
        const page = this.tabs.get(tabId)!;
        if (owner) this.tabOwners.set(tabId, owner);
        return { tabId, page };
      }
      const profile = this.profiles.get(profileName);
      if (!profile)
        throw new Error(`Profile "${profileName}" not found. Create it with create_profile first.`);
      context = profile.context;
    }
    const page = await context.newPage();
    const tabId = this.allocateTab(page, owner);
    this.onTabCreated?.(tabId);
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
    if (this.laneContext) {
      this.laneClosed = true;
      throw new Error("lane_closed: browser context lost; open a fresh lane without a tabId.");
    }
    if (this.idleSweeperHandle) {
      clearInterval(this.idleSweeperHandle);
      this.idleSweeperHandle = undefined;
    }
    // Close all profile contexts (prevents leaked BrowserContexts)
    for (const [, profile] of this.profiles) {
      await profile.context.close().catch(() => {});
    }
    // Loop every live tab through the same per-tab cleanup helper that
    // closeTab + the close-listener use — guarantees cleanup parity
    // across all teardown paths. Array.from snapshots the keys because
    // clearTabState mutates the map mid-iteration.
    for (const id of Array.from(this.tabs.keys())) {
      this.clearTabState(id);
    }
    this.profiles.clear();
    this.tabToProfile.clear();
    this.dialogPolicy.clear();
    this.lastDialogs.clear();
    this.ownerActiveTab.clear();
    clearAllSnapshots();
    this.primaryTabId = undefined;
    this.nextTabId = 1;
    this.currentTabId = 1;
    this.browserContext = undefined;
    this.browser = undefined;
    this.consoleLogs = [];
    // Network buffer intentionally survives softReset — it is session telemetry.
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

    // Snapshot the per-owner active-tab pointers that point at this tab
    // BEFORE cleanup runs — we need them to repair each owner's active
    // pointer to the most-recently-touched surviving tab.
    const ownersToRepair: string[] = [];
    for (const [owner, activeId] of this.ownerActiveTab) {
      if (activeId === id) ownersToRepair.push(owner);
    }

    // Centralized per-tab cleanup — wipes every per-tab map entry. Runs
    // before page.close() so the close-listener (also routing through
    // clearTabState) becomes a no-op safety net rather than a duplicate.
    this.clearTabState(id);

    // Repair ownerActiveTab pointers: for each owner whose active tab was
    // this one, fall back to that owner's most-recently-touched surviving
    // tab; delete the entry if no tabs remain.
    for (const owner of ownersToRepair) {
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
  async createProfile(name: string, url?: string): Promise<{ tabId: number; restored: boolean }> {
    await this.initialize();
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
    this.assertLaneProfile(name);
    if (this.profiles.has(name)) {
      if (this.laneContext) {
        const { tabId } = await this.newTab(url, undefined, name);
        return { tabId, restored: false };
      }
      throw new Error(`Profile "${name}" already exists. Use delete_profile first.`);
    }
    if (this.laneContext) this.laneProfileName = name;
    // The Steel image enables extension access in incognito contexts.
    // A second init script would conflict with that fingerprint and break WebSockets.
    const context = this.laneContext
      ? this.browserContext!
      : await this.browser!.newContext({
          viewport: {
            width: this.env.DEFAULT_VIEWPORT_WIDTH,
            height: this.env.DEFAULT_VIEWPORT_HEIGHT,
          },
        });

    // Settle detection for profile pages is injected per-page via the
    // domcontentloaded listener in attachPageListeners (NOT addInitScript —
    // breaks WebSockets under patchright; see that listener's comment).

    // Wire network + popup capture on profile contexts so profile tabs get
    // the same request/response and new-page tracking as the default context.
    if (!this.laneContext) {
      this._wireNetworkCapture(context);
      this._wirePopupCapture(context);
    }

    const page = await context.newPage();

    const tabId = this.allocateTab(page);
    this.onTabCreated?.(tabId);
    this.currentTabId = tabId;

    const profile = { context, tabIds: new Set([tabId]) };
    this.profiles.set(name, profile);
    this.tabToProfile.set(tabId, name);

    // Restore saved state if it exists
    let restored = false;
    const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
    this.profileVersions.set(name, profileRevision(savedPath));
    try {
      const { state, revision } = await withProfileWrite(savedPath, async () => ({
        state: await readProfileData(savedPath, false, this.env.CREDENTIALS_PASSPHRASE),
        revision: profileRevision(savedPath),
      }));
      this.profileVersions.set(name, revision);
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
        restored = true;
      }
      if (this.laneContext && state.localStorage) {
        await this.applyProfileUpdated(name);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.profiles.delete(name);
        this.tabToProfile.delete(tabId);
        await page.close().catch(() => {});
        if (!this.laneContext) await context.close().catch(() => {});
        throw error;
      }
    }

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return { tabId, restored };
  }

  assertLaneProfile(name: string): void {
    if (this.laneContext && this.laneProfileName && this.laneProfileName !== name)
      throw new Error(
        `lane_profile_conflict: lane holds profile "${this.laneProfileName}". Use close_lane or another lane.`,
      );
  }

  hasProfile(name: string): boolean {
    return (
      (!this.laneContext || this.laneProfileName === name) &&
      this.profiles.has(name) &&
      this.initialized &&
      !this.laneClosed &&
      this.browser?.isConnected() === true
    );
  }

  async applyProfileUpdated(name: string): Promise<boolean> {
    if (!this.hasProfile(name)) return false;
    const profile = this.profiles.get(name)!;
    const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
    const { state, revision } = await withProfileWrite(savedPath, async () => ({
      state: await readProfileData(savedPath, false, this.env.CREDENTIALS_PASSPHRASE),
      revision: profileRevision(savedPath),
    }));
    if (!this.hasProfile(name) || this.profiles.get(name) !== profile) return false;
    if (state.cookies?.length) await profile.context.addCookies(state.cookies);
    for (const [origin, entries] of Object.entries(state.localStorage ?? {})) {
      const existing = profile.context.pages().find((page) => {
        try {
          return new URL(page.url()).origin === origin;
        } catch {
          return false;
        }
      });
      const page = existing ?? (await profile.context.newPage());
      try {
        if (!existing) {
          // Use a local response to prevent a network request from the temporary page.
          await page.route("**/*", (route) =>
            route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "<!doctype html><title></title>",
            }),
          );
          await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 5000 });
        }
        if (!this.hasProfile(name) || this.profiles.get(name) !== profile) return false;
        await page.evaluate(
          ({ expected, values }) => {
            if (location.origin !== expected) throw new Error("profile_origin_changed");
            for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
          },
          { expected: origin, values: entries },
        );
      } finally {
        if (!existing) await page.close().catch(() => {});
      }
    }
    this.profileVersions.set(name, revision);
    return true;
  }

  /**
   * Save a profile's cookies + localStorage to disk as JSON.
   * Read localStorage from open HTTP and HTTPS pages.
   */
  async saveProfile(name: string): Promise<string> {
    this.assertLaneProfile(name);
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`Profile "${name}" is not active.`);
    const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
    const state = await withProfileWrite(savedPath, async () => {
      const cookies = await profile.context.cookies();

      // Read localStorage only from open HTTP and HTTPS pages.
      const localStorage: Record<string, Record<string, string>> = {};
      if (this.laneContext) {
        const snapshot = await profile.context.storageState();
        for (const origin of snapshot.origins) {
          if (httpOrigin(origin.origin) === origin.origin)
            localStorage[origin.origin] = Object.fromEntries(
              origin.localStorage.map(({ name, value }) => [name, value]),
            );
        }
      }
      for (const tabId of profile.tabIds) {
        const page = this.tabs.get(tabId);
        if (!page || page.isClosed()) continue;
        try {
          // A page can have storage without an HTTP or HTTPS URL.
          const origin = httpOrigin(page.url());
          if (origin === undefined) continue;
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

      const disk = await readProfileData(savedPath, true, this.env.CREDENTIALS_PASSPHRASE);
      const stale = (this.profileVersions.get(name) ?? 0) !== profileRevision(savedPath);
      // A newer file can contain state that this context has not received.
      const snapshot = { cookies, localStorage };
      const merged = stale ? mergeProfileData(snapshot, disk) : mergeProfileData(disk, snapshot);
      merged.savedAt = new Date().toISOString();
      await writeProfileData(savedPath, merged, this.env.CREDENTIALS_PASSPHRASE);
      if (!stale) this.profileVersions.set(name, profileRevision(savedPath));
      return merged;
    });
    const cookies = state.cookies ?? [];
    const localStorage = state.localStorage ?? {};

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
    Array<{
      name: string;
      active: boolean;
      tabCount: number;
      savedAt?: string;
      leaseHolder?: string;
      leaseAgeSeconds?: number;
    }>
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
        if (!f.endsWith(".json") || !isValidProfileName(f.slice(0, -5))) continue;
        const name = f.replace(".json", "");
        if (this.profiles.has(name)) {
          // Already in the active list — add savedAt
          const existing = result.find((r) => r.name === name);
          if (existing) {
            try {
              const state = await readProfileData(
                path.join(dir, f),
                false,
                this.env.CREDENTIALS_PASSPHRASE,
              );
              existing.savedAt = typeof state.savedAt === "string" ? state.savedAt : undefined;
            } catch {
              /* */
            }
          }
          continue;
        }
        let savedAt: string | undefined;
        try {
          const state = await readProfileData(
            path.join(dir, f),
            false,
            this.env.CREDENTIALS_PASSPHRASE,
          );
          savedAt = typeof state.savedAt === "string" ? state.savedAt : undefined;
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
    this.assertLaneProfile(name);
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
      );
    }
    const profile = this.profiles.get(name);
    if (profile) {
      // Close all tabs in this profile. Route per-tab cleanup through
      // clearTabState (the single-source helper) so this path stays in
      // lockstep with closeTab / softReset / stop — otherwise
      // deleteProfile silently leaks tabLastUrl, recoveryNotices,
      // dialogPolicy, lastDialogs, snapshots, ownerActiveTab pointers,
      // and pageToTabId entries.
      for (const tabId of Array.from(profile.tabIds)) {
        try {
          const page = this.tabs.get(tabId);
          // clearTabState captures the page reference first, then wipes
          // every per-tab map entry. After this returns the page is no
          // longer in the tabs map, so the close-listener becomes a
          // no-op safety net (it checks `this.tabs.get(id) !== page`).
          this.clearTabState(tabId);
          if (page && !page.isClosed()) await page.close().catch(() => {});
        } catch {
          /* */
        }
      }
      // Close the context
      if (!this.laneContext) await profile.context.close().catch(() => {});
      this.profiles.delete(name);
      this.profileVersions.delete(name);
    }

    if (removeSaved) {
      const savedPath = assertSafeProfilePath(name, this.env.PROFILES_DIR);
      await removeProfileData(savedPath);
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
    if (this.laneContext) {
      this.laneClosed = true;
      await this.browserContext?.close().catch(() => {});
      for (const id of this.tabIds) this.clearTabState(id);
      this.profiles.clear();
      this.tabToProfile.clear();
      this.consoleLogs = [];
      this.networkEvents = [];
      this.responsesById.clear();
      this.browserContext = undefined;
      this.browser = undefined;
      this.initialized = false;
      return;
    }
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
    // Centralized per-tab cleanup — covers every live tab.
    // Array.from snapshots the keys because clearTabState mutates the
    // map mid-iteration.
    for (const id of Array.from(this.tabs.keys())) {
      this.clearTabState(id);
    }
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
    this.responsesById.clear();
    this.debugUrl = undefined;
    this.sessionViewerUrl = undefined;
    clearAllSnapshots();
    this.initialized = false;
  }
}
