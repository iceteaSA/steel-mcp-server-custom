/**
 * Unit tests for per-owner active tab tracking + ownership resolution (B1).
 *
 * Does NOT require a browser connection — tests the pure bookkeeping logic
 * of resolveTab, touchTab, closeTab cleanup, and ownersWithLiveTabs.
 * Fake Page objects stub out the Playwright dependency.
 */
import { describe, it, expect } from "bun:test";
import { BrowserManager, TabOwnershipError, NoTabError, type Env } from "../manager.js";
import type { Page } from "playwright";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock env — only field required at runtime by the tab logic is TAB_IDLE_TIMEOUT_MS (0 disables sweeper). */
const mockEnv: Env = {
  BROWSER_MODE: "steel",
  STEEL_API_KEY: undefined,
  STEEL_BASE_URL: "http://localhost:3000",
  MAX_INLINE_BYTES: 512000,
  OUTPUT_DIR: "/tmp/steel-mcp-test",
  DEFAULT_SCREENSHOT_QUALITY: 80,
  DEFAULT_VIEWPORT_WIDTH: 1280,
  DEFAULT_VIEWPORT_HEIGHT: 720,
  GLOBAL_WAIT_SECONDS: 0,
  SESSION_TIMEOUT_MS: 300000,
  OPTIMIZE_BANDWIDTH: false,
  STEEL_PUBLIC_URL: undefined,
  TAB_IDLE_TIMEOUT_MS: 0, // disable sweeper
  TAB_IDLE_SWEEP_INTERVAL_MS: 60000,
  PROFILES_DIR: "/tmp/steel-mcp-test/profiles",
  CREDENTIALS_FILE: "/tmp/steel-mcp-test/credentials.json",
  CREDENTIALS_PASSPHRASE: undefined,
  RELAY_PORT: 0,
  RELAY_SECRET: undefined,
  RELAY_PUBLIC_URL: undefined,
  RELAY_BIND_ADDR: "127.0.0.1",
  TOOLSETS: undefined,
};

/** Minimal EventEmitter so fake pages can drive close events. */
type EventMap = Record<string, Array<(...args: unknown[]) => void>>;

function fakePage(overrides: Partial<Record<string, unknown>> = {}): Page {
  const events: EventMap = {};
  const emit = (event: string, ...args: unknown[]) => {
    const handlers = events[event];
    if (handlers) for (const fn of handlers) fn(...args);
  };
  const page: any = {
    isClosed: () => false,
    // When close() is called, fire the stored "close" handlers — matching
    // the real Playwright behaviour that triggers page.on("close") listeners.
    close: async () => {
      (page.isClosed as () => boolean) = () => true;
      emit("close");
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (events[event] ??= []).push(fn);
    },
    url: () => "about:blank",
    title: async () => "Test",
    // Expose for tests: fire a stored event handler without calling close().
    _emit: (event: string, ...args: unknown[]) => emit(event, ...args),
    ...overrides,
  } as unknown as Page;
  return page;
}

/** Set up a BrowserManager with direct map access for test scaffolding. */
function setupMgr(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr: any = new BrowserManager(mockEnv);
  // Bypass initialize() — we're testing pure bookkeeping, not browser state.
  mgr.tabs = new Map();
  mgr.tabOwners = new Map();
  mgr.tabLastActivity = new Map();
  mgr.ownerActiveTab = new Map();
  mgr.primaryTabId = undefined;
  mgr.currentTabId = 1;
  mgr.nextTabId = 10;
  return mgr;
}

