import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { LaneRuntime } from "../lanes.js";
import { SigninStore } from "../signin.js";
import { ALL_TOOLSETS, makeRegistrar } from "../tools/shared.js";
import * as groups from "../tools/index.js";
import { fenceDelimiters } from "../untrusted.js";

const message =
  'no_caller: send params._meta["ai.opencode/sessionID"] on every tools/call; no shared fallback lane exists.';

for (const boundary of ["list_tabs", "signin_status", "getter", "proxy", "signin"]) {
  test(`missing ${boundary} caller uses the common error code and text`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caller-hardening-"));
    const env = EnvSchema.parse({
      BROWSER_MODE: "local",
      STEEL_LANES: "on",
      OUTPUT_DIR: directory,
      RELAY_PORT: 0,
    });
    const root = new BrowserManager(env);
    const runtime = new LaneRuntime({ manager: root, env });
    const registrar = makeRegistrar(
      new McpServer({ name: "caller", version: "1" }),
      new Set(ALL_TOOLSETS),
      { manager: root, env },
    );
    const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
    try {
      if (boundary === "list_tabs" || boundary === "signin_status") {
        const result = await runtime.run(boundary, {}, undefined, async () => {
          throw new Error("handler must not run");
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({ error: "no_caller" });
        expect(result.content).toEqual([{ type: "text", text: message }]);
      }
      if (boundary === "getter") expect(() => registrar.getCaller()).toThrow(message);
      if (boundary === "proxy") expect(() => runtime.manager.listTabs()).toThrow(message);
      if (boundary === "signin")
        await expect(
          store.create(
            { sessionID: "" },
            { site: "https://example.test", profile: "work", reason: "fixture" },
          ),
        ).rejects.toMatchObject({ code: "no_caller", message });
      expect(await store.pending()).toEqual([]);
    } finally {
      store.close();
      await registrar.close?.();
      await runtime.close();
      await root.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test("SDK clients accept missing-caller errors without changes to tool output schemas", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caller-transport-"));
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: "on",
    OUTPUT_DIR: directory,
    RELAY_PORT: 0,
  });
  const manager = new BrowserManager(env);
  const server = new McpServer({ name: "caller-transport", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), { manager, env });
  for (const register of Object.values(groups))
    register(handle.register, handle.manager ?? manager, env);
  const client = new Client({ name: "caller-transport", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const before = (await client.listTools()).tools.map(({ name, outputSchema }) => ({
      name,
      outputSchema,
    }));
    expect(
      createHash("sha256")
        .update(JSON.stringify([...before].sort((a, b) => a.name.localeCompare(b.name))))
        .digest("hex"),
    ).toBe("1413d6629ad33a03f330c6d9cdb4fbd6446156c54ecc4f7669c93dfcfddae3b0");
    for (const [name, args, structured] of [
      ["list_tabs", {}, false],
      [
        "credentials",
        { name: "fixture", url: "https://example.test", username: "fixture", password: "fixture" },
        false,
      ],
      ["signin_status", { id: "missing" }, true],
      ["click", { selector: "button" }, true],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      const { open, close } = fenceDelimiters(name);
      expect(result.content).toEqual([{ type: "text", text: open + message + close }]);
      expect(result.structuredContent).toEqual(structured ? { error: "no_caller" } : undefined);
    }
    expect(
      (await client.listTools()).tools.map(({ name, outputSchema }) => ({ name, outputSchema })),
    ).toEqual(before);
  } finally {
    await client.close();
    await server.close();
    await handle.close?.();
    await manager.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
