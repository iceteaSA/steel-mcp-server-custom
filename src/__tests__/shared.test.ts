import { describe, it, expect } from "bun:test";
import { resolveFrame } from "../tools/shared.js";

function makeFrame(name: string, url: string): any {
  return {
    name: () => name,
    url: () => url,
  };
}

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
