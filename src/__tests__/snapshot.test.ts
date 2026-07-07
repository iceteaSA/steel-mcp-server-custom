import { describe, it, expect } from "bun:test";
import {
  captureSnapshot,
  diffSnapshots,
  truncateAtLine,
  clearSnapshot,
  clearAllSnapshots,
  storeSnapshot,
  getStoredSnapshot,
  filterTree,
  truncateForDisplay,
  applyIntent,
} from "../snapshot.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar } from "../tools/shared.js";
import { register as registerExtraction, snapshotFilterSchema } from "../tools/extraction.js";

// ---------------------------------------------------------------------------
// truncateAtLine — line-boundary truncation helper
// ---------------------------------------------------------------------------
describe("truncateAtLine", () => {
  it("returns full text when under maxChars", () => {
    const text = "line1\nline2\nline3";
    const result = truncateAtLine(text, 100);
    expect(result.text).toBe(text);
    expect(result.truncatedLines).toBe(0);
  });

  it("truncates at line boundary when exceeding maxChars", () => {
    const text = "line1\nline2\nline3\nline4";
    // "line1\nline2\n" = 12 chars. maxChars=11 should keep until line2 end.
    const result = truncateAtLine(text, 12);
    // 12 chars keeps "line1\nline2\n" (12 chars exactly, includes trailing \n)
    expect(result.text).toBe("line1\nline2\n");
    expect(result.truncatedLines).toBe(2); // line3, line4
  });

  it("handles very small maxChars — keeps at least one line", () => {
    const text = "a\nb\nc";
    const result = truncateAtLine(text, 1);
    expect(result.text).toBe("a\n");
    expect(result.truncatedLines).toBe(2);
  });

  it("handles single-line text under maxChars", () => {
    const text = "only one line";
    const result = truncateAtLine(text, 100);
    expect(result.text).toBe("only one line");
    expect(result.truncatedLines).toBe(0);
  });

  it("handles empty text", () => {
    const result = truncateAtLine("", 100);
    expect(result.text).toBe("");
    expect(result.truncatedLines).toBe(0);
  });

  it("handles text without trailing newline", () => {
    const text = "a\nb\nc";
    // "a\nb\n" = 4 chars. maxChars=4 → keeps "a\nb\n"
    const result = truncateAtLine(text, 4);
    expect(result.text).toBe("a\nb\n");
    expect(result.truncatedLines).toBe(1); // c
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots — pure diff of aria snapshots
// ---------------------------------------------------------------------------

// Realistic aria snapshot fixtures (post-captureSnapshot @eN compact format)
const TREE_A = `- heading "Welcome" [level=1] @e1
- textbox "Search" @e2
- button "Go" [disabled] @e3
- list @e4
  - listitem @e5
    - link "Home" @e6
  - listitem @e7
    - link "About" @e8`;

const TREE_A_REF_CHURN = `- heading "Welcome" [level=1] @e9
- textbox "Search" @e10
- button "Go" [disabled] @e11
- list @e12
  - listitem @e13
    - link "Home" @e14
  - listitem @e15
    - link "About" @e16`;

// Value change: textbox value differs
const TREE_SEARCH_EMPTY = `- textbox "Search": @e1
- button "Go" @e2`;
const TREE_SEARCH_FILLED = `- textbox "Search": hello world @e3
- button "Go" @e4`;

// Appearance / disappearance
const TREE_TWO_ITEMS = `- heading "Title" @e1
- link "A" @e2
- link "B" @e3`;
const TREE_ONE_ITEM = `- heading "Title" @e1
- link "A" @e2`;

// Nested indentation
const TREE_NESTED_DEEP = `- main @e1
  - section @e2
    - heading "Deep" [level=3] @e3
    - paragraph "content" @e4`;
const TREE_NESTED_ONE_CHANGED = `- main @e1
  - section @e2
    - heading "Deep" [level=3] @e3
    - paragraph "changed" @e4`;

describe("diffSnapshots", () => {
  // 1. Identical trees
  it("returns '(no visible change)' for identical trees", () => {
    expect(diffSnapshots(TREE_A, TREE_A)).toBe("(no visible change)");
  });

  // 2. Ref-only churn — THE critical test
  it("returns '(no visible change)' when only [ref=eN] markers differ", () => {
    expect(diffSnapshots(TREE_A, TREE_A_REF_CHURN)).toBe("(no visible change)");
  });

  // 3. Value change
  it("detects a value change on a matching element", () => {
    const result = diffSnapshots(TREE_SEARCH_EMPTY, TREE_SEARCH_FILLED);
    // Should contain a change indicator, not identical
    expect(result).not.toBe("(no visible change)");
    // The textbox line has a value change
    expect(result).toContain("textbox");
    // Should use either ~ or -/+ pattern
    expect(result.match(/~|-|\+/)).not.toBeNull();
  });

  // 4. Appeared node
  it("shows '+' for an appeared line", () => {
    const result = diffSnapshots(TREE_ONE_ITEM, TREE_TWO_ITEMS);
    expect(result).toContain("+");
    expect(result).toContain("link");
    expect(result).toContain('"B"');
  });

  // 5. Disappeared node
  it("shows '-' for a disappeared line", () => {
    const result = diffSnapshots(TREE_TWO_ITEMS, TREE_ONE_ITEM);
    expect(result).toContain("-");
    expect(result).toContain("link");
    expect(result).toContain('"B"');
  });

  // 6. Nested indentation preserved
  it("preserves indentation in diff output", () => {
    const result = diffSnapshots(TREE_NESTED_DEEP, TREE_NESTED_ONE_CHANGED);
    // The changed paragraph line should have its indentation preserved
    const lines = result.split("\n");
    const changedLine = lines.find((l) => l.includes("changed"));
    expect(changedLine).toBeDefined();
    // Indentation should be preserved — the paragraph is at depth 2 (4 spaces)
    // The line should start with "  " (indent after the diff marker or prefix)
    // We check that the text after the diff marker contains leading spaces
    // The marker could be "~ " or "- " or "+ " prepended
    if (changedLine) {
      // After stripping the marker prefix (~ / - / + and a space), verify indentation
      const afterMarker = changedLine.replace(/^[~+-]\s*/, "");
      expect(afterMarker).toMatch(/^\s{4}/);
    }
  });

  // 7. Truncation
  it("caps diff output at maxChars with truncation notice", () => {
    // Build a large snapshot with many lines
    const lines = Array.from({ length: 200 }, (_, i) => `- text "Item ${i}" @e${i}`);
    const prev = lines.join("\n");
    // Change every other line so diff is large
    const next = Array.from(
      { length: 200 },
      (_, i) => `- text "Item ${i}${i % 2 === 0 ? " modified" : ""}" @e${i + 200}`,
    ).join("\n");
    const result = diffSnapshots(prev, next, { maxChars: 500 });
    expect(result.length).toBeLessThanOrEqual(700); // maxChars + some slack for truncation notice
    expect(result).toContain("truncated");
  });

  // 8. Large-tree fallback path (>1500 lines)
  it("handles >1500-line snapshots with fallback (returns sane output)", () => {
    const lines = Array.from({ length: 1501 }, (_, i) => `- text "Long item ${i}" @e${i}`);
    const prev = lines.join("\n");
    const next = lines.join("\n"); // identical, so no diff expected
    const result = diffSnapshots(prev, next);
    // Even with fallback, identical should yield no change
    expect(result).toBe("(no visible change)");
  });

  it("handles >1500-line snapshots with actual changes via fallback", () => {
    const lines = Array.from({ length: 1501 }, (_, i) => `- text "Item ${i}" @e${i}`);
    const prev = lines.join("\n");
    const nextLines = [...lines];
    nextLines[100] = `- text "CHANGED" @e${Number.MAX_SAFE_INTEGER}`;
    const next = nextLines.join("\n");
    const result = diffSnapshots(prev, next);
    expect(result).not.toBe("(no visible change)");
    expect(result).toContain("CHANGED");
  });

  // Edge cases
  it("handles empty prev snapshot", () => {
    const result = diffSnapshots("", TREE_A);
    expect(result).not.toBe("(no visible change)");
    // All lines should appear as added
    const addCount = (result.match(/^\s*\+/gm) || []).length;
    expect(addCount).toBe(TREE_A.split("\n").length);
  });

  it("handles empty next snapshot", () => {
    const result = diffSnapshots(TREE_A, "");
    expect(result).not.toBe("(no visible change)");
    // All lines should appear as removed
    const removeCount = (result.match(/^\s*-/gm) || []).length;
    expect(removeCount).toBe(TREE_A.split("\n").length);
  });

  it("handles both empty", () => {
    expect(diffSnapshots("", "")).toBe("(no visible change)");
  });

  // Regression: middle insertion must show + lines
  it("shows '+' for a line inserted between two unchanged lines", () => {
    const prev = `- heading "Title" @e1
- link "B" @e3`;
    const next = `- heading "Title" @e1
- link "A" @e2
- link "B" @e3`;

    const result = diffSnapshots(prev, next);
    expect(result).not.toBe("(no visible change)");
    expect(result).toContain("+");
    expect(result).toContain('"A"');
  });

  // Regression: middle deletion must show - lines
  it("shows '-' for a line deleted between two unchanged lines", () => {
    const prev = `- heading "Title" @e1
- link "A" @e2
- link "B" @e3`;
    const next = `- heading "Title" @e1
- link "B" @e3`;

    const result = diffSnapshots(prev, next);
    expect(result).not.toBe("(no visible change)");
    expect(result).toContain("-");
    expect(result).toContain('"A"');
  });

  // Truncation INCLUSIVE of notice (N2)
  it("truncation respects maxChars inclusive of notice", () => {
    // Build a diff result that's ~1000 chars
    const lines = Array.from({ length: 50 }, (_, i) => `  - text "Item ${i}" @e${i}`);
    const prev = lines.join("\n");
    // Change every line so all are added
    const next = "";
    const result = diffSnapshots(prev, next, { maxChars: 300 });
    // Total output must be ≤ maxChars
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContain("truncated");
  });

  it("hard-clips to maxChars even when tiny (e.g. 10)", () => {
    // A large diff from small maxChars — even truncateAtLine's minimum
    // (one full line) may exceed the effective budget.
    const prev = Array.from({ length: 30 }, (_, i) => `- text "Line ${i}" @e${i}`).join("\n");
    const next = "";
    const result = diffSnapshots(prev, next, { maxChars: 10 });
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// per-tab snapshot store
// ---------------------------------------------------------------------------
describe("snapshot store", () => {
  it("stores and retrieves a snapshot by tabId", () => {
    storeSnapshot(1, "snapshot for tab 1");
    expect(getStoredSnapshot(1)).toBe("snapshot for tab 1");
  });

  it("returns undefined for unknown tabId", () => {
    expect(getStoredSnapshot(999)).toBeUndefined();
  });

  it("clears a snapshot by tabId", () => {
    storeSnapshot(2, "snapshot for tab 2");
    clearSnapshot(2);
    expect(getStoredSnapshot(2)).toBeUndefined();
  });

  it("clearSnapshot is a no-op for unknown tabId", () => {
    clearSnapshot(999);
    // Should not throw
  });

  it("overwrites existing snapshot for same tabId", () => {
    storeSnapshot(3, "first");
    storeSnapshot(3, "second");
    expect(getStoredSnapshot(3)).toBe("second");
  });

  it("isolates snapshots per tabId", () => {
    storeSnapshot(10, "ten");
    storeSnapshot(20, "twenty");
    expect(getStoredSnapshot(10)).toBe("ten");
    expect(getStoredSnapshot(20)).toBe("twenty");
    clearSnapshot(10);
    expect(getStoredSnapshot(10)).toBeUndefined();
    expect(getStoredSnapshot(20)).toBe("twenty");
  });

  it("clearAllSnapshots removes all entries", () => {
    storeSnapshot(1, "one");
    storeSnapshot(2, "two");
    storeSnapshot(3, "three");
    clearAllSnapshots();
    expect(getStoredSnapshot(1)).toBeUndefined();
    expect(getStoredSnapshot(2)).toBeUndefined();
    expect(getStoredSnapshot(3)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// captureSnapshot — with mocked page
// ---------------------------------------------------------------------------
describe("captureSnapshot", () => {
  // ariaSnapshot returns Playwright's [ref=eN] format; captureSnapshot transforms it to @eN.
  const fixtureRaw = `- heading "Welcome" [ref=e1]
- textbox "Search" [ref=e2]
- button "Go" [ref=e3]`;
  const fixtureExpected = `- heading "Welcome" @e1
- textbox "Search" @e2
- button "Go" @e3`;

  it("returns snapshot text and generation counter", async () => {
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => fixtureRaw,
      }),
    } as any;

    clearAllSnapshots();
    const result = await captureSnapshot(mockPage, 1);
    expect(result.text).toBe(fixtureExpected);
    expect(result.generation).toBe(1);
  });

  it("generation counter increments across captures", async () => {
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => fixtureRaw,
      }),
    } as any;

    clearAllSnapshots();
    const r1 = await captureSnapshot(mockPage, 1);
    expect(r1.generation).toBe(1);
    const r2 = await captureSnapshot(mockPage, 1);
    expect(r2.generation).toBe(2);
    const r3 = await captureSnapshot(mockPage, 2); // different tab
    expect(r3.generation).toBe(1);
  });

  it("truncates at line boundary and appends notice", async () => {
    const long = Array.from({ length: 10 }, (_, i) => `- text "Line ${i}" [ref=e${i}]`).join("\n");
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => long,
      }),
    } as any;

    clearAllSnapshots();
    // maxChars=100: small enough to truncate (raw has [ref=eN], transformed to @eN ~25 chars/line)
    const result = await captureSnapshot(mockPage, 1, { maxChars: 100 });
    expect(result.text).toContain("more lines");
    expect(result.text).toContain("selector to scope");
    // First few lines should be present
    expect(result.text).toContain("Line 0");
    // Total must be ≤ maxChars (notice included)
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("hard-clips when maxChars is too small for the notice", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `- text "Line ${i}" [ref=e${i}]`).join("\n");
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => long,
      }),
    } as any;

    clearAllSnapshots();
    // maxChars=20: notice alone is ~50 chars, so it won't fit — hard clip wins
    const result = await captureSnapshot(mockPage, 1, { maxChars: 20 });
    // Must not exceed maxChars
    expect(result.text.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// CaptureSnapshot compact refs — ariaSnapshot returns [ref=eN], we show @eN
// ---------------------------------------------------------------------------
describe("captureSnapshot compact refs", () => {
  it("transforms [ref=eN] to @eN in snapshot output", async () => {
    const raw = '- button "Go" [ref=e7]';
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => raw,
      }),
    } as any;

    clearAllSnapshots();
    const result = await captureSnapshot(mockPage, 99);
    expect(result.text).toContain("@e7");
    expect(result.text).not.toContain("[ref=e7]");
  });

  it("transforms multiple [ref=eN] tokens in one snapshot", async () => {
    const raw = '- textbox "Search" [ref=e1]\n- button "Go" [ref=e2]';
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => raw,
      }),
    } as any;

    clearAllSnapshots();
    const result = await captureSnapshot(mockPage, 98);
    expect(result.text).toContain("@e1");
    expect(result.text).toContain("@e2");
    expect(result.text).not.toContain("[ref=");
  });
});

