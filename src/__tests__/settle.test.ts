import { describe, it, expect } from "bun:test";
import { SETTLE_INIT_SCRIPT, waitForSettled, type SettleEnv } from "../settle.js";

// --------------------------------------------------------------------------- //
// SETTLE_INIT_SCRIPT — structural assertions on the injected JS string
// --------------------------------------------------------------------------- //
describe("SETTLE_INIT_SCRIPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SETTLE_INIT_SCRIPT).toBe("string");
    expect(SETTLE_INIT_SCRIPT.length).toBeGreaterThan(100);
  });

  it("contains the __steelSettle counter object", () => {
    expect(SETTLE_INIT_SCRIPT).toContain("__steelSettle");
    expect(SETTLE_INIT_SCRIPT).toContain("inflight");
    expect(SETTLE_INIT_SCRIPT).toContain("lastMutation");
  });

  it("patches fetch", () => {
    expect(SETTLE_INIT_SCRIPT).toContain("window.fetch");
    expect(SETTLE_INIT_SCRIPT).toContain("inflight++");
  });

  it("patches XMLHttpRequest.prototype.send", () => {
    expect(SETTLE_INIT_SCRIPT).toContain("XMLHttpRequest");
    expect(SETTLE_INIT_SCRIPT).toContain("loadend");
  });

  it("installs a MutationObserver", () => {
    expect(SETTLE_INIT_SCRIPT).toContain("MutationObserver");
    expect(SETTLE_INIT_SCRIPT).toContain("documentElement");
  });
});

// --------------------------------------------------------------------------- //
// waitForSettled — unit tests with mocked Playwright Page
// --------------------------------------------------------------------------- //

/** Build a minimal mock page whose evaluate + waitForFunction track calls. */
function mockPage(opts?: {
  hasCounter?: boolean;
  waitFnThrows?: boolean;
  inflight?: number;
  ageMs?: number;
}) {
  const hasCounter = opts?.hasCounter ?? true;
  const waitFnThrows = opts?.waitFnThrows ?? false;
  const inflight = opts?.inflight ?? 0;
  const ageMs = opts?.ageMs ?? 500;

  let evaluateCalled = false;
  let waitFnCalled = false;
  let waitFnPredicate: Function | undefined;

  return {
    page: {
      evaluate: async (_fn: Function) => {
        evaluateCalled = true;
        // Simulate the probe: fn is () => typeof window.__steelSettle
        return hasCounter ? "object" : "undefined";
      },
      waitForFunction: async (fn: Function, _arg?: unknown, _opts?: unknown) => {
        waitFnCalled = true;
        waitFnPredicate = fn;
        if (waitFnThrows) {
          throw new Error("Execution context was destroyed");
        }
        // Simulate a settled state
        if (inflight === 0 && ageMs >= 300) {
          return;
        }
        // If not settled, waitForFunction would keep polling — we simulate
        // immediate resolution for the test since we mock the predicate.
        // The real polling is Playwright's concern.
      },
    } as any,
    evaluateCalled: () => evaluateCalled,
    waitFnCalled: () => waitFnCalled,
    waitFnPredicate: () => waitFnPredicate,
  };
}

const env5000: SettleEnv = { SETTLE_TIMEOUT_MS: 5000 };
const env0: SettleEnv = { SETTLE_TIMEOUT_MS: 0 };

describe("waitForSettled", () => {
  // (a) __steelSettle undefined — probe says "undefined", resolve fast
  it("resolves immediately when __steelSettle is undefined (init script never ran)", async () => {
    const { page, evaluateCalled, waitFnCalled } = mockPage({ hasCounter: false });
    await waitForSettled(page, env5000);
    expect(evaluateCalled()).toBe(true);
    expect(waitFnCalled()).toBe(false);
  });

  // (b) __steelSettle exists, waitForFunction throws (context destroyed) → no throw
  it("does not throw when waitForFunction fails (context destroyed)", async () => {
    const { page, evaluateCalled, waitFnCalled } = mockPage({
      hasCounter: true,
      waitFnThrows: true,
    });
    await waitForSettled(page, env5000);
    expect(evaluateCalled()).toBe(true);
    expect(waitFnCalled()).toBe(true);
    // Must not throw — the function returned normally
  });

  it("calls waitForFunction with the settle predicate when counter exists", async () => {
    const { page, evaluateCalled, waitFnCalled, waitFnPredicate } = mockPage({
      hasCounter: true,
      inflight: 0,
      ageMs: 500,
    });
    await waitForSettled(page, env5000);
    expect(evaluateCalled()).toBe(true);
    expect(waitFnCalled()).toBe(true);
    // The predicate should be a function that checks inflight + lastMutation
    expect(typeof waitFnPredicate()).toBe("function");
  });

  // (c) SETTLE_TIMEOUT_MS=0 → skip everything
  it("skips everything when SETTLE_TIMEOUT_MS is 0", async () => {
    const { page, evaluateCalled, waitFnCalled } = mockPage({ hasCounter: true });
    await waitForSettled(page, env0);
    expect(evaluateCalled()).toBe(false);
    expect(waitFnCalled()).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// actionFeedback — unit tests with mocked page + real snapshot store
// --------------------------------------------------------------------------- //

import { actionFeedback } from "../utils.js";
import { storeSnapshot, getStoredSnapshot, clearAllSnapshots } from "../snapshot.js";

const SNAP_FIXTURE = `- heading "Welcome" [ref=e1]
- textbox "Search" [ref=e2]
- button "Go" [ref=e3]`;

const SNAP_CHANGED = `- heading "Welcome" [ref=e4]
- textbox "Search": hello [ref=e5]
- button "Go" [ref=e6]`;

function ariaPage(snapshot: string) {
  return {
    locator: (_sel: string) => ({
      ariaSnapshot: async (_opts?: unknown) => snapshot,
    }),
  } as any;
}

describe("actionFeedback", () => {
  it("returns empty string when no stored snapshot exists (seeds store silently)", async () => {
    clearAllSnapshots();
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1);
    expect(result).toBe("");
    // Store was seeded
    expect(getStoredSnapshot(1)).toBeTruthy();
  });

  it("returns no-change marker when stored and fresh snapshots are identical", async () => {
    clearAllSnapshots();
    storeSnapshot(1, SNAP_FIXTURE);
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1);
    expect(result).toBe("\n(no visible change)");
  });

  it("returns page changes diff when snapshots differ", async () => {
    clearAllSnapshots();
    storeSnapshot(1, SNAP_FIXTURE);
    const result = await actionFeedback(ariaPage(SNAP_CHANGED), 1);
    expect(result).toContain("--- page changes ---");
    // The store is updated to the fresh snapshot
    expect(getStoredSnapshot(1)).toBe(SNAP_CHANGED);
  });

  it("returns baseline header when navigated=true", async () => {
    clearAllSnapshots();
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1, { navigated: true });
    expect(result).toContain("--- new page (baseline snapshot) ---");
    expect(result).toContain("Welcome");
  });

  it("returns empty when navigated=true and silent=true", async () => {
    clearAllSnapshots();
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1, {
      navigated: true,
      silent: true,
    });
    expect(result).toBe("");
    // Store was still seeded
    expect(getStoredSnapshot(1)).toBeTruthy();
  });

  it("returns empty string on error (best-effort)", async () => {
    clearAllSnapshots();
    const brokenPage = {
      locator: () => {
        throw new Error("broken");
      },
    } as any;
    const result = await actionFeedback(brokenPage, 1, { navigated: true });
    expect(result).toBe("");
  });
});
