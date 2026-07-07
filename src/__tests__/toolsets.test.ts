/**
 * Unit tests for toolset resolution + registrar gating.
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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Tool registrations (in-process, no browser needed).
import { register as registerTabs } from "../tools/tabs.js";
import { register as registerScreenshots } from "../tools/screenshots.js";
import { register as registerExtraction } from "../tools/extraction.js";
import { register as registerInteraction } from "../tools/interaction.js";
import { register as registerNavigation } from "../tools/navigation.js";
import { register as registerSession } from "../tools/session.js";
import { register as registerNetwork } from "../tools/network.js";
import { register as registerCredentials } from "../tools/credentials.js";
import { register as registerProfiles } from "../tools/profiles.js";
import { register as registerIntercept } from "../tools/intercept.js";
import { register as registerAct } from "../tools/act.js";
import { llmConfigured } from "../llm.js";

// Tools with outputSchema (structured output).
const JSON_TOOLS = new Set([
  "list_tabs",
  "get_links",
  "get_attrs",
  "extract",
  "fetch_urls",
  "cookies",
  "list_profiles",
  "credentials",
  "captcha_status",
  "page_state",
]);

// Stub BrowserManager — tools that call mgr methods will throw, but
// registration and tools/list don't invoke handlers.
const stubMgr = {} as any;
const stubEnv = {} as any;

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
  it("includes all 9 toolset values", () => {
    expect(ALL_TOOLSETS.length).toBe(9);
    const expected: Toolset[] = [
      "core",
      "tabs",
      "extract",
      "media",
      "network",
      "auth",
      "debug",
      "ai",
      "intercept",
    ];
    for (const t of expected) {
      expect(ALL_TOOLSETS.includes(t)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire-level completeness test (S1) — verify annotations + structured output
// via real tools/list over InMemoryTransport.
// ---------------------------------------------------------------------------

describe("tools/list wire-level completeness", () => {
  it("all 41 tools have title, description, annotations; 10 have outputSchema", async () => {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    const allToolsets = new Set(ALL_TOOLSETS);
    const { register, toolCount } = makeRegistrar(server, allToolsets);

    // Register all tools (handlers will throw if called — registration is the
    // only thing that matters here).
    registerSession(register, stubMgr, stubEnv);
    registerTabs(register, stubMgr, stubEnv);
    registerNavigation(register, stubMgr, stubEnv);
    registerInteraction(register, stubMgr, stubEnv);
    registerExtraction(register, stubMgr, stubEnv);
    registerScreenshots(register, stubMgr, stubEnv);
    registerNetwork(register, stubMgr, stubEnv);
    registerCredentials(register, stubMgr, stubEnv);
    registerProfiles(register, stubMgr, stubEnv);
    registerIntercept(register, stubMgr, stubEnv);

    // 41 tools total (without act/extract_ai since ACT_LLM env not set)
    expect(toolCount()).toBe(41);

    // Create client-server pair
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.listTools();
    const tools = result.tools;

    // Exact tool count on the wire
    expect(tools.length).toBe(41);

    for (const tool of tools) {
      const name = tool.name;

      // Non-empty title (top-level + annotations.title)
      const tTitle = (tool as any).title as string | undefined;
      expect(tTitle || tool.annotations?.title, `${name}: title missing or empty`).toBeTruthy();
      expect(
        ((tTitle ?? tool.annotations?.title ?? "") as string).length,
        `${name}: title empty`,
      ).toBeGreaterThan(0);

      // Non-empty description
      expect(tool.description, `${name}: description missing`).toBeTruthy();
      expect((tool.description ?? "").length, `${name}: description empty`).toBeGreaterThan(0);

      // Annotations object present
      expect(tool.annotations, `${name}: annotations missing`).toBeTruthy();
      expect(
        typeof tool.annotations?.readOnlyHint,
        `${name}: annotations.readOnlyHint not boolean`,
      ).toBe("boolean");
      expect(
        typeof tool.annotations?.destructiveHint,
        `${name}: annotations.destructiveHint not boolean`,
      ).toBe("boolean");
      expect(
        typeof tool.annotations?.idempotentHint,
        `${name}: annotations.idempotentHint not boolean`,
      ).toBe("boolean");
      expect(
        typeof tool.annotations?.openWorldHint,
        `${name}: annotations.openWorldHint not boolean`,
      ).toBe("boolean");

      // outputSchema for JSON-shaped tools
      if (JSON_TOOLS.has(name)) {
        expect(tool.outputSchema, `${name}: outputSchema missing`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AI tool registration gating — mirrors src/index.ts conditional registration
// ---------------------------------------------------------------------------

describe("ai toolset gating", () => {
  async function listToolNames(env: any): Promise<string[]> {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    const allToolsets = new Set(ALL_TOOLSETS);
    const { register } = makeRegistrar(server, allToolsets);

    registerSession(register, stubMgr, env);
    registerTabs(register, stubMgr, env);
    registerNavigation(register, stubMgr, env);
    registerInteraction(register, stubMgr, env);
    registerExtraction(register, stubMgr, env);
    registerScreenshots(register, stubMgr, env);
    registerNetwork(register, stubMgr, env);
    registerCredentials(register, stubMgr, env);
    registerProfiles(register, stubMgr, env);
    registerIntercept(register, stubMgr, env);
    if (llmConfigured(env)) {
      registerAct(register, stubMgr, env);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.listTools();
    return result.tools.map((t) => t.name);
  }

  it("hides act and extract_ai when LLM env is not configured", async () => {
    const names = await listToolNames(stubEnv);
    expect(names).not.toContain("act");
    expect(names).not.toContain("extract_ai");
  });

  it("shows act and extract_ai when LLM env is configured", async () => {
    const env = {
      ...stubEnv,
      ACT_LLM_BASE_URL: "http://localhost:11434/v1",
      ACT_LLM_MODEL: "gemma",
    };
    const names = await listToolNames(env);
    expect(names).toContain("act");
    expect(names).toContain("extract_ai");
  });
});