/** Register a live tab with an owner. Returns the assigned tabId.
 *  Mimics allocateTab: stores maps + registers a close-event listener
 *  that cleans up bookkeeping when the tab is closed externally. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addTab(mgr: any, owner?: string, overrides?: Partial<Record<string, unknown>>): number {
  const id = mgr.nextTabId++;
  const page = fakePage(overrides);
  mgr.tabs.set(id, page);
  if (owner) mgr.tabOwners.set(id, owner);
  mgr.tabLastActivity.set(id, Date.now());
  // Allocate-tab-style close listener — identical to the real path in
  // manager.allocateTab. The fake page stores handlers so _emit("close")
  // drives the same cleanup sequence that Playwright would trigger.
  page.on("close", () => {
    mgr.tabs.delete(id);
    mgr.tabOwners.delete(id);
    mgr.tabLastActivity.delete(id);
    for (const [o, activeId] of mgr.ownerActiveTab) {
      if (activeId === id) mgr.ownerActiveTab.delete(o);
    }
    const profileName = mgr.tabToProfile?.get(id);
    if (profileName) {
      mgr.tabToProfile.delete(id);
      mgr.profiles?.get(profileName)?.tabIds?.delete(id);
    }
  });
  return id;
}

// ---------------------------------------------------------------------------
// resolveTab — explicit tabId
// ---------------------------------------------------------------------------

describe("resolveTab — explicit tabId", () => {
  it("returns tabId when no owner check is needed (caller has no owner)", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-b");
    const result = mgr.resolveTab({ tabId: id });
    expect(result).toBe(id);
  });

  it("returns tabId when tab has no owner but caller specifies one", () => {
    const mgr = setupMgr();
    const id = addTab(mgr); // unowned
    const result = mgr.resolveTab({ tabId: id, owner: "agent-a" });
    expect(result).toBe(id);
  });

  it("returns tabId when tab owner matches caller", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-a");
    const result = mgr.resolveTab({ tabId: id, owner: "agent-a" });
    expect(result).toBe(id);
  });

  it("throws TabOwnershipError when tab owner differs from caller and !force", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-b");
    expect(() => mgr.resolveTab({ tabId: id, owner: "agent-a" })).toThrow(TabOwnershipError);
  });

  it("returns tabId when tab owner differs from caller but force:true", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-b");
    const result = mgr.resolveTab({ tabId: id, owner: "agent-a", force: true });
    expect(result).toBe(id);
  });

  it("TabOwnershipError has the right message fields", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-b");
    try {
      mgr.resolveTab({ tabId: id, owner: "agent-a" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e instanceof TabOwnershipError).toBe(true);
      const err = e as TabOwnershipError;
      expect(err.tabId).toBe(id);
      expect(err.tabOwner).toBe("agent-b");
      expect(err.caller).toBe("agent-a");
      expect(err.message).toContain("Pass force:true to override");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTab — owner-only lookup
// ---------------------------------------------------------------------------

describe("resolveTab — owner-only lookup", () => {
  it("returns the ownerActiveTab cached value", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-a");
    mgr.ownerActiveTab.set("agent-a", id);
    // Set a more recent tab to prove resolveTab prefers the cached pointer
    const newer = addTab(mgr, "agent-a");
    mgr.tabLastActivity.set(newer, Date.now() + 1000);
    // Cached pointer (id) should win over recency scan when live
    const result = mgr.resolveTab({ owner: "agent-a" });
    expect(result).toBe(id);
  });

  it("falls back to most-recently-touched surviving tab when cached pointer is stale", () => {
    const mgr = setupMgr();
    const closedId = addTab(mgr, "agent-a");
    mgr.ownerActiveTab.set("agent-a", closedId);
    // Make the cached tab "closed"
    (mgr.tabs.get(closedId) as { isClosed: () => boolean }).isClosed = () => true;

    // Create another tab for same owner — the fallback should pick this one
    const liveId = addTab(mgr, "agent-a");
    mgr.tabLastActivity.set(liveId, Date.now() + 2000);

    const result = mgr.resolveTab({ owner: "agent-a" });
    expect(result).toBe(liveId);
    // Cache should be repaired
    expect(mgr.ownerActiveTab.get("agent-a")).toBe(liveId);
  });

  it("falls back to most-recent even when there are tabs from other owners", () => {
    const mgr = setupMgr();
    // No cached pointer at all
    const otherId = addTab(mgr, "agent-b");
    mgr.tabLastActivity.set(otherId, Date.now() + 5000);
    const myId = addTab(mgr, "agent-a");
    mgr.tabLastActivity.set(myId, Date.now() + 1000);
    const result = mgr.resolveTab({ owner: "agent-a" });
    expect(result).toBe(myId);
  });

  it("throws NoTabError when owner has no tabs at all", () => {
    const mgr = setupMgr();
    addTab(mgr, "agent-b"); // different owner
    expect(() => mgr.resolveTab({ owner: "agent-a" })).toThrow(NoTabError);
  });

  it("throws NoTabError when owner's only tab is closed", () => {
    const mgr = setupMgr();
    const closedId = addTab(mgr, "agent-a");
    (mgr.tabs.get(closedId) as { isClosed: () => boolean }).isClosed = () => true;
    mgr.ownerActiveTab.set("agent-a", closedId);
    expect(() => mgr.resolveTab({ owner: "agent-a" })).toThrow(NoTabError);
  });

  it("NoTabError has the right message", () => {
    const mgr = setupMgr();
    try {
      mgr.resolveTab({ owner: "agent-a" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e instanceof NoTabError).toBe(true);
      const err = e as NoTabError;
      expect(err.owner).toBe("agent-a");
      expect(err.message).toContain("No open tab for owner");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTab — legacy no-owner no-tabId path
// ---------------------------------------------------------------------------

describe("resolveTab — legacy path (no owner, no tabId)", () => {
  it("returns currentTabId", () => {
    const mgr = setupMgr();
    mgr.currentTabId = 42;
    const result = mgr.resolveTab({});
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// touchTab — updates ownerActiveTab
// ---------------------------------------------------------------------------

describe("touchTab", () => {
  it("updates ownerActiveTab when owner is provided", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-a");
    mgr.touchTab(id, "agent-a");
    expect(mgr.ownerActiveTab.get("agent-a")).toBe(id);
  });

  it("does NOT update ownerActiveTab when owner is omitted", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-a");
    mgr.ownerActiveTab.set("agent-a", 999);
    mgr.touchTab(id); // no owner
    expect(mgr.ownerActiveTab.get("agent-a")).toBe(999); // unchanged
  });

  it("does nothing when tabId is not in tabs map", () => {
    const mgr = setupMgr();
    mgr.touchTab(999, "agent-a");
    expect(mgr.ownerActiveTab.has("agent-a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// closeTab — cleanup of ownerActiveTab
// ---------------------------------------------------------------------------

describe("closeTab — ownerActiveTab cleanup", () => {
  it("falls back to owner's next most-recent tab when active tab is closed", async () => {
    const mgr = setupMgr();
    // Primary tab must exist so closeTab doesn't fail on primary-guard
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const tab1 = addTab(mgr, "agent-a");
    mgr.tabLastActivity.set(tab1, 100);
    const tab2 = addTab(mgr, "agent-a");
    mgr.tabLastActivity.set(tab2, 200);
    mgr.ownerActiveTab.set("agent-a", tab1);

    await mgr.closeTab(tab1);
    // tab1 was the active pointer; should fall back to tab2
    expect(mgr.ownerActiveTab.get("agent-a")).toBe(tab2);
  });

  it("deletes owner entry when owner has no remaining tabs after close", async () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const tab1 = addTab(mgr, "agent-a");
    mgr.ownerActiveTab.set("agent-a", tab1);

    await mgr.closeTab(tab1);
    expect(mgr.ownerActiveTab.has("agent-a")).toBe(false);
  });

  // The close-event listener registered by allocateTab (mirrored in addTab)
  // handles cleanup when a page closes externally. These tests fire the
  // event directly — no inline closeTab path — to verify the listener
  // alone produces correct map state.

  it("close event removes ownerActiveTab entry when tab closed externally", () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const tab1 = addTab(mgr, "agent-a");
    mgr.ownerActiveTab.set("agent-a", tab1);

    // External close: fire the event without going through closeTab.
    (mgr.tabs.get(tab1) as any)._emit("close");

    expect(mgr.tabs.has(tab1)).toBe(false);
    expect(mgr.tabOwners.has(tab1)).toBe(false);
    expect(mgr.tabLastActivity.has(tab1)).toBe(false);
    expect(mgr.ownerActiveTab.has("agent-a")).toBe(false);
  });

  it("close event does not disturb other owners' entries", () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const tabA = addTab(mgr, "agent-a");
    const tabB = addTab(mgr, "agent-b");
    mgr.ownerActiveTab.set("agent-a", tabA);
    mgr.ownerActiveTab.set("agent-b", tabB);

    (mgr.tabs.get(tabA) as any)._emit("close");

    // agent-a's entry removed, agent-b's still there
    expect(mgr.ownerActiveTab.has("agent-a")).toBe(false);
    expect(mgr.ownerActiveTab.get("agent-b")).toBe(tabB);
    expect(mgr.tabOwners.get(tabB)).toBe("agent-b");
  });
});

// ---------------------------------------------------------------------------
// ownersWithLiveTabs
// ---------------------------------------------------------------------------

describe("ownersWithLiveTabs", () => {
  it("returns empty when no owned tabs exist", () => {
    const mgr = setupMgr();
    expect(mgr.ownersWithLiveTabs()).toEqual([]);
  });

  it("groups live tabs by owner", () => {
    const mgr = setupMgr();
    const a1 = addTab(mgr, "agent-a");
    const a2 = addTab(mgr, "agent-a");
    const b1 = addTab(mgr, "agent-b");
    const result: Array<{ owner: string; tabIds: number[] }> = mgr.ownersWithLiveTabs();
    // Sort for deterministic assertion
    result.sort((a, b) => a.owner.localeCompare(b.owner));
    expect(result).toEqual([
      { owner: "agent-a", tabIds: expect.arrayContaining([a1, a2]) },
      { owner: "agent-b", tabIds: [b1] },
    ]);
    expect(result[0].tabIds.length).toBe(2);
  });

  it("excludes the specified owner", () => {
    const mgr = setupMgr();
    addTab(mgr, "agent-a");
    addTab(mgr, "agent-b");
    const result: Array<{ owner: string; tabIds: number[] }> = mgr.ownersWithLiveTabs("agent-a");
    expect(result).toEqual([{ owner: "agent-b", tabIds: expect.any(Array) }]);
  });

  it("excludes closed tabs", () => {
    const mgr = setupMgr();
    const closedId = addTab(mgr, "agent-a");
    (mgr.tabs.get(closedId) as { isClosed: () => boolean }).isClosed = () => true;
    addTab(mgr, "agent-b");
    const result: Array<{ owner: string; tabIds: number[] }> = mgr.ownersWithLiveTabs();
    // agent-a's only tab is closed — should not appear
    expect(result.find((r: { owner: string }) => r.owner === "agent-a")).toBeUndefined();
    expect(result.find((r: { owner: string }) => r.owner === "agent-b")).toBeDefined();
  });
});
