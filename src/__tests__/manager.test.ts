/**
 * Unit tests for per-owner active tab tracking + ownership resolution (B1).
 *
 * Does NOT require a browser connection — tests the pure bookkeeping logic
 * of resolveTab, touchTab, closeTab cleanup, and ownersWithLiveTabs.
 * Fake Page objects stub out the Playwright dependency.
 */
import { describe, it, expect, spyOn } from "bun:test";
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
  SETTLE_TIMEOUT_MS: 0,
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
  NETWORK_BUFFER_SIZE: 500,
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
    _url: "about:blank",
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
    url: () => page._url,
    goto: async (url: string) => {
      page._url = url;
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (typeof fn === "function") return (fn as (arg?: unknown) => unknown)(arg);
      return arg;
    },
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

// ---------------------------------------------------------------------------
// allocateTab — idempotent re-registration merges owner metadata
// ---------------------------------------------------------------------------

describe("allocateTab — idempotent re-registration", () => {
  it("sets owner when context listener registered the page first", async () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const page = fakePage();
    // Simulate the context.on("page") listener firing first (no owner).
    const firstId = (mgr as any).allocateTab(page) as number;
    // Then the explicit new_tab path calls allocateTab with an owner.
    const secondId = (mgr as any).allocateTab(page, "agent-a") as number;

    expect(secondId).toBe(firstId);
    expect(mgr.tabOwners.get(firstId)).toBe("agent-a");
    expect(mgr.tabLastActivity.has(firstId)).toBe(true);

    // Owner-scoped cleanup must now find this tab.
    const closed = await mgr.closeTabsByOwner("agent-a");
    expect(closed).toContain(firstId);
  });

  it("keeps existing owner and warns when re-registered with a different owner", () => {
    const mgr = setupMgr();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    const page = fakePage();
    const firstId = (mgr as any).allocateTab(page, "agent-a") as number;
    const secondId = (mgr as any).allocateTab(page, "agent-b") as number;

    expect(secondId).toBe(firstId);
    expect(mgr.tabOwners.get(firstId)).toBe("agent-a");
    expect(consoleError).toHaveBeenCalled();
    const call = consoleError.mock.calls[0] as string[];
    expect(call[0]).toContain('already owned by "agent-a"');
    expect(call[0]).toContain('ignoring owner "agent-b"');

    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dialog policy handling — pre-armed accept/dismiss, no pending/timer model
// ---------------------------------------------------------------------------

import type { Dialog } from "playwright";

/** Build a minimal fake Dialog object for testing dialog capture + handling. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDialog(overrides: Record<string, any> = {}): Dialog {
  return {
    type: () => overrides.type ?? "alert",
    message: () => overrides.message ?? "Test message",
    defaultValue: () => overrides.defaultValue ?? "",
    accept: overrides.accept ?? (async () => {}),
    dismiss: overrides.dismiss ?? (async () => {}),
  } as unknown as Dialog;
}

/**
 * Register a tab through the real allocateTab path — the page's EventEmitter
 * surface supports dialog + close listeners just like Playwright.
 * Returns [tabId, page] so tests can fire events directly on the page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allocateTestTab(mgr: any, owner?: string): [number, Page] {
  const page = fakePage();
  // allocateTab is private — cast to any to test the real path.
  const tabId = (mgr as any).allocateTab(page, owner) as number;
  return [tabId, page];
}

describe("dialog policy handling", () => {
  it("default policy dismisses dialogs immediately", async () => {
    const mgr = setupMgr();
    let dismissed = false;
    const dialog = fakeDialog({
      type: "alert",
      message: "Hello!",
      dismiss: async () => {
        dismissed = true;
      },
    });
    const [tabId, _page] = allocateTestTab(mgr);
    (_page as any)._emit("dialog", dialog);
    await new Promise((r) => setTimeout(r, 10));

    expect(dismissed).toBe(true);
    const last = mgr.getLastDialog(tabId);
    expect(last).toBeTruthy();
    expect(last!.action).toBe("dismissed");
    expect(last!.autoHandled).toBe(true);
  });

  it("accept policy resolves dialogs immediately", async () => {
    const mgr = setupMgr();
    let accepted = false;
    const dialog = fakeDialog({
      type: "confirm",
      message: "Proceed?",
      accept: async () => {
        accepted = true;
      },
      dismiss: async () => {
        throw new Error("should not dismiss when policy is accept");
      },
    });
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept" });
    (_page as any)._emit("dialog", dialog);
    await new Promise((r) => setTimeout(r, 10));

    expect(accepted).toBe(true);
    const last = mgr.getLastDialog(tabId);
    expect(last!.action).toBe("accepted");
  });

  it("accept with promptText passes the text", async () => {
    const mgr = setupMgr();
    let acceptedText: string | undefined;
    const dialog = fakeDialog({
      type: "prompt",
      message: "Enter name:",
      defaultValue: "Alice",
      accept: async (text?: string) => {
        acceptedText = text;
      },
    });
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept", promptText: "geth collective" });
    (_page as any)._emit("dialog", dialog);
    await new Promise((r) => setTimeout(r, 10));

    expect(acceptedText).toBe("geth collective");
    const last = mgr.getLastDialog(tabId);
    expect(last!.promptText).toBe("geth collective");
  });

  it("once policy applies once then reverts to dismiss", async () => {
    const mgr = setupMgr();
    const firstAccepted = { value: false };
    const secondDismissed = { value: false };

    const dialog1 = fakeDialog({
      type: "confirm",
      message: "First",
      accept: async () => {
        firstAccepted.value = true;
      },
    });
    const dialog2 = fakeDialog({
      type: "confirm",
      message: "Second",
      dismiss: async () => {
        secondDismissed.value = true;
      },
    });

    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept", once: true });

    (_page as any)._emit("dialog", dialog1);
    await new Promise((r) => setTimeout(r, 10));
    expect(firstAccepted.value).toBe(true);
    expect(mgr.getDialogPolicy(tabId)).toBeUndefined();

    (_page as any)._emit("dialog", dialog2);
    await new Promise((r) => setTimeout(r, 10));
    expect(secondDismissed.value).toBe(true);
    const last = mgr.getLastDialog(tabId);
    expect(last!.action).toBe("dismissed");
  });

  it("beforeunload is always accepted regardless of policy", async () => {
    const mgr = setupMgr();
    let accepted = false;
    const dialog = fakeDialog({
      type: "beforeunload",
      message: "Leave?",
      accept: async () => {
        accepted = true;
      },
      dismiss: async () => {
        throw new Error("beforeunload should not be dismissed");
      },
    });
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "dismiss" });
    (_page as any)._emit("dialog", dialog);
    await new Promise((r) => setTimeout(r, 10));

    expect(accepted).toBe(true);
    // beforeunload is normal navigation noise and is not reported.
    expect(mgr.dialogNotice(tabId)).toBe("");
  });

  it("handler throw path best-effort dismisses and does not throw", async () => {
    const mgr = setupMgr();
    let dismissCalled = 0;
    const dialog = fakeDialog({
      type: "prompt",
      message: "Boom",
      accept: async () => {
        throw new Error("accept crash");
      },
      dismiss: async () => {
        dismissCalled++;
      },
    });
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept" });

    // Should not throw out of the listener.
    (_page as any)._emit("dialog", dialog);
    await new Promise((r) => setTimeout(r, 10));

    expect(dismissCalled).toBeGreaterThanOrEqual(1);
  });

  it("dialogNotice reports recent auto-handled dialog once", () => {
    const mgr = setupMgr();
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.lastDialogs.set(tabId, {
      type: "confirm",
      message: "Proceed?",
      defaultValue: "",
      action: "accepted",
      promptText: undefined,
      autoHandled: true,
      reported: false,
      at: Date.now(),
    });

    const notice = mgr.dialogNotice(tabId);
    expect(notice).toContain("⚠ dialog appeared");
    expect(notice).toContain("confirm");
    expect(notice).toContain("Proceed?");
    expect(notice).toContain("auto-accepted");

    // Second call should be empty (reported flag flipped).
    expect(mgr.dialogNotice(tabId)).toBe("");
  });

  it("dialogNotice returns empty for old auto-handled dialogs", () => {
    const mgr = setupMgr();
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.lastDialogs.set(tabId, {
      type: "alert",
      message: "Old",
      defaultValue: "",
      action: "dismissed",
      promptText: undefined,
      autoHandled: true,
      reported: false,
      at: Date.now() - 6000, // older than 5s window
    });
    expect(mgr.dialogNotice(tabId)).toBe("");
  });

  it("closeTab clears policy and lastDialog", async () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept" });
    mgr.lastDialogs.set(tabId, {
      type: "alert",
      message: "Test",
      defaultValue: "",
      action: "accepted",
      promptText: undefined,
      autoHandled: true,
      reported: false,
      at: Date.now(),
    });

    await mgr.closeTab(tabId);
    expect(mgr.getDialogPolicy(tabId)).toBeUndefined();
    expect(mgr.getLastDialog(tabId)).toBeNull();
  });

  it("stop() clears dialog policy and lastDialog so reused tab ids start fresh", async () => {
    const mgr = setupMgr();
    const [tabId, _page] = allocateTestTab(mgr);
    mgr.setDialogPolicy(tabId, { action: "accept" });
    mgr.lastDialogs.set(tabId, {
      type: "confirm",
      message: "Delete?",
      defaultValue: "",
      action: "accepted",
      promptText: undefined,
      autoHandled: true,
      reported: false,
      at: Date.now(),
    });

    await mgr.stop();

    // After stop, tab IDs reset to 1; a freshly allocated tab must not inherit
    // the stale accept policy or last-dialog record from the previous session.
    const [newTabId] = allocateTestTab(mgr);
    expect(newTabId).toBe(1);
    expect(mgr.getDialogPolicy(newTabId)).toBeUndefined();
    expect(mgr.getLastDialog(newTabId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotent tab allocation — context.on("page") listener MUST NOT
// double-allocate pages that _doNewTab already registered.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Network capture — ring buffer + body-on-demand
// ---------------------------------------------------------------------------

function fakeNetworkResponse(bodyText: string): any {
  return {
    body: async () => Buffer.from(bodyText, "utf8"),
  };
}

function fakeContext(newPages: Page[] = []) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let pageIdx = 0;
  return {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
    newPage: async () => {
      const p = newPages[pageIdx++] ?? fakePage();
      return p;
    },
    handlers,
  };
}

describe("network capture ring buffer", () => {
  it("evicts oldest events when buffer size is exceeded", () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 3;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    for (let i = 0; i < 5; i++) {
      (mgr as any).pushNetworkEvent({ id: mgr.nextNetworkEventId++, url: `https://x/${i}` });
    }

    expect(mgr.networkEvents).toHaveLength(3);
    expect(mgr.networkEvents.map((e: any) => e.url)).toEqual([
      "https://x/2",
      "https://x/3",
      "https://x/4",
    ]);
  });

  it("keeps ids monotonic even after eviction", () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 2;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    (mgr as any).pushNetworkEvent({ id: mgr.nextNetworkEventId++, url: "https://a/1" });
    (mgr as any).pushNetworkEvent({ id: mgr.nextNetworkEventId++, url: "https://a/2" });
    (mgr as any).pushNetworkEvent({ id: mgr.nextNetworkEventId++, url: "https://a/3" });

    expect(mgr.networkEvents.map((e: any) => e.id)).toEqual([2, 3]);
  });

  it("clears response references when events are evicted", async () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 2;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    (mgr as any).pushNetworkEvent({
      id: 1,
      url: "https://a/1",
      response: fakeNetworkResponse("old"),
    });
    (mgr as any).pushNetworkEvent({
      id: 2,
      url: "https://a/2",
      response: fakeNetworkResponse("keep1"),
    });
    (mgr as any).pushNetworkEvent({
      id: 3,
      url: "https://a/3",
      response: fakeNetworkResponse("keep2"),
    });

    await expect(mgr.getResponseBody(1)).rejects.toThrow("body no longer available");
    await expect(mgr.getResponseBody(2)).resolves.toBe("keep1");
    await expect(mgr.getResponseBody(3)).resolves.toBe("keep2");
  });

  it("throws when body is no longer available", async () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 1;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    (mgr as any).pushNetworkEvent({
      id: 1,
      url: "https://a/1",
      response: fakeNetworkResponse("body"),
    });
    (mgr as any).pushNetworkEvent({
      id: 2,
      url: "https://a/2",
      response: fakeNetworkResponse("evict"),
    });

    await expect(mgr.getResponseBody(1)).rejects.toThrow("body no longer available");
  });
});

describe("network capture disabled", () => {
  it("does not wire listeners when NETWORK_BUFFER_SIZE is 0", () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 0;
    mgr.networkEvents = [];
    const context = fakeContext();
    (mgr as any)._wireNetworkCapture(context);
    expect(Object.keys(context.handlers)).toHaveLength(0);
    expect(mgr.getNetworkEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Crash auto-recovery in getPage
// ---------------------------------------------------------------------------

describe("getPage crash recovery", () => {
  it("recreates a closed current tab under the same tabId", async () => {
    const mgr = setupMgr();
    mgr.initialized = true;
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const deadPage = fakePage({ isClosed: () => true, url: () => "https://dead.test/" });
    const freshPage = fakePage({ url: () => "https://recovered.test/" });
    const context = fakeContext([freshPage]);
    mgr.browserContext = context as any;

    mgr.tabs.set(1, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 1);
    mgr.tabLastUrl.set(1, "https://recovered.test/");

    const page = await mgr.getPage();

    expect(page).toBe(freshPage);
    expect((mgr as any).tabs.get(1)).toBe(freshPage);
    expect((mgr as any).pageToTabId.get(freshPage)).toBe(1);
    expect((freshPage as any)._url).toBe("https://recovered.test/");
  });

  it("recovers an explicit tabId when url() throws", async () => {
    const mgr = setupMgr();
    mgr.initialized = true;
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const deadPage = fakePage({
      url: () => {
        throw new Error("crashed");
      },
    });
    const freshPage = fakePage({ url: () => "https://explicit.test/" });
    const context = fakeContext([freshPage]);
    mgr.browserContext = context as any;

    mgr.tabs.set(5, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 5);
    mgr.tabLastUrl.set(5, "https://explicit.test/");

    const page = await mgr.getPage({ tabId: 5 });

    expect(page).toBe(freshPage);
    expect((mgr as any).tabs.get(5)).toBe(freshPage);
    expect((mgr as any).pageToTabId.get(freshPage)).toBe(5);
  });

  it("sets and consumes the recovery notice once", async () => {
    const mgr = setupMgr();
    mgr.initialized = true;
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const deadPage = fakePage({ isClosed: () => true });
    const freshPage = fakePage({ url: () => "https://noted.test/" });
    const context = fakeContext([freshPage]);
    mgr.browserContext = context as any;

    mgr.tabs.set(1, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 1);
    mgr.tabLastUrl.set(1, "https://noted.test/");

    await mgr.getPage();

    const notice = mgr.consumeRecoveryNotice(1);
    expect(notice).toContain("⚠ tab 1 crashed and was restored");
    expect(notice).toContain("https://noted.test/");
    expect(mgr.consumeRecoveryNotice(1)).toBe("");
  });

  it("throws when the fresh page is also dead", async () => {
    const mgr = setupMgr();
    mgr.initialized = true;
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const deadPage = fakePage({ isClosed: () => true });
    const alsoDead = fakePage({ isClosed: () => true });
    const context = fakeContext([alsoDead]);
    mgr.browserContext = context as any;

    mgr.tabs.set(1, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 1);
    mgr.tabLastUrl.set(1, "https://x/");

    await expect(mgr.getPage()).rejects.toThrow(/crashed/i);
  });
});

describe("idempotent tab allocation", () => {
  it("allocateTab returns the same tabId when called twice for the same page", () => {
    const mgr = setupMgr();
    const page = fakePage();
    const tabId1 = (mgr as any).allocateTab(page) as number;
    const tabId2 = (mgr as any).allocateTab(page) as number;

    expect(tabId1).toBe(tabId2);
    // Only one tab registered in the bookkeeping maps.
    expect(mgr.tabs.get(tabId1)).toBeDefined();
    // nextTabId should have advanced only once (setupMgr starts at 10).
    expect(mgr.nextTabId).toBe(11);
  });

  it("explicit + listener → idempotent, only one entry in tabs map", () => {
    const mgr = setupMgr();
    const page = fakePage();

    // Simulate the race: context.on("page") listener fires (as the
    // _wirePopupCapture handler would), then explicit allocateTab
    // from _doNewTab — both on the same Page. Only ONE tabId assigned.
    (mgr as any).allocateTab(page); // listener path
    (mgr as any).allocateTab(page); // explicit path (idempotent)

    // One entry in the tabs map, not two.
    expect(mgr.tabs.size).toBe(1);
    expect(mgr.nextTabId).toBe(11); // only advanced once
  });
});
