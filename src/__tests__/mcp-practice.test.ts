import { expect, test } from "bun:test";
import { z } from "zod";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import * as groups from "../tools/index.js";
import type { ToolSpec } from "../tools/shared.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import { BrowserManager as Manager } from "../manager.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedToolNames = [
  "act",
  "cancel_signin",
  "captcha_status",
  "click",
  "click_at",
  "close_tabs",
  "cookies",
  "create_profile",
  "credentials",
  "delete_profile",
  "download_file",
  "evaluate",
  "export_har",
  "extract",
  "extract_ai",
  "fetch_urls",
  "fill",
  "get_attrs",
  "get_console",
  "get_links",
  "get_network",
  "get_page_text",
  "get_screenshot",
  "go_to_url",
  "handle_dialog",
  "history",
  "intercept",
  "list_profiles",
  "list_tabs",
  "mouse_down",
  "mouse_move",
  "mouse_up",
  "new_tab",
  "page_state",
  "press_key",
  "request_human",
  "request_signin",
  "save_profile",
  "scroll",
  "signin_status",
  "smoke_test",
  "snapshot",
  "solve_captcha",
  "start_browser",
  "stop_browser",
  "upload_file",
  "use_credential",
  "wait_for",
  "wait_for_human",
];

function specs(mgr: Partial<BrowserManager> = {}, overrides: Record<string, string> = {}) {
  const tools: ToolSpec[] = [];
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    RELAY_PORT: "0",
    STEEL_HIDDEN_TEXT: "off",
    ...overrides,
  });
  for (const register of Object.values(groups))
    register((tool) => tools.push(tool), mgr as BrowserManager, env);
  return tools;
}

