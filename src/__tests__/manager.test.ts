/**
 * Unit tests for per-owner active tab tracking + ownership resolution.
 *
 * Does NOT require a browser connection — tests the pure bookkeeping logic
 * of resolveTab, touchTab, closeTab cleanup, and ownersWithLiveTabs.
 * Fake Page objects stub out the Playwright dependency.
 */
import { describe, it, expect, spyOn } from "bun:test";
import { BrowserManager, TabOwnershipError, NoTabError, type Env } from "../manager.js";
import type { Page } from "patchright";

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
  OUTPUT_ROOT: "/tmp/steel-mcp-test",
  UPLOAD_ROOT: "/tmp/steel-mcp-test",
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

import type { Dialog } from "patchright";

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
      for (const fn of handlers["page"] ?? []) {
        fn(p);
      }
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

  it("clears response WeakRefs when events are evicted", async () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 2;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    const oldResponse = fakeNetworkResponse("old");
    const keep1Response = fakeNetworkResponse("keep1");
    const keep2Response = fakeNetworkResponse("keep2");

    (mgr as any).pushNetworkEvent({ id: 1, url: "https://a/1" });
    (mgr as any).responsesById.set(1, new WeakRef(oldResponse as any));
    (mgr as any).pushNetworkEvent({ id: 2, url: "https://a/2" });
    (mgr as any).responsesById.set(2, new WeakRef(keep1Response as any));
    (mgr as any).pushNetworkEvent({ id: 3, url: "https://a/3" });
    (mgr as any).responsesById.set(3, new WeakRef(keep2Response as any));

    await expect(mgr.getResponseBody(1)).rejects.toThrow("body no longer available");
    await expect(mgr.getResponseBody(2)).resolves.toBe("keep1");
    await expect(mgr.getResponseBody(3)).resolves.toBe("keep2");
  });

  it("throws when body is no longer available", async () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 1;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    const bodyResponse = fakeNetworkResponse("body");
    const evictResponse = fakeNetworkResponse("evict");

    (mgr as any).pushNetworkEvent({ id: 1, url: "https://a/1" });
    (mgr as any).responsesById.set(1, new WeakRef(bodyResponse as any));
    (mgr as any).pushNetworkEvent({ id: 2, url: "https://a/2" });
    (mgr as any).responsesById.set(2, new WeakRef(evictResponse as any));

    await expect(mgr.getResponseBody(1)).rejects.toThrow("body no longer available");
  });
});

