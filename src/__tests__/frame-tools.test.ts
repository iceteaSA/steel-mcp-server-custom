import { describe, it, expect, beforeEach } from "bun:test";
import { register as registerExtraction } from "../tools/extraction.js";
import { register as registerInteraction } from "../tools/interaction.js";
import { getStoredSnapshot, clearSnapshot } from "../snapshot.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar, ToolSpec } from "../tools/shared.js";

const mockEnv: Env = {
  BROWSER_MODE: "steel",
  STEEL_API_KEY: undefined,
  STEEL_BASE_URL: "http://localhost:3000",
  MAX_INLINE_BYTES: 512000,
  OUTPUT_DIR: "/tmp/steel-mcp-frame-test",
  OUTPUT_ROOT: "/tmp/steel-mcp-frame-test",
  UPLOAD_ROOT: "/tmp/steel-mcp-frame-test",
  DEFAULT_SCREENSHOT_QUALITY: 80,
  DEFAULT_VIEWPORT_WIDTH: 1280,
  DEFAULT_VIEWPORT_HEIGHT: 720,
  GLOBAL_WAIT_SECONDS: 0,
  SETTLE_TIMEOUT_MS: 0,
  SESSION_TIMEOUT_MS: 300000,
  OPTIMIZE_BANDWIDTH: false,
  STEEL_PUBLIC_URL: undefined,
  TAB_IDLE_TIMEOUT_MS: 0,
  TAB_IDLE_SWEEP_INTERVAL_MS: 60000,
  PROFILES_DIR: "/tmp/steel-mcp-frame-test/profiles",
  CREDENTIALS_FILE: "/tmp/steel-mcp-frame-test/credentials.json",
  CREDENTIALS_PASSPHRASE: undefined,
  RELAY_PORT: 0,
  RELAY_SECRET: undefined,
  RELAY_PUBLIC_URL: undefined,
  RELAY_BIND_ADDR: "127.0.0.1",
  TOOLSETS: undefined,
} as any;

function makeFakeFrame() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const locator = (sel: string) => ({
    ariaSnapshot: async () => "frame-tree",
    waitFor: async () => {},
    elementHandle: async () => null,
    evaluate: async (fn: unknown, arg: unknown) => {
      calls.push({ method: "locator.evaluate", args: [sel, fn, arg] });
      return {};
    },
    click: async (opts: unknown) => {
      calls.push({ method: "locator.click", args: [sel, opts] });
    },
    fill: async (value: unknown, opts: unknown) => {
      calls.push({ method: "locator.fill", args: [sel, value, opts] });
    },
    selectOption: async (...args: unknown[]) => {
      calls.push({ method: "locator.selectOption", args: [sel, ...args] });
    },
    check: async (opts: unknown) => {
      calls.push({ method: "locator.check", args: [sel, opts] });
    },
    uncheck: async (opts: unknown) => {
      calls.push({ method: "locator.uncheck", args: [sel, opts] });
    },
    press: async (key: unknown) => {
      calls.push({ method: "locator.press", args: [sel, key] });
    },
  });

  const frame: any = {
    calls,
    name: () => "child-frame",
    url: () => "https://example.com/child",
    locator,
    waitForSelector: async (sel: string, opts: unknown) => {
      calls.push({ method: "waitForSelector", args: [sel, opts] });
    },
    waitForFunction: async (fn: unknown, arg: unknown, opts: unknown) => {
      calls.push({ method: "waitForFunction", args: [fn, arg, opts] });
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      calls.push({ method: "evaluate", args: [fn, arg] });
      if (Array.isArray(arg)) {
        return { [arg[0]]: { tag: "input", type: "text" } };
      }
      if (arg && typeof arg === "object") {
        const a = arg as Record<string, unknown>;
        if (a.mode === "innerText") return { text: "frame-text" };
        if (a.attrNames) return [{ text: "frame" }];
        if (a.fieldMap) return [{ t: "frame" }];
        if (a.yDelta !== undefined) {
          return { before: 0, after: 10, pageHeight: 100, viewportHeight: 50 };
        }
      }
      return undefined;
    },
  };

  return frame;
}

