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
  /** Whether a defensive injection (page.evaluate of the settle script) makes
   *  the counter appear. Default true; set false to model a page that
   *  navigated out from under the injection (counter stays absent). */
  injectSucceeds?: boolean;
}) {
  const waitFnThrows = opts?.waitFnThrows ?? false;
  const inflight = opts?.inflight ?? 0;
  const ageMs = opts?.ageMs ?? 500;
  const injectSucceeds = opts?.injectSucceeds ?? true;

  // Mutable so a defensive injection can flip the counter to present, exactly
  // like the real waitForSettled inject-then-reprobe path.
  let counterPresent = opts?.hasCounter ?? true;

  let evaluateCalls = 0;
  let injectCalls = 0;
  let waitFnCalled = false;
  let waitFnPredicate: Function | undefined;

  return {
    page: {
      evaluate: async (fn: Function | string) => {
        evaluateCalls++;
        // The injection call passes the SETTLE_INIT_SCRIPT string; the probe
        // passes a function () => typeof window.__steelSettle.
        if (typeof fn === "string") {
          injectCalls++;
          if (injectSucceeds) counterPresent = true;
          return undefined;
        }
        return counterPresent ? "object" : "undefined";
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
    evaluateCalled: () => evaluateCalls > 0,
    injectCalled: () => injectCalls > 0,
    waitFnCalled: () => waitFnCalled,
    waitFnPredicate: () => waitFnPredicate,
  };
}

const env5000: SettleEnv = { SETTLE_TIMEOUT_MS: 5000 };
const env0: SettleEnv = { SETTLE_TIMEOUT_MS: 0 };

describe("waitForSettled", () => {
  // (a) __steelSettle absent but defensive injection lands it → then waits.
  // Models history back/forward, where afterAction runs after "commit" (before
  // DOMContentLoaded), so the per-page listener hasn't injected the counter yet.
  it("defensively injects the counter when absent, then waits for settle", async () => {
    const { page, evaluateCalled, injectCalled, waitFnCalled } = mockPage({
      hasCounter: false,
      injectSucceeds: true,
    });
    await waitForSettled(page, env5000);
    expect(evaluateCalled()).toBe(true);
    expect(injectCalled()).toBe(true);
    // Counter now present → proceeds to the settle wait.
    expect(waitFnCalled()).toBe(true);
  });

  // (a2) Counter absent AND defensive injection fails to land (page navigated
  // out from under us) → no-op, never calls waitForFunction, never throws.
  it("no-ops when the counter is absent and injection cannot land", async () => {
    const { page, evaluateCalled, injectCalled, waitFnCalled } = mockPage({
      hasCounter: false,
      injectSucceeds: false,
    });
    await waitForSettled(page, env5000);
    expect(evaluateCalled()).toBe(true);
    expect(injectCalled()).toBe(true);
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

const SNAP_FIXTURE = `- heading "Welcome" @e1
- textbox "Search" @e2
- button "Go" @e3`;

const SNAP_CHANGED = `- heading "Welcome" @e4
- textbox "Search": hello @e5
- button "Go" @e6`;

function ariaPage(snapshot: string) {
  return {
    locator: (_sel: string) => ({
      ariaSnapshot: async (_opts?: unknown) => snapshot,
    }),
  } as any;
}

describe("actionFeedback", () => {
  // no-stored returns "" WITHOUT capturing — no spurious store seeding
  it("returns empty string when no stored snapshot exists (does NOT seed store)", async () => {
    clearAllSnapshots();
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1);
    expect(result).toBe("");
    // Store must NOT be seeded — agent hasn't opted in.
    expect(getStoredSnapshot(1)).toBeUndefined();
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
    // The store is updated to the fresh (full) snapshot
    expect(getStoredSnapshot(1)).toBe(SNAP_CHANGED);
  });

  // navigated stores the FULL tree (untruncated) but displays ≤3K chars
  it("navigated stores full tree and displays truncated (no phantom diffs)", async () => {
    clearAllSnapshots();
    // Build a long snapshot (>3K chars for display, <15K for realistic store).
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) {
      lines.push(`- text "This is a reasonably long line number ${i}" @e${i}`);
    }
    const longSnap = lines.join("\n");
    const page = ariaPage(longSnap);

    const result = await actionFeedback(page, 1, { navigated: true });
    expect(result).toContain("--- new page (baseline snapshot) ---");

    // Display must be ≤3000 chars (truncateAtLine may keep slightly over if
    // one line exceeds the cap, but we check it's much shorter than full).
    const displayText = result.replace("--- new page (baseline snapshot) ---\n", "");
    expect(displayText.length).toBeLessThan(longSnap.length);

    // Stored baseline must be the full untruncated tree.
    const stored = getStoredSnapshot(1);
    expect(stored).toBe(longSnap);
  });

  it("returns empty when navigated=true and silent=true (store still seeded)", async () => {
    clearAllSnapshots();
    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1, {
      navigated: true,
      silent: true,
    });
    expect(result).toBe("");
    // Store was still seeded (full tree for future diffs).
    expect(getStoredSnapshot(1)).toBe(SNAP_FIXTURE);
  });

  // S5: >1500-line stored snapshot triggers early bail (no capture, no diff).
  it("returns empty when stored snapshot exceeds 1500 lines (early bail)", async () => {
    clearAllSnapshots();
    const hugeLines = Array.from({ length: 1501 }, (_, i) => `- text "Line ${i}" @e${i}`);
    storeSnapshot(1, hugeLines.join("\n"));

    const result = await actionFeedback(ariaPage(SNAP_FIXTURE), 1);
    expect(result).toBe("");
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
