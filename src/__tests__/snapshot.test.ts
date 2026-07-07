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
} from "../snapshot.js";

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