function makeFakePage(frame: any) {
  return {
    frames: () => [frame, frame], // index 0 = main, index 1 = child
    locator: (_sel: string) => ({
      ariaSnapshot: async () => "page-tree",
      evaluate: async () => ({}),
    }),
    url: () => "https://example.com/page",
    evaluate: async () => undefined,
  } as any;
}

function buildRegistry() {
  const frame = makeFakeFrame();
  const page = makeFakePage(frame);
  const mgr = {
    resolveTab: () => 1,
    getPage: async () => page,
    dialogNotice: () => "",
  } as unknown as BrowserManager;

  const specs: ToolSpec[] = [];
  const register = ((spec: ToolSpec) => specs.push(spec)) as ToolRegistrar;
  registerInteraction(register, mgr, mockEnv);
  registerExtraction(register, mgr, mockEnv);

  const find = (name: string) => specs.find((s) => s.name === name)!;
  return { specs, frame, page, find };
}

describe("snapshot frame isolation", () => {
  beforeEach(() => {
    clearSnapshot(1);
  });

  it("stores the snapshot for the main page when frame is omitted", async () => {
    const { find } = buildRegistry();
    const snapshot = find("snapshot");
    const result = await snapshot.handler({});

    expect(result.isError).toBeUndefined();
    expect(getStoredSnapshot(1)).toContain("page-tree");
  });

  it("does NOT store the snapshot when a child frame is targeted", async () => {
    const { find } = buildRegistry();
    const snapshot = find("snapshot");
    const result = await snapshot.handler({ frame: "child-frame", filter: "all" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("frame-tree");
    expect(getStoredSnapshot(1)).toBeUndefined();
  });

  it("appends a frames section when child frames exist", async () => {
    const { find } = buildRegistry();
    const snapshot = find("snapshot");
    const result = await snapshot.handler({ filter: "all" });

    const text = result.content[0].text;
    expect(text).toContain("--- frames ---");
    expect(text).toContain('[0] name="child-frame"');
    expect(text).toContain("url=https://example.com/child");
  });

  it("includes frames section under default interactive filter", async () => {
    const { find } = buildRegistry();
    const snapshot = find("snapshot");
    // No filter arg — defaults to "interactive", which strips non-interactive
    // nodes. The frames block is appended AFTER filtering so it always survives.
    const result = await snapshot.handler({});

    const text = result.content[0].text;
    expect(text).toContain("--- frames ---");
    expect(text).toContain('[0] name="child-frame"');
    expect(text).toContain("url=https://example.com/child");
  });

  it("returns isError when an invalid frame is requested", async () => {
    const { find } = buildRegistry();
    const snapshot = find("snapshot");
    const result = await snapshot.handler({ frame: "missing" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No frame matches "missing"');
  });
});

describe("frame param routes element operations through the resolved frame", () => {
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    expectedMethod: string;
  }> = [
    { name: "click", args: { selector: "#x" }, expectedMethod: "locator.click" },
    {
      name: "fill",
      args: { fields: [{ selector: "#x", value: "v" }] },
      expectedMethod: "locator.fill",
    },
    { name: "scroll", args: { direction: "down" }, expectedMethod: "evaluate" },
    { name: "wait_for", args: { selector: "#x" }, expectedMethod: "waitForSelector" },
    { name: "get_page_text", args: {}, expectedMethod: "evaluate" },
    {
      name: "get_attrs",
      args: { selector: "#x", attrs: ["text"] },
      expectedMethod: "evaluate",
    },
    {
      name: "extract",
      args: { selector: "div", fields: { t: "." } },
      expectedMethod: "evaluate",
    },
    { name: "evaluate", args: { expression: "1" }, expectedMethod: "evaluate" },
  ];

  it.each(cases)(
    "$name targets the frame",
    async ({
      name,
      args,
      expectedMethod,
    }: {
      name: string;
      args: Record<string, unknown>;
      expectedMethod: string;
    }) => {
      const { find, frame } = buildRegistry();
      const tool = find(name);
      const result = await tool.handler({ frame: "child-frame", ...args });

      expect(result.isError).toBeUndefined();
      expect(
        frame.calls.some((c: { method: string }) => c.method === expectedMethod),
        `expected ${name} to call ${expectedMethod} on the frame`,
      ).toBe(true);
    },
  );
});
