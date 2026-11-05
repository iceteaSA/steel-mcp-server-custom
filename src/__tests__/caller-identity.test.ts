import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager } from "../manager.js";
import { EnvSchema } from "../env.js";
import { SigninStore } from "../signin.js";
import { ALL_TOOLSETS, makeRegistrar } from "../tools/shared.js";
import { register as handoffTools } from "../tools/handoff.js";
import { register as signinTools } from "../tools/signin.js";

async function fixture(mode: "on" | "off") {
  const directory = await mkdtemp(join(tmpdir(), "caller-identity-"));
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: mode,
    OUTPUT_DIR: directory,
    RELAY_PORT: "0",
  });
  const manager = new BrowserManager(env);
  const server = new McpServer({ name: "caller-identity", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), {
    manager,
    env,
    handoff: { automaticTimers: false },
  });
  const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  handoffTools(handle.register, handle.manager ?? manager, env);
  signinTools(handle.register, handle.manager ?? manager, env, {
    signin: { store: Promise.resolve(store), getCaller: handle.getCaller },
  });
  handle.register({
    name: "list_profiles",
    title: "Caller probe",
    description: "Caller identity probe",
    toolset: "auth",
    inputSchema: {},
    annotations: {},
    handler: async () => ({
      content: [{ type: "text", text: "caller" }],
      structuredContent: { caller: handle.getCaller() },
    }),
  });
  const client = new Client({ name: "caller-identity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    handle,
    store,
    call: async (caller: string, name: string, args: Record<string, unknown> = {}) =>
      CallToolResultSchema.parse(
        await client.callTool({
          name,
          arguments: args,
          _meta: { "ai.opencode/sessionID": caller },
        }),
      ),
    async close() {
      store.close();
      await handle.close?.();
      await manager.stop();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("caller keys use the UTF-8 byte boundary and cannot collide with literal namespaces", async () => {
  const f = await fixture("on");
  try {
    for (const id of [
      "x",
      "x".repeat(128),
      "é".repeat(64),
      "é".repeat(65),
      "🙂".repeat(32),
      "🙂".repeat(33),
      "x".repeat(8 * 1024 * 1024),
    ]) {
      const digest = createHash("sha256").update(id).digest("hex");
      const expected = Buffer.byteLength(id) <= 128 ? `short:${id}` : `long:${digest}`;
      const result = await f.call(id, "list_profiles");
      const actual = String(result.structuredContent?.caller);
      expect(actual.length).toBeLessThanOrEqual(134);
      expect(actual === expected).toBe(true);
      const imitation = await f.call(expected, "list_profiles");
      expect(imitation.structuredContent?.caller === actual).toBe(false);
    }
  } finally {
    await f.close();
  }
});

for (const mode of ["on", "off"] as const)
  test(`handoff retains bounded caller keys and separates a long ID from its literal hash label: ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      const id = "long-caller-" + "x".repeat(8 * 1024 * 1024);
      const digest = createHash("sha256").update(id).digest("hex");
      const label = `sha256:${digest.slice(0, 16)}`;
      const own = await f.call(id, "request_human", { reason: "same reason" });
      const same = await f.call(id, "request_human", { reason: "same reason" });
      expect(same.structuredContent?.id).toBe(own.structuredContent?.id);
      const foreign = await f.call(label, "request_human", { reason: "same reason" });
      expect(foreign.structuredContent?.id).not.toBe(own.structuredContent?.id);
      const keys = (Reflect.get(f.handle.handoff!, "requests") as { caller: string }[]).map(
        (request) => request.caller,
      );
      expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(134);
      expect(keys).toEqual([`long:${digest}`, `short:${label}`]);
      f.handle.handoff!.decline(String(own.structuredContent?.id));
      expect((await f.call(id, "wait_for_human", { timeout: 0 })).structuredContent?.status).toBe(
        "human_declined",
      );
      expect(
        (await f.call(label, "wait_for_human", { timeout: 0 })).structuredContent?.status,
      ).toBe("timeout");
    } finally {
      await f.close();
    }
  });

for (const mode of ["on", "off"] as const)
  test(`ill-formed short and long caller IDs receive unified no_caller errors: ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      for (const id of ["\ud800", "x".repeat(129) + "\udfff"])
        for (const name of ["request_human", "request_signin"]) {
          const result = await f.call(
            id,
            name,
            name === "request_human"
              ? { reason: "fixture" }
              : { site: "example.com", profile: "work", reason: "fixture" },
          );
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({ error: "no_caller" });
          expect(
            result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          ).toContain('no_caller: send params._meta["ai.opencode/sessionID"]');
        }
      expect(await f.store.pending()).toEqual([]);
      expect(f.handle.handoff!.snapshot().requests).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("sign-in accepts the longest namespaced keys and keeps hash-label callers separate", async () => {
  const f = await fixture("on");
  try {
    const long = "x".repeat(129);
    const digest = createHash("sha256").update(long).digest("hex");
    for (const [index, id] of ["x".repeat(128), long].entries()) {
      const result = await f.call(id, "request_signin", {
        site: "example.com",
        profile: `work${index}`,
        reason: "fixture",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.status).toBe("pending");
      if (index === 1) {
        const foreign = await f.call(`sha256:${digest.slice(0, 16)}`, "signin_status", {
          id: result.structuredContent?.id,
        });
        expect(foreign.structuredContent).toEqual({ error: "signin_unknown" });
      }
    }
    const keys = (await f.store.pending()).map((request) => request.caller.sessionID);
    expect(keys).toEqual([`short:${"x".repeat(128)}`, `long:${digest}`]);
    expect(keys.map((key) => key.length)).toEqual([134, 69]);
  } finally {
    await f.close();
  }
});