describe("network buffer survives softReset", () => {
  it("keeps events and ids across softReset, and clears only on stop()", async () => {
    const mgr = setupMgr();
    mgr.env.NETWORK_BUFFER_SIZE = 10;
    mgr.networkEvents = [];
    mgr.nextNetworkEventId = 1;

    const response = fakeNetworkResponse("keep");
    (mgr as any).pushNetworkEvent({ id: 1, url: "https://x/1" });
    (mgr as any).responsesById.set(1, new WeakRef(response as any));

    mgr.initialized = true;
    await (mgr as any).softReset();

    expect(mgr.networkEvents).toHaveLength(1);
    expect(mgr.networkEvents[0].id).toBe(1);
    expect((mgr as any).responsesById.has(1)).toBe(true);

    // stop() clears everything.
    await (mgr as any).stop();
    expect(mgr.networkEvents).toHaveLength(0);
    expect((mgr as any).responsesById.size).toBe(0);
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
    (mgr as any)._wirePopupCapture(context);

    mgr.tabs.set(1, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 1);
    mgr.tabLastUrl.set(1, "https://recovered.test/");

    const page = await mgr.getPage();

    expect(page).toBe(freshPage);
    expect((mgr as any).tabs.get(1)).toBe(freshPage);
    expect((mgr as any).pageToTabId.get(freshPage)).toBe(1);
    expect((freshPage as any)._url).toBe("https://recovered.test/");
    // No duplicate allocation from the popup listener.
    expect(Array.from((mgr as any).tabs.keys())).toEqual([999, 1]);
  });

  it("recovers an explicit tabId when url() throws on a detached/crashed page", async () => {
    const mgr = setupMgr();
    mgr.initialized = true;
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const deadPage = fakePage({
      url: () => {
        throw new Error("Target page, context or browser has been closed");
      },
    });
    const freshPage = fakePage({ url: () => "https://explicit.test/" });
    const context = fakeContext([freshPage]);
    mgr.browserContext = context as any;
    (mgr as any)._wirePopupCapture(context);

    mgr.tabs.set(5, deadPage);
    (mgr as any).pageToTabId.set(deadPage, 5);
    mgr.tabLastUrl.set(5, "https://explicit.test/");

    const page = await mgr.getPage({ tabId: 5 });

    expect(page).toBe(freshPage);
    expect((mgr as any).tabs.get(5)).toBe(freshPage);
    expect((mgr as any).pageToTabId.get(freshPage)).toBe(5);
    // Popup listener must not create a transient duplicate tab.
    expect(Array.from((mgr as any).tabs.keys())).toEqual([999, 5]);
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

// ---------------------------------------------------------------------------
// COR1 — _recoverTab preserves owner / per-owner active tab.
// COR2 — clearTabState is the single cleanup helper for every teardown path.
// ---------------------------------------------------------------------------

describe("_recoverTab preserves owner metadata across recovery", () => {
  it("owner survives the page-swap when allocateTab assigns a transient id", async () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-A");
    mgr.ownerActiveTab.set("agent-A", id);
    mgr.tabLastUrl.set(id, "https://recover.test/");
    // Simulate the transient-id remap: pretend the new page allocated as id 99
    // and the recovery path will move it to the original `id`.
    // We do this by patching allocateTab to return a different id once.
    const realAllocate = mgr.allocateTab.bind(mgr);
    let calls = 0;
    mgr.allocateTab = (page: any, owner?: string) => {
      calls++;
      if (calls === 1) return realAllocate(page, owner);
      // Second call (the recovery remap) — pretend it assigned 99
      // which the recovery code then collapses back onto `id`.
      return 99;
    };
    const replacement = fakePage();
    // Call the inner replacePage logic indirectly by invoking _recoverTab,
    // but since _recoverTab requires a real browserContext.newPage, we
    // exercise just the metadata-preservation sub-step:
    const priorOwner = mgr.tabOwners.get(id);
    const priorProfile = mgr.tabToProfile.get(id);
    // Patch tabs.get(tabId) to return the old page so the "old page" path runs,
    // and patch browserContext.newPage to return the replacement.
    mgr.tabs.set(99, replacement);
    // Replace the browserContext stub to satisfy newPage()
    mgr.browserContext = {
      newPage: async () => replacement,
    };
    try {
      await mgr._recoverTab(id);
    } catch {
      // The recovery path may navigate — best-effort, ignore failures
    }
    // After recovery: owner metadata must survive, and the transient
    // id 99 should have been cleaned up.
    expect(mgr.tabOwners.get(id)).toBe(priorOwner);
    expect(mgr.tabOwners.get(99)).toBeUndefined();
    expect(mgr.tabToProfile.get(id)).toBe(priorProfile); // undefined is OK
    expect(mgr.ownerActiveTab.get("agent-A")).toBe(id);
  });
});

describe("clearTabState — single-source per-tab cleanup parity", () => {
  it("wipes every per-tab map entry for the given id", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-A");
    mgr.tabLastUrl.set(id, "https://x.test/");
    mgr.recoveryNotices.set(id, "⚠ crashed");
    mgr.dialogPolicy.set(id, { action: "accept" });
    mgr.lastDialogs.set(id, {
      type: "alert",
      message: "x",
      defaultValue: "",
      action: "accepted",
      autoHandled: true,
      reported: false,
      at: Date.now(),
    });
    mgr.ownerActiveTab.set("agent-A", id);

    mgr.clearTabState(id);

    expect(mgr.tabs.has(id)).toBe(false);
    expect(mgr.tabOwners.has(id)).toBe(false);
    expect(mgr.tabLastActivity.has(id)).toBe(false);
    expect(mgr.tabLastUrl.has(id)).toBe(false);
    expect(mgr.recoveryNotices.has(id)).toBe(false);
    expect(mgr.dialogPolicy.has(id)).toBe(false);
    expect(mgr.lastDialogs.has(id)).toBe(false);
    // ownerActiveTab must have been repaired/cleared for the owner that
    // pointed here.
    expect(mgr.ownerActiveTab.has("agent-A")).toBe(false);
  });

  it("softReset loops every live tab through clearTabState", async () => {
    const mgr = setupMgr();
    addTab(mgr, "agent-A");
    addTab(mgr, "agent-B");
    // No browser/handle to close — softReset tolerates absent context.
    mgr.browser = undefined;
    mgr.browserContext = undefined;
    mgr.idleSweeperHandle = undefined;
    await mgr.softReset();

    // Every per-tab map is empty.
    expect(mgr.tabs.size).toBe(0);
    expect(mgr.tabOwners.size).toBe(0);
    expect(mgr.tabLastActivity.size).toBe(0);
    expect(mgr.tabLastUrl.size).toBe(0);
    expect(mgr.recoveryNotices.size).toBe(0);
    expect(mgr.dialogPolicy.size).toBe(0);
    expect(mgr.lastDialogs.size).toBe(0);
    expect(mgr.ownerActiveTab.size).toBe(0);
    expect(mgr.tabToProfile.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteProfile must route its per-tab teardown through clearTabState so
// every per-tab map entry is wiped (the previous manual partial cleanup
// silently leaked tabLastUrl / recoveryNotices / dialogPolicy /
// lastDialogs / snapshot / ownerActiveTab / pageToTabId).
// ---------------------------------------------------------------------------

describe("deleteProfile — per-tab cleanup parity via clearTabState", () => {
  it("leaves no per-tab map entries for closed profile tabs", async () => {
    const mgr = setupMgr();
    // Build a minimal profile with one owned tab.
    const profileName = "p-cleanup";
    const tabId = addTab(mgr, "agent-A");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).profiles.set(profileName, {
      context: { close: async () => {} },
      tabIds: new Set([tabId]),
    });
    mgr.tabToProfile.set(tabId, profileName);
    // Stuff the other per-tab maps to prove the cleanup catches them all.
    mgr.tabLastUrl.set(tabId, "https://x.test/");
    mgr.recoveryNotices.set(tabId, "⚠");
    mgr.dialogPolicy.set(tabId, { action: "accept" });
    mgr.lastDialogs.set(tabId, {
      type: "alert",
      message: "x",
      defaultValue: "",
      action: "accepted",
      autoHandled: true,
      reported: false,
      at: Date.now(),
    });
    mgr.ownerActiveTab.set("agent-A", tabId);

    await mgr.deleteProfile(profileName);

    // Per-tab maps must be empty for the closed tab.
    expect(mgr.tabs.has(tabId)).toBe(false);
    expect(mgr.tabOwners.has(tabId)).toBe(false);
    expect(mgr.tabLastActivity.has(tabId)).toBe(false);
    expect(mgr.tabLastUrl.has(tabId)).toBe(false);
    expect(mgr.recoveryNotices.has(tabId)).toBe(false);
    expect(mgr.dialogPolicy.has(tabId)).toBe(false);
    expect(mgr.lastDialogs.has(tabId)).toBe(false);
    expect(mgr.tabToProfile.has(tabId)).toBe(false);
    // ownerActiveTab pointer that pointed here is cleared (no other
    // surviving tabs for that owner).
    expect(mgr.ownerActiveTab.has("agent-A")).toBe(false);
    // Profile is gone.
    expect(mgr.profiles.has(profileName)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COR1 — owner metadata survives the FULL browser-closed recovery path:
//   _recoverTab → newPage throws isBrowserClosedError → softReset wipes
//   every per-tab map → initialize → newPage succeeds → replacePage
//   restores owner / profile / ownerActiveTab on the replacement tab.
//
// This is the gap the earlier test (which only drove replacePage) didn't
// cover. The softReset branch MUST still leave the recovered tab with
// the prior owner attached — otherwise a multi-agent session loses
// ownership on the first browser crash.
// ---------------------------------------------------------------------------

describe("_recoverTab preserves owner through the full softReset→initialize path", () => {
  it("owner + ownerActiveTab survive browser-closed recovery", async () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-A");
    mgr.ownerActiveTab.set("agent-A", id);
    mgr.tabLastUrl.set(id, "https://before-crash.test/");

    // First newPage() simulates a dead browser (isBrowserClosedError); the
    // second one (after softReset + initialize) returns a fresh page.
    const replacement = fakePage();
    let newPageCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).browserContext = {
      newPage: async () => {
        newPageCalls++;
        if (newPageCalls === 1) {
          // The first call returns a Promise that rejects — exactly like
          // a dead browser context.
          throw new Error("Target page, context or browser has been closed");
        }
        return replacement;
      },
    };
    // initialize() would try to connect to Steel — stub it out. We need
    // initialize() to set up a fresh browserContext so the second newPage
    // call has something to attach to. softReset wipes browserContext,
    // so initialize must restore it.
    let initCalls = 0;
    mgr.initialize = async () => {
      initCalls++;
      mgr.initialized = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mgr as any).browserContext = {
        newPage: async () => {
          newPageCalls++;
          return replacement;
        },
      };
    };

    // Drive the full path: _recoverTab catches the first newPage throw,
    // softResets (clears all per-tab state), initializes (no-op stub),
    // then succeeds on the second newPage and calls replacePage.
    const recovered = await mgr._recoverTab(id);

    // The recovery path ran: first attempt failed, softReset cleared,
    // initialize ran, second attempt succeeded.
    expect(newPageCalls).toBe(2);
    expect(initCalls).toBe(1);
    expect(recovered).toBe(replacement);

    // owner / ownerActiveTab must be restored on the same tabId. Profile
    // membership is intentionally NOT asserted — softReset clears
    // profiles by design (every BrowserContext died with the browser;
    // the profile definition does not survive the soft reset).
    expect(mgr.tabOwners.get(id)).toBe("agent-A");
    expect(mgr.ownerActiveTab.get("agent-A")).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Tab route registry — addRoute, listRoutes, removeRoutes, clearTabState
// ---------------------------------------------------------------------------

describe("tab route registry", () => {
  it("addRoute registers a route; listRoutes shows it", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-A");
    const tabRoutes = (mgr as any).tabRoutes;
    // Simulate a registered route entry directly (addRoute needs a real Page
    // with .route() — we test the full handler path in the intercept tool
    // tests). Here we push entries manually to test the registry bookkeeping.
    tabRoutes.set(id, [
      { pattern: "**/api/*", owner: "agent-A", unroute: async () => {} },
      { pattern: "**/cdn/*", owner: "agent-A", unroute: async () => {} },
    ]);

    const routes = mgr.listRoutes(id);
    expect(routes).toHaveLength(2);
    expect(routes[0].pattern).toBe("**/api/*");
    expect(routes[0].owner).toBe("agent-A");
    expect(routes[1].pattern).toBe("**/cdn/*");
  });

  it("listRoutes returns empty array for unknown tab", () => {
    const mgr = setupMgr();
    expect(mgr.listRoutes(999)).toEqual([]);
  });

  it("removeRoutes(tabId) drops every route and returns count", async () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-B");
    let unrouteCalls = 0;
    const tabRoutes = (mgr as any).tabRoutes;
    tabRoutes.set(id, [
      {
        pattern: "**/a/*",
        owner: "agent-B",
        unroute: async () => {
          unrouteCalls++;
        },
      },
      {
        pattern: "**/b/*",
        owner: "agent-B",
        unroute: async () => {
          unrouteCalls++;
        },
      },
    ]);

    const n = await mgr.removeRoutes(id);
    expect(n).toBe(2);
    expect(unrouteCalls).toBe(2);
    // Registry should be cleaned up.
    expect((mgr as any).tabRoutes.has(id)).toBe(false);
    expect(mgr.listRoutes(id)).toEqual([]);
  });

  it("removeRoutes(tabId, pattern) unroutes only matching pattern", async () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-C");
    let aUnrouted = false;
    let bUnrouted = false;
    const tabRoutes = (mgr as any).tabRoutes;
    tabRoutes.set(id, [
      {
        pattern: "**/a/*",
        owner: "agent-C",
        unroute: async () => {
          aUnrouted = true;
        },
      },
      {
        pattern: "**/b/*",
        owner: "agent-C",
        unroute: async () => {
          bUnrouted = true;
        },
      },
    ]);

    const n = await mgr.removeRoutes(id, "**/a/*");
    expect(n).toBe(1);
    expect(aUnrouted).toBe(true);
    expect(bUnrouted).toBe(false);

    const remaining = mgr.listRoutes(id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pattern).toBe("**/b/*");
  });

  it("clearTabState clears tabRoutes for that tab", () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-D");
    const tabRoutes = (mgr as any).tabRoutes;
    tabRoutes.set(id, [{ pattern: "**/x/*", owner: "agent-D", unroute: async () => {} }]);

    // clearTabState is called by closeTab — it must wipe tabRoutes.
    mgr.clearTabState(id);
    expect((mgr as any).tabRoutes.has(id)).toBe(false);
  });

  it("closeTab clears tabRoutes via clearTabState", async () => {
    const mgr = setupMgr();
    mgr.primaryTabId = 999;
    mgr.tabs.set(999, fakePage());

    const id = addTab(mgr, "agent-E");
    const tabRoutes = (mgr as any).tabRoutes;
    tabRoutes.set(id, [{ pattern: "**/y/*", owner: "agent-E", unroute: async () => {} }]);

    await mgr.closeTab(id);
    expect((mgr as any).tabRoutes.has(id)).toBe(false);
  });

  it("removeRoutes swallows unroute errors (page may be gone)", async () => {
    const mgr = setupMgr();
    const id = addTab(mgr, "agent-F");
    const tabRoutes = (mgr as any).tabRoutes;
    tabRoutes.set(id, [
      {
        pattern: "**/boom/*",
        owner: "agent-F",
        unroute: async () => {
          throw new Error("page closed");
        },
      },
    ]);

    // Should not throw — the try/catch in removeRoutes catches it.
    const n = await mgr.removeRoutes(id);
    expect(n).toBe(1);
    expect((mgr as any).tabRoutes.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Intercept tool guard tests — schema-level (pattern optional) +
// ownership denial (resolveTab throws BEFORE pattern guard) +
// pattern-required guard for fulfill/abort/continue.
// ---------------------------------------------------------------------------

import { register as registerIntercept } from "../tools/intercept.js";
import type { ToolRegistrar } from "../tools/shared.js";

function makeHandlerCapturer(): {
  handlers: Record<string, (args: any) => any>;
  register: ToolRegistrar;
} {
  const handlers: Record<string, (args: any) => any> = {};
  const register = ((opts: any) => {
    handlers[opts.name] = opts.handler;
  }) as ToolRegistrar;
  return { handlers, register };
}

describe("intercept tool guards", () => {
  it("pattern is optional — handler receives undefined when omitted (MCP schema guard)", async () => {
    const { handlers, register } = makeHandlerCapturer();
    // fake mgr: resolveTab succeeds, getTabOwner matches caller so assertTabOwner passes
    const mgr = {
      resolveTab: () => 1,
      getTabOwner: () => "agent-A",
      listRoutes: () => [],
      addRoute: async () => {},
      removeRoutes: async () => 0,
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);
    // list with no pattern, with matching owner — should succeed
    const result = await handlers.intercept({ action: "list", owner: "agent-A" });
    // Ownership passes, list should return routes (empty array)
    expect(result.content[0].text).toBe("[]");
  });

  it("ownership denial fires BEFORE pattern guard for list (no pattern passed)", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => {
        const err = new Error(
          'Tab 5 belongs to owner "agent-B" — you are "agent-A". Pass force:true to override, or target your own tab.',
        );
        err.name = "TabOwnershipError";
        throw err;
      },
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({ action: "list", tabId: 5, owner: "agent-A" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to owner");
    // Ownership error, NOT a missing-pattern error
    expect(result.content[0].text).not.toContain("pattern is required");
  });

  it("ownership denial fires BEFORE pattern guard for fulfill (with pattern passed)", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => {
        const err = new Error(
          'Tab 5 belongs to owner "agent-B" — you are "agent-A". Pass force:true to override, or target your own tab.',
        );
        err.name = "TabOwnershipError";
        throw err;
      },
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({
      action: "fulfill",
      pattern: "**/api/*",
      tabId: 5,
      owner: "agent-A",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to owner");
  });

  it("pattern-required guard returns isError when fulfill has no pattern but ownership passes", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => 1,
      getTabOwner: () => "self",
      listRoutes: () => [],
      addRoute: async () => {},
      removeRoutes: async () => 0,
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({
      action: "fulfill",
      owner: "self",
      // pattern intentionally omitted
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pattern is required");
    expect(result.content[0].text).toContain('"fulfill"');
  });

  it("intercept handler does NOT include outputSchema (removed — strict MCP path)", () => {
    const captured: any[] = [];
    const register = ((opts: any) => {
      captured.push(opts);
    }) as ToolRegistrar;
    const mgr = {} as BrowserManager;
    const env = {} as Env;
    registerIntercept(register, mgr, env);

    const spec = captured.find((s) => s.name === "intercept");
    expect(spec).toBeTruthy();
    expect(spec.outputSchema).toBeUndefined();
  });

  // SEC3 regression: tabId-only bypass — resolveTab skips ownership when
  // owner is absent. assertTabOwner closes this gap.
  it("tabId-only bypass: intercept fulfill on owned tab without owner → isError ownership", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => 5,
      getTabOwner: () => "agent-B",
      listRoutes: () => [],
      addRoute: async () => {},
      removeRoutes: async () => 0,
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({
      action: "fulfill",
      pattern: "**/api/*",
      tabId: 5,
      // owner intentionally omitted — the tabId-only bypass
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to owner");
  });

  it("tabId-only bypass: intercept list with no owner on owned tab → isError ownership", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => 5,
      getTabOwner: () => "agent-B",
      listRoutes: () => [],
      addRoute: async () => {},
      removeRoutes: async () => 0,
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({
      action: "list",
      tabId: 5,
      // owner intentionally omitted
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to owner");
    // Must NOT be a pattern error
    expect(result.content[0].text).not.toContain("pattern is required");
  });

  it("intercept with force:true on another owner's tab → allowed", async () => {
    const { handlers, register } = makeHandlerCapturer();
    let called = false;
    const mgr = {
      resolveTab: () => 5,
      getTabOwner: () => "agent-B",
      listRoutes: () => [],
      addRoute: async () => {
        called = true;
      },
      removeRoutes: async () => 0,
    } as any as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0 } as Env;
    registerIntercept(register, mgr, env);

    const result = await handlers.intercept({
      action: "fulfill",
      pattern: "**/api/*",
      tabId: 5,
      force: true,
      // owner intentionally omitted — force overrides
    });
    expect(result.isError).toBeUndefined();
    expect(called).toBe(true);
    expect(result.content[0].text).toContain("Interception armed");
  });
});

// ---------------------------------------------------------------------------
// export_har tool guards — traffic-observation leak + multi-tab completeness
// ---------------------------------------------------------------------------

import { register as registerNetwork, buildHar, assertTabOwner } from "../tools/network.js";

describe("export_har tool guards", () => {
  it("unscoped (no owner, no tabId) → refused", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => 1,
      getTabOwner: () => undefined,
      getNetworkEvents: () => [],
    } as any as BrowserManager;
    const env = { OUTPUT_DIR: "/tmp", OUTPUT_ROOT: "/tmp" } as Env;
    registerNetwork(register, mgr, env);

    const result = await handlers.export_har({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("refusing to export all owners' traffic");
  });

  it("tabId-only bypass: export_har on owned tab without owner → isError ownership", async () => {
    const { handlers, register } = makeHandlerCapturer();
    const mgr = {
      resolveTab: () => 5,
      getTabOwner: () => "agent-B",
      getNetworkEvents: () => [],
    } as any as BrowserManager;
    const env = { OUTPUT_DIR: "/tmp", OUTPUT_ROOT: "/tmp" } as Env;
    registerNetwork(register, mgr, env);

    const result = await handlers.export_har({ tabId: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to owner");
  });

  it("multi-tab completeness: owner-only passes owner to getNetworkEvents (not resolved single tab)", async () => {
    const { handlers, register } = makeHandlerCapturer();
    let calledWith: any = undefined;
    const mgr = {
      resolveTab: () => 1,
      getTabOwner: () => "agent-A",
      getNetworkEvents: (filter: any) => {
        calledWith = filter;
        return [
          {
            id: 1,
            at: Date.now(),
            tabId: 1,
            method: "GET",
            url: "https://a/1",
            resourceType: "xhr",
          },
          {
            id: 2,
            at: Date.now(),
            tabId: 2,
            method: "POST",
            url: "https://a/2",
            resourceType: "fetch",
          },
        ];
      },
    } as any as BrowserManager;
    const env = { OUTPUT_DIR: "/tmp", OUTPUT_ROOT: "/tmp" } as Env;
    registerNetwork(register, mgr, env);

    const result = await handlers.export_har({ owner: "agent-A" });
    expect(result.isError).toBeUndefined();
    // Must call getNetworkEvents with owner, NOT a resolved single tabId.
    expect(calledWith.owner).toBe("agent-A");
    expect(calledWith.tabId).toBeUndefined();
    expect(result.content[0].text).toContain("(2 entries)");
  });
});

describe("buildHar", () => {
  it("missing at timestamp does NOT throw — uses Date.now() fallback", () => {
    const events = [
      { id: 1, at: undefined as any, method: "GET", url: "https://x", resourceType: "xhr" },
    ];
    const har = buildHar(events) as any;
    const entry = har.log.entries[0];
    // Must be a valid ISO date string, no RangeError thrown
    expect(entry.startedDateTime).toBeTruthy();
    expect(() => new Date(entry.startedDateTime)).not.toThrow();
  });

  it("startedDateTime is request-start (at - durationMs) per HAR 1.2", () => {
    const events = [
      {
        id: 1,
        at: 1000000,
        durationMs: 200,
        method: "GET",
        url: "https://x",
        resourceType: "xhr",
      },
    ];
    const har = buildHar(events) as any;
    const entry = har.log.entries[0];
    expect(entry.startedDateTime).toBe(new Date(1000000 - 200).toISOString());
    expect(entry.time).toBe(200);
  });
});

describe("assertTabOwner", () => {
  const fakeGetOwner = (map: Record<number, string>) => (tabId: number) => map[tabId];

  it("force:true → ok regardless of owner", () => {
    const r = assertTabOwner({ getTabOwner: fakeGetOwner({ 5: "agent-B" }) }, 5, undefined, true);
    expect(r.ok).toBe(true);
  });

  it("unowned tab → ok", () => {
    const r = assertTabOwner({ getTabOwner: fakeGetOwner({}) }, 5, undefined, undefined);
    expect(r.ok).toBe(true);
  });

  it("matching owner → ok", () => {
    const r = assertTabOwner(
      { getTabOwner: fakeGetOwner({ 5: "agent-A" }) },
      5,
      "agent-A",
      undefined,
    );
    expect(r.ok).toBe(true);
  });

  it("owned tab + no caller owner → DENIED", () => {
    const r = assertTabOwner(
      { getTabOwner: fakeGetOwner({ 5: "agent-B" }) },
      5,
      undefined,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("belongs to owner");
  });

  it("owned tab + wrong caller owner → DENIED", () => {
    const r = assertTabOwner(
      { getTabOwner: fakeGetOwner({ 5: "agent-B" }) },
      5,
      "agent-A",
      undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("belongs to owner");
  });
});