// ---------------------------------------------------------------------------
// FilterTree — interactive / all / visible modes
// ---------------------------------------------------------------------------
describe("filterTree", () => {
  const TREE = [
    '- generic "Page"',
    '  - heading "Title"',
    '  - paragraph "Some text"',
    '  - button "Submit" @e3',
    '  - link "Home" @e4',
  ].join("\n");

  it("all: returns input unchanged", () => {
    expect(filterTree(TREE, "all")).toBe(TREE);
  });

  it("visible: drops [hidden] lines", () => {
    const input = '- button "Submit" @e3\n- link "Old [hidden]" @e4\n- button "Go" @e5';
    const result = filterTree(input, "visible");
    expect(result).toContain("Submit");
    expect(result).toContain("Go");
    expect(result).not.toContain("[hidden]");
  });

  it("interactive: keeps button and its ancestor, drops heading/paragraph", () => {
    const result = filterTree(TREE, "interactive");
    expect(result).toContain("button");
    expect(result).toContain("Submit");
    expect(result).toContain("generic"); // ancestor of button
    expect(result).not.toContain("heading");
    expect(result).not.toContain("paragraph");
  });

  it("interactive: keeps link and its ancestor", () => {
    const result = filterTree(TREE, "interactive");
    expect(result).toContain("link");
    expect(result).toContain("Home");
  });

  it("interactive: returns fallback message when no interactive elements", () => {
    const noInteractive = '- heading "Title"\n- paragraph "text"';
    const result = filterTree(noInteractive, "interactive");
    expect(result).toContain("no interactive elements");
  });

  it("interactive: empty lines are ignored without throwing", () => {
    const withBlanks = '- button "Go" @e1\n\n- link "Home" @e2';
    const result = filterTree(withBlanks, "interactive");
    expect(result).toContain("button");
    expect(result).toContain("link");
  });
});

