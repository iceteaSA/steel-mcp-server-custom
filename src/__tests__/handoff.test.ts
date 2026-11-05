import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";
import { chromiumPath } from "./browser-processes.js";
import { barrier } from "./helpers.js";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";
import { startRelayServer } from "../relay.js";

async function fixture(mode: "on" | "off") {
  const directory = await mkdtemp(join(tmpdir(), "handoff-"));
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const primary = await context.newPage();
  const env = EnvSchema.parse({ BROWSER_MODE: "steel", STEEL_BASE_URL: "http://127.0.0.1:1", STEEL_LANES: mode, PROFILES_DIR: directory, LANE_DRAIN_MS: "50", TAB_IDLE_TIMEOUT_MS: "0", SETTLE_TIMEOUT_MS: "0" });
  const root = new BrowserManager(env);
  Object.assign(root, { _connectSteel: async () => {
    Object.assign(root, { browser, browserContext: context });
    const id = (root as unknown as { allocateTab(page: typeof primary): number }).allocateTab(primary);
    Object.assign(root, { currentTabId: id, primaryTabId: id });
  } });
  const server = new McpServer({ name: "handoff-test", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), { manager: root, env });
  const mgr = handle.manager ?? root;
  for (const register of Object.values(groups)) register(handle.register, mgr, env);
  const entered = barrier();
  const release = barrier();
  handle.register({ name: "hung", title: "Hung", description: "Drain probe", toolset: "core", inputSchema: {}, annotations: {}, handler: async () => { await mgr.getPage(); entered.release(); await release.promise; return { content: [{ type: "text", text: "PRIVATE_LATE_RESULT" }] }; } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handoff-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const relay = startRelayServer({ port: 0, bindAddr: "127.0.0.1", secret: "synthetic-relay", profilesDir: directory, credentialsFile: join(directory, "credentials.json"), ...("handoff" in handle ? { handoff: handle.handoff } : {}) });
  if (!relay.listening) await once(relay, "listening");
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("relay address");
  const url = `http://127.0.0.1:${address.port}`;
  const endpoint = async (action: string, body: Record<string, unknown> = {}, headers = { Authorization: "Bearer synthetic-relay" }) => {
    const response = await fetch(`${url}/handoff${action ? `/${action}` : ""}`, { method: action ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, ...(action ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const call = (name: string, args: Record<string, unknown> = {}, caller = "a") => client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": caller } });
  return { call, endpoint, client, browser, context, primary, entered, release, handle, close: async () => {
    release.release();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await handle.close?.();
    await client.close();
    await server.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["off", "on"] as const) {
  test(`handoff ${mode}: real relay state walk, global gate, decline and bounded wait`, async () => {
    const f = await fixture(mode);
    try {
      expect((await f.endpoint("")).body.state).toBe("AGENT");
      const inventory = await f.client.listTools();
      expect(inventory.tools.map((t) => t.name)).toContain("request_human");
      expect(inventory.tools.map((t) => t.name)).toContain("wait_for_human");
      const requested = await f.call("request_human", { reason: "Operator task" });
      expect(requested.structuredContent).toMatchObject({ state: "HUMAN_REQUESTED" });
      expect(typeof (requested.structuredContent as Record<string, unknown>).id).toBe("string");
      expect((await f.endpoint("take", { viewer: "viewer-a" })).body.state).toBe("HUMAN");
      for (const name of ["snapshot", "get_screenshot", "get_page_text", "get_network", "cookies", "evaluate", "credentials", "request_signin", "request_human"]) {
        const result = await f.call(name, name === "evaluate" ? { expression: "document.body.innerText" } : name === "request_signin" ? { site: "example.com", profile: "p", reason: "r" } : name === "request_human" ? { reason: "r" } : {}, "b");
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: "human_control", reason: "Operator task" });
      }
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({ status: "timeout" });
      const waiting = f.call("wait_for_human", { timeout: 2 });
      expect((await f.endpoint("back", { viewer: "viewer-a" })).body.state).toBe("AGENT");
      expect((await waiting).structuredContent).toMatchObject({ status: "human_done" });
      await f.call("request_human", { reason: "Decline me" });
      expect((await f.endpoint("decline")).status).toBe(200);
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({ status: "human_declined" });
      expect((await f.endpoint("", {}, {})).status).toBe(401);
      expect((await f.endpoint("take", { viewer: "x" }, { Authorization: "Bearer synthetic-relay", Host: "attacker.invalid" } as Record<string, string>)).status).toBe(403);
    } finally { await f.close(); }
  }, 15000);

  test(`handoff ${mode}: bounds drain and suppresses late in-flight data`, async () => {
    const f = await fixture(mode);
    try {
      const running = f.call("hung");
      await f.entered.promise;
      expect((await f.endpoint("take", { viewer: "viewer-a", reason: "Interrupt" })).body.state).toBe("HUMAN");
      const result = await running;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: "human_control" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_LATE_RESULT");
      f.release.release();
      expect((await f.endpoint("back", { viewer: "other" })).status).toBe(409);
      expect((await f.endpoint("heartbeat", { viewer: "viewer-a" })).status).toBe(200);
    } finally { await f.close(); }
  }, 15000);
}
