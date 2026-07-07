import { describe, it, expect, mock } from "bun:test";
import type { Page } from "patchright";
import {
  toSelector,
  decorateRefError,
  resolveFrame,
  execClick,
  execFillField,
  execPressKey,
  execScroll,
} from "../tools/shared.js";

// ---------------------------------------------------------------------------
// toSelector
// ---------------------------------------------------------------------------
describe("toSelector", () => {
  it("returns CSS selector unchanged when only selector is provided", () => {
    expect(toSelector({ selector: "#main" })).toBe("#main");
    expect(toSelector({ selector: "button.submit" })).toBe("button.submit");
    expect(toSelector({ selector: "input[name=email]" })).toBe("input[name=email]");
  });

  it("converts ref to aria-ref= selector", () => {
    expect(toSelector({ ref: "e5" })).toBe("aria-ref=e5");
    expect(toSelector({ ref: "e42" })).toBe("aria-ref=e42");
    expect(toSelector({ ref: "e999" })).toBe("aria-ref=e999");
  });

  it("throws when neither selector nor ref is provided", () => {
    expect(() => toSelector({})).toThrow("Pass selector or ref");
    expect(() => toSelector({ selector: undefined, ref: undefined })).toThrow(
      "Pass selector or ref",
    );
    expect(() => toSelector({ selector: "", ref: "" })).toThrow("Pass selector or ref");
  });

  it("throws when both selector and ref are provided", () => {
    expect(() => toSelector({ selector: "#main", ref: "e5" })).toThrow(
      "Pass selector OR ref, not both",
    );
  });

  it("throws on invalid ref format", () => {
    expect(() => toSelector({ ref: "e" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "5" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "ex5" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "E5" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "ref-e5" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "e" })).toThrow("expected format e<digits>");
  });

  it("rejects empty-string ref", () => {
    expect(() => toSelector({ ref: "" })).toThrow("Pass selector or ref");
  });

  // A1: compact @eN ref format — @e5 and bare e5 both resolve to aria-ref=e5
  it("accepts @eN ref format (compact output from snapshot)", () => {
    expect(toSelector({ ref: "@e5" })).toBe("aria-ref=e5");
    expect(toSelector({ ref: "@e42" })).toBe("aria-ref=e42");
    expect(toSelector({ ref: "@e999" })).toBe("aria-ref=e999");
  });

  it("accepts bare eN ref format unchanged", () => {
    expect(toSelector({ ref: "e5" })).toBe("aria-ref=e5");
  });

  it("throws on invalid @-prefixed ref (non-digit after @e)", () => {
    expect(() => toSelector({ ref: "@x" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "@" })).toThrow("Invalid ref");
    expect(() => toSelector({ ref: "@e" })).toThrow("Invalid ref");
  });
});

// ---------------------------------------------------------------------------
// decorateRefError
// ---------------------------------------------------------------------------
describe("decorateRefError", () => {
  it("appends stale-ref hint for aria-ref timeout error", () => {
    const err = new Error('Waiting for selector "aria-ref=e5" timed out after 10000ms');
    const result = decorateRefError(err, "aria-ref=e5");
    expect(result).toContain("timed out");
    expect(result).toContain("Ref may be stale — take a fresh snapshot.");
  });

  it("appends stale-ref hint when usedSelector starts with aria-ref=", () => {
    // Error message doesn't mention aria-ref but the selector was ref-based
    const err = new Error("Element not found");
    const result = decorateRefError(err, "aria-ref=e42");
    expect(result).toContain("Ref may be stale — take a fresh snapshot.");
  });

  it("appends stale-ref hint for 'not found' error with aria-ref", () => {
    const err = new Error('locator "aria-ref=e7" not found in 10000ms');
    const result = decorateRefError(err, "aria-ref=e7");
    expect(result).toContain("Ref may be stale — take a fresh snapshot.");
  });

  it("does NOT append hint for CSS selector timeout", () => {
    const err = new Error('Waiting for selector "#main" timed out');
    const result = decorateRefError(err, "#main");
    expect(result).not.toContain("stale");
    expect(result).toContain("timed out");
  });

  it("does NOT append hint for non-timeout/non-not-found error even with aria-ref selector", () => {
    const err = new Error("Navigation failed: connection refused");
    const result = decorateRefError(err, "aria-ref=e5");
    // Error message does NOT contain timeout/not-found keywords
    expect(result).not.toContain("stale");
  });

  it("handles non-Error input", () => {
    expect(decorateRefError("timeout waiting for aria-ref=e1", "aria-ref=e1")).toContain("stale");
    expect(decorateRefError("plain error", "#main")).toBe("plain error");
  });

  it("handles null/undefined input gracefully", () => {
    const result = decorateRefError(null, "aria-ref=e1");
    expect(typeof result).toBe("string");
    expect(result).not.toContain("stale"); // null → "" — no aria-ref or timeout match
  });
});

