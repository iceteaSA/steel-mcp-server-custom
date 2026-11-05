import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { LaneRuntime } from "../lanes.js";
import { SigninStore } from "../signin.js";
import { ALL_TOOLSETS, makeRegistrar } from "../tools/shared.js";

const message = 'no_caller: send params._meta["ai.opencode/sessionID"] on every tools/call; no shared fallback lane exists.';

for (const boundary of ["list_tabs", "signin_status", "getter", "proxy", "signin"]) {
test(`missing ${boundary} caller uses the common error code and text`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caller-hardening-"));
  const env = EnvSchema.parse({ BROWSER_MODE: "local", STEEL_LANES: "on", OUTPUT_DIR: directory, RELAY_PORT: 0 });
  const root = new BrowserManager(env);
  const runtime = new LaneRuntime({ manager: root, env });
  const registrar = makeRegistrar(new McpServer({ name: "caller", version: "1" }), new Set(ALL_TOOLSETS), { manager: root, env });
  const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  try {
    if (boundary === "list_tabs" || boundary === "signin_status") {
      const result = await runtime.run(boundary, {}, undefined, async () => { throw new Error("handler must not run"); });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: "no_caller" });
      expect(result.content).toEqual([{ type: "text", text: message }]);
    }
    if (boundary === "getter") expect(() => registrar.getCaller()).toThrow(message);
    if (boundary === "proxy") expect(() => runtime.manager.listTabs()).toThrow(message);
    if (boundary === "signin") await expect(store.create({ sessionID: "" }, { site: "https://example.test", profile: "work", reason: "fixture" })).rejects.toMatchObject({ code: "no_caller", message });
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