test("every tool explicitly declares all four MCP safety hints", async () => {
  const env = EnvSchema.parse({ STEEL_LANES: "on", BROWSER_MODE: "local" });
  const manager = new Manager(env);
  const server = new McpServer({ name: "annotation-policy", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), { manager, env });
  for (const register of Object.values(groups))
    register(handle.register, handle.manager ?? manager, env);
  const client = new Client({ name: "annotation-policy", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const listed = await client.listTools();
  const tools = listed.tools.map((tool) => {
    const { title: _title, ...annotations } = tool.annotations ?? {};
    return { ...tool, annotations };
  });
  await client.close();
  await server.close();
  await handle.close?.();
  expect(tools).toHaveLength(52);
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    [...expectedToolNames, "list_lanes", "close_lane", "use_profile"].sort(),
  );
  const use = tools.find((tool) => tool.name === "use_profile")!;
  expect(use.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  expect(Object.keys(use.inputSchema.properties ?? {}).sort()).toEqual([
    "autosave",
    "name",
    "wait",
  ]);
  expect(tools.find((tool) => tool.name === "solve_captcha")?.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  for (const tool of tools) {
    for (const hint of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const) {
      expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
    }
  }
});

test("annotations cover mutating modes, arbitrary page effects, and remote navigation", () => {
  const tools = specs();
  for (const name of [
    "get_console",
    "get_screenshot",
    "get_page_text",
    "get_network",
    "export_har",
    "fetch_urls",
    "extract_ai",
    "smoke_test",
  ]) {
    expect(tools.find((tool) => tool.name === name)!.annotations.readOnlyHint, name).toBe(false);
  }
  for (const name of [
    "click",
    "fill",
    "press_key",
    "evaluate",
    "act",
    "use_credential",
    "upload_file",
    "click_at",
    "mouse_down",
    "mouse_up",
    "go_to_url",
    "history",
    "cookies",
    "save_profile",
    "get_console",
    "export_har",
  ]) {
    expect(tools.find((tool) => tool.name === name)!.annotations.destructiveHint, name).toBe(true);
  }
  for (const name of [
    "new_tab",
    "create_profile",
    "captcha_status",
    "get_console",
    "get_network",
    "list_tabs",
  ]) {
    expect(tools.find((tool) => tool.name === name)!.annotations.openWorldHint, name).toBe(true);
  }
  for (const name of [
    "go_to_url",
    "get_console",
    "get_page_text",
    "get_screenshot",
    "fetch_urls",
    "extract_ai",
  ]) {
    expect(tools.find((tool) => tool.name === name)!.annotations.idempotentHint, name).toBe(false);
  }
});

test("the complete 49-tool annotation policy matches every declared mode", () => {
  const readOnly = new Set([
    "wait_for_human",
    "signin_status",
    "captcha_status",
    "extract",
    "get_attrs",
    "get_links",
    "list_profiles",
    "list_tabs",
    "page_state",
    "snapshot",
    "wait_for",
  ]);
  const nonDestructive = new Set([
    ...readOnly,
    "smoke_test",
    "start_browser",
    "request_signin",
    "request_human",
  ]);
  const idempotent = new Set([
    "wait_for_human",
    "cancel_signin",
    "signin_status",
    "captcha_status",
    "cookies",
    "export_har",
    "extract",
    "get_attrs",
    "get_links",
    "handle_dialog",
    "list_profiles",
    "list_tabs",
    "page_state",
    "save_profile",
    "snapshot",
    "start_browser",
    "wait_for",
  ]);
  const closedWorld = new Set([
    "request_human",
    "wait_for_human",
    "cancel_signin",
    "signin_status",
    "close_tabs",
    "cookies",
    "credentials",
    "delete_profile",
    "export_har",
    "list_profiles",
    "save_profile",
    "start_browser",
    "stop_browser",
  ]);
  const tools = specs();
  expect(tools).toHaveLength(49);
  expect(tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames);
  for (const tool of tools) {
    expect(tool.annotations.readOnlyHint, tool.name).toBe(readOnly.has(tool.name));
    expect(tool.annotations.destructiveHint, tool.name).toBe(!nonDestructive.has(tool.name));
    expect(tool.annotations.idempotentHint, tool.name).toBe(idempotent.has(tool.name));
    expect(tool.annotations.openWorldHint, tool.name).toBe(!closedWorld.has(tool.name));
  }
});

test("all JSON-producing tools publish an output schema", () => {
  const tools = specs();
  for (const name of [
    "request_human",
    "wait_for_human",
    "request_signin",
    "signin_status",
    "cancel_signin",
    "list_tabs",
    "cookies",
    "credentials",
    "get_links",
    "get_attrs",
    "extract",
    "fetch_urls",
    "list_profiles",
    "get_network",
    "captcha_status",
    "page_state",
    "get_page_text",
    "snapshot",
    "evaluate",
    "extract_ai",
    "smoke_test",
    "intercept",
    "use_credential",
  ]) {
    expect(tools.find((tool) => tool.name === name)!.outputSchema, name).toBeDefined();
  }
});

test("snapshot and text outputs match their schemas in legacy, query, continuation, and list modes", async () => {
  const page = {
    url: () => "https://fixture.test/",
    frames: () => [],
    locator: () => ({ ariaSnapshot: async () => '- button "Needle" [ref=e1]\n'.repeat(30) }),
    evaluate: async (_fn: unknown, args: { mode?: string; walkerSrc?: string }) =>
      args.walkerSrc ? [{ text: "entry", rawLinks: [] }] : { text: "needle ".repeat(100) },
  };
  const tools = specs({
    getPage: async () => page as unknown as Awaited<ReturnType<BrowserManager["getPage"]>>,
    resolveTab: () => 171,
  });
  for (const name of ["snapshot", "get_page_text"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    expect(tool.outputSchema).toBeDefined();
    const schema = z.object(tool.outputSchema!);
    for (const args of [
      {},
      { query: "needle", maxChars: 256 },
      ...(name === "get_page_text" ? [{ matchAll: true }] : [{ diff: true }]),
    ]) {
      const result = await tool.handler(args);
      expect(result.isError, `${name}: ${JSON.stringify(args)}`).toBeUndefined();
      expect(schema.safeParse(result.structuredContent).success, name).toBe(true);
      expect(result.structuredContent).toBeDefined();
    }
  }
});

test("evaluate preserves JSON values but does not duplicate unbounded values into structured output", async () => {
  let value: unknown = { answer: 42 };
  const page = { evaluate: async () => value };
  const tool = specs({
    getPage: async () => page as unknown as Awaited<ReturnType<BrowserManager["getPage"]>>,
  }).find((tool) => tool.name === "evaluate")!;
  const result = await tool.handler({ expression: "({answer:42})" });
  expect(result.structuredContent).toEqual({ result: { answer: 42 } });
  expect(z.object(tool.outputSchema!).safeParse(result.structuredContent).success).toBe(true);
  value = { text: "x".repeat(1000) };
  const limited = await tool.handler({ expression: "value", maxChars: 100 });
  expect(limited.structuredContent.truncated).toBe(true);
  expect(limited.structuredContent.result).toBeUndefined();
  expect(limited.structuredContent.text.length).toBeLessThanOrEqual(100);
});

test("AI extraction wraps array JSON and file mode returns only the file contract", async () => {
  let answer: unknown = ["one", "two"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
  });
  const output = await mkdtemp(join(tmpdir(), "steel-json-contract-"));
  const page = { evaluate: async () => ({ text: "Synthetic fixture only" }) };
  const tools = specs(
    { getPage: async () => page as unknown as Awaited<ReturnType<BrowserManager["getPage"]>> },
    {
      OUTPUT_DIR: output,
      MAX_INLINE_BYTES: "64",
      ACT_LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
      ACT_LLM_MODEL: "fixture",
    },
  );
  const tool = tools.find((tool) => tool.name === "extract_ai")!;
  const schema = z.object(tool.outputSchema!);
  try {
    const result = await tool.handler({
      instruction: "fixture",
      format: "text",
      schema: JSON.stringify({ type: "array", items: { type: "string" } }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ result: ["one", "two"] });
    expect(schema.safeParse(result.structuredContent).success).toBe(true);
    answer = { text: "x".repeat(500) };
    const file = await tool.handler({ instruction: "fixture", format: "text" });
    expect(file.isError).toBeUndefined();
    expect(file.structuredContent.result).toBeUndefined();
    expect(schema.safeParse(file.structuredContent).success).toBe(true);
    expect(JSON.parse(await readFile(file.structuredContent.filePath, "utf8"))).toEqual(answer);
  } finally {
    server.stop(true);
    await rm(output, { recursive: true, force: true });
  }
});
