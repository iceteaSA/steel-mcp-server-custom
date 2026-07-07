import { describe, it, expect, beforeEach } from "bun:test";
import { register as registerExtraction } from "../tools/extraction.js";
import { getStoredSnapshot, clearSnapshot } from "../snapshot.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar, ToolSpec } from "../tools/shared.js";

function fakeLocator(tree: string) {
  return {
    ariaSnapshot: async () => tree,
  };
}

function setup() {
  const childFrame = {
    locator: () => fakeLocator("frame-tree"),
    name: () => "child",
    url: () => "https://example.com/child",
  };

  const page = {
    frames: () => [page, childFrame],
    locator: () => fakeLocator("page-tree"),
    url: () => "https://example.com/page",
  };

  const mgr = {
    resolveTab: () => 1,
    getPage: async () => page as any,
  } as unknown as BrowserManager;

  const specs: ToolSpec[] = [];
  const register = ((spec: ToolSpec) => specs.push(spec)) as ToolRegistrar;
  registerExtraction(register, mgr, {} as Env);
  const snapshot = specs.find((s) => s.name === "snapshot")!;

  return { snapshot, page, childFrame };
}

describe("snapshot frame isolation", () => {
  beforeEach(() => {
    clearSnapshot(1);
  });

  it("stores the snapshot for the main page when frame is omitted", async () => {
    const { snapshot } = setup();
    const result = await snapshot.handler({});

    expect(result.isError).toBeUndefined();
    expect(getStoredSnapshot(1)).toContain("page-tree");
  });

  it("does NOT store the snapshot when a child frame is targeted", async () => {
    const { snapshot } = setup();
    const result = await snapshot.handler({ frame: "0" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("frame-tree");
    expect(getStoredSnapshot(1)).toBeUndefined();
  });

  it("appends a frames section when child frames exist", async () => {
    const { snapshot } = setup();
    const result = await snapshot.handler({});

    const text = result.content[0].text;
    expect(text).toContain("--- frames ---");
    expect(text).toContain('[0] name="child"');
    expect(text).toContain("url=https://example.com/child");
  });

  it("returns isError when an invalid frame is requested", async () => {
    const { snapshot } = setup();
    const result = await snapshot.handler({ frame: "missing" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No frame matches "missing"');
  });
});