// ---------------------------------------------------------------------------
// resolveFrame
// ---------------------------------------------------------------------------
function makeFrame(name: string, url: string): any {
  return {
    name: () => name,
    url: () => url,
  };
}

// ---------------------------------------------------------------------------
// Shared element executors
// ---------------------------------------------------------------------------

function makeFakePage(): Page {
  return {
    url: () => "https://example.com",
    keyboard: { press: mock(() => Promise.resolve()) },
    waitForFunction: mock(() => Promise.resolve()),
    locator: mock(() => makeFakeLocator()),
    frames: () => [],
    evaluate: mock(() =>
      Promise.resolve({ before: 0, after: 100, pageHeight: 1000, viewportHeight: 500 }),
    ),
  } as unknown as Page;
}

function makeFakeLocator() {
  return {
    click: mock(() => Promise.resolve()),
    fill: mock(() => Promise.resolve()),
    press: mock(() => Promise.resolve()),
    selectOption: mock(() => Promise.resolve()),
    check: mock(() => Promise.resolve()),
    uncheck: mock(() => Promise.resolve()),
    focus: mock(() => Promise.resolve()),
    elementHandle: mock(() =>
      Promise.resolve({
        evaluate: mock(() => Promise.resolve({ tag: "input", type: "text" })),
        dispose: mock(() => Promise.resolve()),
      }),
    ),
    waitFor: mock(() => Promise.resolve()),
    evaluate: mock(() =>
      Promise.resolve({ before: 0, after: 100, pageHeight: 1000, viewportHeight: 500 }),
    ),
  };
}

const baseEnv = {
  SETTLE_TIMEOUT_MS: 0,
  GLOBAL_WAIT_SECONDS: 0,
};

describe("execClick", () => {
  it("clicks a CSS selector and settles", async () => {
    const page = makeFakePage();
    await execClick(page, baseEnv as any, { selector: "#btn" });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.click).toHaveBeenCalled();
  });

  it("clicks a ref and settles", async () => {
    const page = makeFakePage();
    await execClick(page, baseEnv as any, { ref: "e3" });
    expect(page.locator).toHaveBeenCalledWith("aria-ref=e3");
  });
});