// ---------------------------------------------------------------------------
// TruncateForDisplay
// ---------------------------------------------------------------------------
describe("truncateForDisplay", () => {
  it("returns full text when under maxChars", () => {
    const text = "short text";
    expect(truncateForDisplay(text, 1000)).toBe(text);
  });

  it("truncates at line boundary with notice", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- text "Line ${i}" @e${i}`);
    const text = lines.join("\n");
    const result = truncateForDisplay(text, 80);
    expect(result).toContain("more lines");
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// applyIntent — goal-scoped filter
// ---------------------------------------------------------------------------
describe("applyIntent", () => {
  const TREE = `- generic @e1
  - textbox "Email" @e2
  - textbox "Password" @e3
  - button "Login" @e4
  - link "Forgot password?" @e5
  - paragraph "Welcome back" @e6`;

  it("unknown intent returns input unchanged", () => {
    expect(applyIntent(TREE, "unknown_intent")).toBe(TREE);
  });

  it("login intent keeps textbox and button matching keywords", () => {
    const result = applyIntent(TREE, "login");
    expect(result).toContain("textbox");
    expect(result).toContain("Email");
    expect(result).toContain("button");
    expect(result).toContain("Login");
    expect(result).toContain("link");
    expect(result).toContain("Forgot");
    // password textbox should be kept (matches keyword)
    expect(result).toContain("Password");
    // paragraph "Welcome back" does NOT match login keywords — dropped
    expect(result).not.toContain("paragraph");
    expect(result).not.toContain("Welcome");
  });

  it("search intent keeps searchbox and button", () => {
    const tree = `- generic @e1
  - searchbox "Find" @e2
  - button "Search" @e3
  - paragraph "Some text" @e4`;
    const result = applyIntent(tree, "search");
    expect(result).toContain("searchbox");
    expect(result).toContain("button");
    expect(result).toContain("Search");
    expect(result).not.toContain("paragraph");
  });

  it("read_content intent keeps heading and paragraph", () => {
    const tree = `- heading "Title" @e1
- paragraph "Some article content text" @e2
- button "Buy" @e3
- link "Read more" @e4`;
    const result = applyIntent(tree, "read_content");
    expect(result).toContain("heading");
    expect(result).toContain("paragraph");
    expect(result).toContain("article");
    expect(result).not.toContain("button");
    expect(result).not.toContain("Buy");
  });

  it("nameless structural lines are kept (conservative ancestor pass-through)", () => {
    // Structural lines without a role match get no role; intent filter
    // should keep them when they are ancestors of retained lines.
    const tree = `- generic @e1
  - text @e2
    - textbox "Email" @e3`;
    const result = applyIntent(tree, "login");
    // textbox + its ancestors should be kept
    expect(result).toContain("generic");
    expect(result).toContain("textbox");
    expect(result).toContain("Email");
  });

  it("never returns blank — falls back to input", () => {
    const tree = `- paragraph "Nothing relevant" @e1`;
    const result = applyIntent(tree, "login");
    // No login-related roles or keywords → fallback to input
    expect(result).toBe(tree);
  });
});

// ---------------------------------------------------------------------------
// Snapshot handler: diff mode + intent filter
// ---------------------------------------------------------------------------
describe("snapshot handler (diff + intent)", () => {
  const SNAP_RAW = `- heading "Title" @e1
- textbox "Search" @e2
- button "Go" @e3`;
  const SNAP_CHANGED = `- heading "Title" @e1
- textbox "Search": hello @e4
- button "Go" @e5`;

  const env: Env = { GLOBAL_WAIT_SECONDS: 0 } as Env;

  function makeRegistrar() {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const register = ((opts: any) => {
      handlers[opts.name] = opts.handler;
    }) as ToolRegistrar;
    return { register, handlers };
  }

  // ---- diff mode ---------------------------------------------------------
  it("diff=true returns 'no baseline' message when no stored snapshot", async () => {
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => SNAP_RAW,
      }),
      frames: () => [],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ diff: true });
    const text = result.content[0].text as string;
    expect(text).toContain("(no baseline");
    expect(result.isError).toBeUndefined();
  });

  it("diff=true returns delta when baseline exists and page changed", async () => {
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => SNAP_CHANGED,
      }),
      frames: () => [],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    storeSnapshot(1, SNAP_RAW);
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ diff: true });
    const text = result.content[0].text as string;
    expect(result.isError).toBeUndefined();
    // Delta mode returns diff output, not the full tree
    expect(text).toContain("textbox");
    expect(text).not.toContain("(no baseline");
    // The new baseline should have been stored
    expect(getStoredSnapshot(1)).toBe(SNAP_CHANGED);
  });

  it("diff mode is not triggered when a frame is targeted", async () => {
    // diff only applies to full-page snapshots (frame === undefined).
    // When frame is set, the handler proceeds normally and the diff
    // block is skipped. We verify by confirming a normal snapshot
    // is returned (not the "no baseline" prefix).
    const { register, handlers } = makeRegistrar();
    const mainFrame = {
      name: () => "",
      url: () => "https://example.com/",
    };
    const childFrame = {
      name: () => "child",
      url: () => "about:blank",
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => SNAP_RAW,
      }),
    };
    const mockPage = {
      frames: () => [mainFrame, childFrame],
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => SNAP_RAW,
      }),
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ diff: true, frame: "child" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    // diff disabled for frame — returns normal filtered snapshot
    expect(text).not.toContain("(no baseline");
  });

  // ---- A4: intent filter -----------------------------------------------------
  it("intent=login filters after filterTree", async () => {
    const { register, handlers } = makeRegistrar();
    const loginSnap =
      '- generic @e1\n  - textbox "Email" [active] @e2\n  - textbox "Password" @e3\n  - button "Login" @e4\n  - paragraph "Welcome" @e5';
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => loginSnap,
      }),
      frames: () => [],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ filter: "interactive", intent: "login" });
    const text = result.content[0].text as string;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("textbox");
    expect(text).toContain("Email");
    expect(text).toContain("button");
    expect(text).toContain("Login");
    // paragraph "Welcome" should be dropped by intent filter
    expect(text).not.toContain("Welcome");
  });

  it("intent=read_content (no filter arg) sees the full tree — heading survives", async () => {
    // Regression: content intents need the FULL tree, not the interactive default.
    // Without this fix, the interactive filter strips headings BEFORE applyIntent runs.
    const contentTree =
      '- generic @e1\n  - heading "Welcome" @e2\n  - paragraph "Article body" @e3\n  - textbox "Password" @e4';
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => contentTree,
      }),
      frames: () => [],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ intent: "read_content" });
    const text = result.content[0].text as string;
    expect(result.isError).toBeUndefined();
    // heading + paragraph survive (read_content role set)
    expect(text).toContain("heading");
    expect(text).toContain("Welcome");
    expect(text).toContain("paragraph");
    // textbox "Password" NOT in read_content role set — dropped
    expect(text).not.toContain("Password");
  });

  it("intent=login (no filter arg) still filters by login roles correctly", async () => {
    const loginTree =
      '- generic @e1\n  - heading "Title" @e2\n  - textbox "Email" @e3\n  - button "Login" @e4\n  - paragraph "Intro" @e5';
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => loginTree,
      }),
      frames: () => [],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    const result = await handlers.snapshot({ intent: "login" });
    const text = result.content[0].text as string;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("textbox");
    expect(text).toContain("button");
    expect(text).toContain("Login");
    // heading "Title" + paragraph "Intro" not in login role set
    expect(text).not.toContain("Title");
    expect(text).not.toContain("Intro");
  });

  // maxChars must be a hard cap on the whole output, frames included.
  it("respects maxChars when frames block is appended", async () => {
    // Build a snapshot just under 200 chars so that with a frames block
    // (30+ chars) the total would exceed a tight maxChars.
    const tree = '- heading "A" @e1\n- heading "B" @e2\n- heading "C" @e3\n- heading "D" @e4\n';
    const { register, handlers } = makeRegistrar();
    const mainFrame = { name: () => "", url: () => "https://test/" };
    const childFrame = {
      name: () => "child",
      url: () => "https://test/frame",
    };
    const mockPage = {
      locator: (_sel: string) => ({
        ariaSnapshot: async (_opts?: unknown) => tree,
      }),
      frames: () => [mainFrame, childFrame],
    } as any;
    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
    } as unknown as BrowserManager;

    clearAllSnapshots();
    registerExtraction(register, mgr, env);
    // Choose a maxChars that is tight — contentBudget reserves frames budget.
    const result = await handlers.snapshot({ maxChars: 120 });
    const text = result.content[0].text as string;
    expect(result.isError).toBeUndefined();
    // frames must be present
    expect(text).toContain("--- frames ---");
    expect(text).toContain('[0] name="child"');
    // total output must not exceed maxChars (tiny margin for floor)
    expect(text.length).toBeLessThanOrEqual(125);
    // content was truncated to fit
    expect(text).toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// page_state handler
// ---------------------------------------------------------------------------
describe("page_state handler", () => {
  const env: Env = { GLOBAL_WAIT_SECONDS: 0 } as Env;

  function makeRegistrar() {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const register = ((opts: any) => {
      handlers[opts.name] = opts.handler;
    }) as ToolRegistrar;
    return { register, handlers };
  }

  it("returns compact JSON with url, title, scrollPercent, elementCount", async () => {
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      evaluate: async (fn: any) => {
        // Browser-context function — return known values
        return fn();
      },
    } as any;

    // Override evaluate to return the fake browser-side result.
    mockPage.evaluate = async (_fn: any) => ({
      url: "https://example.com/page",
      title: "Example Page",
      scrollPercent: 42,
      elementCount: 1500,
      interactiveCount: 23,
    });

    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
      getLastDialog: () => null,
    } as unknown as BrowserManager;

    registerExtraction(register, mgr, env);
    const result = await handlers.page_state({});
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.url).toBe("https://example.com/page");
    expect(parsed.title).toBe("Example Page");
    expect(parsed.scrollPercent).toBe(42);
    expect(parsed.elementCount).toBe(1500);
    expect(parsed.interactiveCount).toBe(23);
    expect(parsed.hasDialog).toBe(false);
    expect(result.structuredContent).toEqual(parsed);
  });

  it("hasDialog=false by default", async () => {
    const { register, handlers } = makeRegistrar();
    const mockPage = {
      evaluate: async (_fn: any) => ({
        url: "https://example.com/",
        title: "Test",
        scrollPercent: 0,
        elementCount: 10,
        interactiveCount: 0,
      }),
    } as any;

    const mgr = {
      getPage: async () => mockPage,
      resolveTab: () => 1,
      getLastDialog: () => null,
    } as unknown as BrowserManager;

    registerExtraction(register, mgr, env);
    const result = await handlers.page_state({});
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.hasDialog).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: snapshot filter schema has no zod default (intent owns its base)
// ---------------------------------------------------------------------------
describe("snapshotFilterSchema guard", () => {
  it("parses undefined as undefined — no coerced default", () => {
    // A zod .default() would coerce undefined to "interactive".
    // The handler relies on filter being truly undefined when the caller
    // omits it, so intent-based content intents pick base "all".
    expect(snapshotFilterSchema.parse(undefined)).toBeUndefined();
  });
});
