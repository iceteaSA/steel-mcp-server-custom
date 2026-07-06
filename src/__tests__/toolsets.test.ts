/**
 * Unit tests for toolset resolution + registrar gating (A9).
 *
 * Does NOT require a browser connection — tests the pure logic.
 */
import { describe, it, expect } from "bun:test";
import {
  resolveToolsets,
  makeRegistrar,
  ALL_TOOLSETS,
  type ToolSpec,
  type Toolset,
} from "../tools/shared.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// resolveToolsets
// ---------------------------------------------------------------------------

describe("resolveToolsets", () => {
  it("returns all toolsets when neither CLI nor env is set", () => {
    const set = resolveToolsets(undefined, undefined);
    expect(set.size).toBe(ALL_TOOLSETS.length);
    for (const t of ALL_TOOLSETS) {
      expect(set.has(t)).toBe(true);
    }
  });

  it("force-includes core even when omitted from input", () => {
    const set = resolveToolsets("tabs", undefined);
    expect(set.has("core")).toBe(true);
    expect(set.has("tabs")).toBe(true);
    // Other toolsets should NOT be present
    expect(set.has("extract")).toBe(false);
    expect(set.has("media")).toBe(false);
  });

  it("parses comma-separated CLI arg", () => {
    const set = resolveToolsets("tabs,extract,debug", undefined);
    expect(set.has("core")).toBe(true);
    expect(set.has("tabs")).toBe(true);
    expect(set.has("extract")).toBe(true);
    expect(set.has("debug")).toBe(true);
    expect(set.has("media")).toBe(false);
    expect(set.has("network")).toBe(false);
    expect(set.has("auth")).toBe(false);
  });

  it("CLI arg beats env var", () => {
    const set = resolveToolsets("tabs", "extract,media");
    expect(set.has("core")).toBe(true);
    expect(set.has("tabs")).toBe(true);
    expect(set.has("extract")).toBe(false);
    expect(set.has("media")).toBe(false);
  });

  it("falls back to env var when CLI is undefined", () => {
    const set = resolveToolsets(undefined, "network,auth");
    expect(set.has("core")).toBe(true);
    expect(set.has("network")).toBe(true);
    expect(set.has("auth")).toBe(true);
    expect(set.has("tabs")).toBe(false);
  });

  it("throws with valid list when an unknown toolset is passed", () => {
    expect(() => resolveToolsets("tabs,foobar", undefined)).toThrow(/Invalid toolset\(s\): foobar/);
  });

  it("handles whitespace in comma-separated input", () => {
    const set = resolveToolsets(" tabs ,  extract , debug ", undefined);
    expect(set.has("core")).toBe(true);
    expect(set.has("tabs")).toBe(true);
    expect(set.has("extract")).toBe(true);
    expect(set.has("debug")).toBe(true);
  });

  it("ignores empty segments", () => {
    const set = resolveToolsets("tabs,,extract", undefined);
    expect(set.has("core")).toBe(true);
    expect(set.has("tabs")).toBe(true);
    expect(set.has("extract")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// makeRegistrar — gating logic
// ---------------------------------------------------------------------------

describe("makeRegistrar", () => {
  function makeStubServer(): McpServer {
    return new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  }

  function stubSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
    return {
      name: "test_tool",
      title: "Test Tool",
      description: "A test tool.",
      toolset: "core" as Toolset,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      ...overrides,
    };
  }

  it("always registers core tools regardless of active set", () => {
    const server = makeStubServer();
    const active = new Set<Toolset>(["tabs"]); // core not in active set
    const { register, toolCount } = makeRegistrar(server, active);

    register(stubSpec({ toolset: "core" }));
    expect(toolCount()).toBe(1);
  });

  it("skips non-core tools whose toolset is inactive", () => {
    const server = makeStubServer();
    const active = new Set<Toolset>(["core"]); // only core active
    const { register, toolCount } = makeRegistrar(server, active);

    register(stubSpec({ name: "extract_tool", toolset: "extract" }));
    expect(toolCount()).toBe(0);
  });

  it("registers non-core tools when their toolset is active", () => {
    const server = makeStubServer();
    const active = new Set<Toolset>(["core", "tabs", "extract"]);
    const { register, toolCount } = makeRegistrar(server, active);

    register(stubSpec({ name: "ext_tool", toolset: "extract" }));
    register(stubSpec({ name: "tab_tool", toolset: "tabs" }));
    expect(toolCount()).toBe(2);
  });

  it("toolCount reflects only registered tools", () => {
    const server = makeStubServer();
    const active = new Set<Toolset>(["core", "tabs"]);
    const { register, toolCount } = makeRegistrar(server, active);

    // core + tabs are active, extract is not
    register(stubSpec({ name: "a", toolset: "core" }));
    register(stubSpec({ name: "b", toolset: "tabs" }));
    register(stubSpec({ name: "c", toolset: "extract" })); // skipped
    register(stubSpec({ name: "d", toolset: "core" }));

    expect(toolCount()).toBe(3); // a, b, d
  });
});

// ---------------------------------------------------------------------------
// ALL_TOOLSETS completeness
// ---------------------------------------------------------------------------

describe("ALL_TOOLSETS", () => {
  it("includes all 7 toolset values", () => {
    expect(ALL_TOOLSETS.length).toBe(7);
    const expected: Toolset[] = ["core", "tabs", "extract", "media", "network", "auth", "debug"];
    for (const t of expected) {
      expect(ALL_TOOLSETS.includes(t)).toBe(true);
    }
  });
});