describe("execFillField", () => {
  it("fills a text input via CSS selector", async () => {
    const page = makeFakePage();
    (page.evaluate as any).mockImplementation((fn: any, selectors: string[]) => {
      const out: Record<string, { tag: string; type: string }> = {};
      for (const s of selectors) out[s] = { tag: "input", type: "text" };
      return Promise.resolve(out);
    });

    await execFillField(page, baseEnv as any, { selector: "#email", value: "a@b.com" });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.fill).toHaveBeenCalledWith("a@b.com", { timeout: 10000 });
  });

  it("checks a checkbox when value is truthy", async () => {
    const page = makeFakePage();
    (page.evaluate as any).mockImplementation((fn: any, selectors: string[]) => {
      const out: Record<string, { tag: string; type: string }> = {};
      for (const s of selectors) out[s] = { tag: "input", type: "checkbox" };
      return Promise.resolve(out);
    });

    await execFillField(page, baseEnv as any, { selector: "#agree", value: "true" });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.check).toHaveBeenCalled();
  });

  it("respects explicit kind over auto-detection", async () => {
    const page = makeFakePage();
    await execFillField(page, baseEnv as any, {
      selector: "#x",
      value: "hello",
      kind: "text",
    });
    // evaluate should not be called for kind-override fills
    expect(page.evaluate).not.toHaveBeenCalled();
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.fill).toHaveBeenCalledWith("hello", { timeout: 10000 });
  });

  it("selects by value with explicit select kind", async () => {
    const page = makeFakePage();
    await execFillField(page, baseEnv as any, {
      selector: "#country",
      value: "US",
      kind: "select",
    });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.selectOption).toHaveBeenCalledWith("US", { timeout: 10000 });
  });

  it("selects by label with explicit selectLabel kind", async () => {
    const page = makeFakePage();
    await execFillField(page, baseEnv as any, {
      selector: "#country",
      value: "United States",
      kind: "selectLabel",
    });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.selectOption).toHaveBeenCalledWith({ label: "United States" }, { timeout: 10000 });
  });

  it("selects by index with explicit selectIndex kind", async () => {
    const page = makeFakePage();
    await execFillField(page, baseEnv as any, {
      selector: "#country",
      value: "2",
      kind: "selectIndex",
    });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.selectOption).toHaveBeenCalledWith({ index: 2 }, { timeout: 10000 });
  });

  it("throws on non-numeric selectIndex value", async () => {
    const page = makeFakePage();
    await expect(
      execFillField(page, baseEnv as any, {
        selector: "#country",
        value: "two",
        kind: "selectIndex",
      }),
    ).rejects.toThrow(/selectIndex expects numeric value/);
  });
});

describe("execPressKey", () => {
  it("presses a key at page level", async () => {
    const page = makeFakePage();
    await execPressKey(page, baseEnv as any, { key: "Enter" });
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("focuses an element before pressing", async () => {
    const page = makeFakePage();
    await execPressKey(page, baseEnv as any, { selector: "#input", key: "Tab" });
    const loc = (page.locator as any).mock.results[0].value;
    expect(loc.focus).toHaveBeenCalledWith({ timeout: 5000 });
    expect(page.keyboard.press).toHaveBeenCalledWith("Tab");
  });
});

describe("execScroll", () => {
  it("scrolls the page down and returns position", async () => {
    const page = makeFakePage();
    const result = await execScroll(page, baseEnv as any, { direction: "down", pixels: 250 });
    expect(result.after).toBe(100);
    expect(page.evaluate).toHaveBeenCalled();
  });
});

describe("resolveFrame", () => {
  it("returns the page when frame is omitted", () => {
    const page = { frames: () => [] } as any;
    expect(resolveFrame(page)).toBe(page);
  });

  it("matches by exact frame name", () => {
    const checkout = makeFrame("checkout", "https://example.com/checkout");
    const page = { frames: () => [page, checkout] } as any;
    expect(resolveFrame(page, "checkout")).toBe(checkout);
  });

  it("matches by URL substring", () => {
    const checkout = makeFrame("", "https://example.com/checkout");
    const page = { frames: () => [page, checkout] } as any;
    expect(resolveFrame(page, "checkout")).toBe(checkout);
  });

  it("prefers name match over URL substring", () => {
    const named = makeFrame("target", "https://example.com/other");
    const byUrl = makeFrame("", "https://example.com/target");
    const page = { frames: () => [page, named, byUrl] } as any;
    expect(resolveFrame(page, "target")).toBe(named);
  });

  it("matches by child-frame index (0-based, excluding main frame)", () => {
    const first = makeFrame("first", "https://example.com/first");
    const second = makeFrame("second", "https://example.com/second");
    const page = { frames: () => [page, first, second] } as any;
    expect(resolveFrame(page, "0")).toBe(first);
    expect(resolveFrame(page, "1")).toBe(second);
  });

  it("throws an informative error when no frame matches", () => {
    const first = makeFrame("first", "https://example.com/first");
    const second = makeFrame("second", "https://example.com/second");
    const page = { frames: () => [page, first, second] } as any;
    let message = "";
    try {
      resolveFrame(page, "missing");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toInclude('No frame matches "missing"');
    expect(message).toInclude('[0] name="first"');
    expect(message).toInclude("url=https://example.com/first");
    expect(message).toInclude('[1] name="second"');
    expect(message).toInclude("url=https://example.com/second");
  });
});
