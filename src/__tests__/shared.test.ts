import { describe, it, expect } from "bun:test";
import { toSelector, decorateRefError } from "../tools/shared.js";

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
