import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar } from "../tools/shared.js";

async function call(name: string, structuredContent: Record<string, unknown>) {
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: "off",
    STEEL_CODE_MODE: "on",
    RELAY_PORT: "0",
    OUTPUT_DIR: `${process.env.TMPDIR}/codemode-unit`,
  });
  const manager = new BrowserManager(env);
  const server = new McpServer({ name: "codemode-test", version: "1" });
  const handle = makeRegistrar(server, new Set(["core"]), { manager, env });
  handle.register({
    name,
    title: name,
    description: name,
    toolset: "core",
    inputSchema: {},
    outputSchema: Object.fromEntries(
      Object.keys(structuredContent).map((key) => [key, z.unknown()]),
    ),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async () => ({
      content: [{ type: "text", text: "Page data" }],
      structuredContent,
    }),
  });
  const client = new Client({ name: "codemode-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    return await client.callTool({ name, arguments: {} });
  } finally {
    await client.close();
    await server.close();
    await handle.close?.();
    await manager.stop();
  }
}

test("STEEL_CODE_MODE=on preserves page_state.url without display markup", async () => {
  const result = await call("page_state", { url: "about:blank" });
  expect(result.structuredContent).toEqual({ url: "about:blank" });
  expect(result.content).toEqual([
    { type: "text", text: expect.stringContaining("<untrusted-page-content") },
  ]);
});

test("STEEL_CODE_MODE=on preserves numeric tab IDs, URLs, and titles", async () => {
  const tabs = [{ tabId: 123, url: "https://example.com/", title: "Page" }];
  const result = await call("list_tabs", { tabs });
  expect(result.structuredContent).toEqual({ tabs });
});
