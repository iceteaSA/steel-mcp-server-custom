import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "patchright";
import { chromiumPath } from "./browser-processes.js";
import { barrier } from "./helpers.js";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";
import { startRelayServer } from "../relay.js";
import { WebSocket } from "ws";
import { HandoffController, type HandoffOptions } from "../handoff.js";

async function fixture(mode: "on" | "off", topic?: string, handoff: Partial<HandoffOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "handoff-"));
  if (topic) await writeFile(join(directory, "notify.topic"), topic, { mode: 0o600 });
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const primary = await context.newPage();
  const env = EnvSchema.parse({
    BROWSER_MODE: "steel",
    STEEL_BASE_URL: "http://127.0.0.1:1",
    STEEL_LANES: mode,
    PROFILES_DIR: directory,
    LANE_DRAIN_MS: "50",
    TAB_IDLE_TIMEOUT_MS: "0",
    SETTLE_TIMEOUT_MS: "0",
  });
  const root = new BrowserManager(env);
  Object.assign(root, {
    _connectSteel: async () => {
      Object.assign(root, { browser, browserContext: context });
      const id = (root as unknown as { allocateTab(page: typeof primary): number }).allocateTab(
        primary,
      );
      Object.assign(root, { currentTabId: id, primaryTabId: id });
    },
  });
  const server = new McpServer({ name: "handoff-test", version: "1" });
  let now = 1000;
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), {
    manager: root,
    env,
    now: () => now,
    handoff: {
      drainMs: 100,
      heartbeatMs: 1000,
      now: () => now,
      automaticTimers: false,
      ...(topic ? { ntfyTopicFile: join(directory, "notify.topic") } : {}),
      ...handoff,
    },
  });
  const mgr = handle.manager ?? root;
  for (const register of Object.values(groups)) register(handle.register, mgr, env);
  const entered = barrier();
  const release = barrier();
  const lateDone = barrier();
  let lateAction = false;
  const pages = new Map<number, Page>();
  for (const name of ["probe", "bounded", "endless", "hold_input"] as const)
    handle.register({
      name,
      title: name,
      description: "Browser handoff probe",
      toolset: "core",
      inputSchema: {},
      annotations: {},
      handler: async () => {
        const page = await mgr.getPage();
        const id = mgr.activeTabId;
        pages.set(id, page);
        if (name === "hold_input") {
          await page.keyboard.down("Shift");
          await page.mouse.down({ button: "left" });
        }
        if (name === "bounded") {
          entered.release();
          await release.promise;
        }
        if (name === "endless") {
          entered.release();
          await page.evaluate(() => {
            for (;;) {}
          });
        }
        return { content: [{ type: "text", text: String(id) }], structuredContent: { id } };
      },
    });
  handle.register({
    name: "hung",
    title: "Hung",
    description: "Drain probe",
    toolset: "core",
    inputSchema: {},
    annotations: {},
    handler: async () => {
      await mgr.getPage();
      entered.release();
      await release.promise;
      try {
        await mgr.newTab();
        lateAction = true;
      } catch {
        /* A cancelled call must not start a new browser operation. */
      }
      lateDone.release();
      return { content: [{ type: "text", text: "PRIVATE_LATE_RESULT" }] };
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handoff-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const relay = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "synthetic-relay",
    profilesDir: directory,
    credentialsFile: join(directory, "credentials.json"),
    handoff: handle.handoff,
  });
  if (!relay.listening) await once(relay, "listening");
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("relay address");
  const url = `http://127.0.0.1:${address.port}`;
  const endpoint = async (
    action: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = { Authorization: "Bearer synthetic-relay" },
  ) => {
    const response = await fetch(`${url}/handoff${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...headers },
      ...(action ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const call = (name: string, args: Record<string, unknown> = {}, caller = "a") =>
    client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": caller } });
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/signin/events`);
  const events: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (data) => {
    events.push(JSON.parse(data.toString()));
    for (const listener of listeners) listener();
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ secret: "synthetic-relay" }));
  const state = (expected: string, after = 0) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const check = () => {
        const event = events
          .slice(after)
          .find((event) => event.type === "handoff" && event.state === expected);
        if (event) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`No handoff ${expected} event`));
      }, 5000);
      listeners.add(check);
      check();
    });
  await state("AGENT");
  const take = async (input: Record<string, unknown> = {}) => {
    const after = events.length;
    const result = await endpoint("take", input);
    expect(result.status).toBe(200);
    expect(result.body.state).toBe("DRAINING");
    expect(typeof result.body.token).toBe("string");
    await state("HUMAN", after);
    return result.body.token as string;
  };
  return {
    url,
    call,
    endpoint,
    take,
    state,
    events,
    pages,
    client,
    browser,
    context,
    primary,
    entered,
    release,
    lateDone,
    lateAction: () => lateAction,
    handle,
    advance: async (ms: number, token?: string) => {
      now += ms;
      if (token) handle.handoff?.beat(token);
      await handle.handoff?.tick();
    },
    close: async () => {
      release.release();
      ws.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await handle.close?.();
      await client.close();
      await server.close();
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("handoff security: 2500 rotated callers cannot exceed eight pending requests", () => {
  const controller = new HandoffController({ automaticTimers: false, resync: async () => {} });
  try {
    const first = controller.request("same-caller", { reason: "r" });
    let accepted = 0;
    const refused: string[] = [];
    for (let i = 0; i < 2500; i++) {
      try {
        controller.request(`caller-${i}`, { reason: "r" });
        accepted++;
      } catch (error) {
        refused.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(accepted).toBe(7);
    expect(refused).toHaveLength(2493);
    expect(new Set(refused)).toEqual(new Set(["handoff_busy: 8 pending requests (limit 8)"]));
    expect(controller.snapshot().requests).toHaveLength(8);
    expect(controller.snapshot().requests[0].id).toBe(first.id);
    expect(controller.request("same-caller", { reason: "r" })).toEqual(first);
    expect(JSON.stringify(controller.snapshot()).length).toBeLessThan(4000);
  } finally {
    controller.shutdown();
  }
});

test("handoff idle: HUMAN keeps lanes for twice the idle period and handback restarts the full idle clock", async () => {
  const f = await fixture("on");
  try {
    await f.call("probe");
    const page = [...f.pages.values()][0];
    const token = await f.take();
    await f.advance(1800000, token);
    expect((await f.endpoint("")).body.state).toBe("HUMAN");
    expect((await f.call("list_lanes")).structuredContent).toMatchObject({
      lanes: [{ tabCount: 1 }],
    });
    expect(page.isClosed()).toBe(false);
    expect((await f.endpoint("back", { token })).body.state).toBe("AGENT");
    await f.advance(899999);
    expect((await f.call("list_lanes")).structuredContent).toMatchObject({
      lanes: [{ tabCount: 1 }],
    });
    expect(page.isClosed()).toBe(false);
    await f.advance(1);
    expect((await f.call("list_lanes")).structuredContent).toMatchObject({ lanes: [] });
    expect(page.isClosed()).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

for (const mode of ["off", "on"] as const) {
  test(`handoff ${mode}: real relay state walk, global gate, decline and bounded wait`, async () => {
    const f = await fixture(mode);
    try {
      expect((await f.endpoint("")).body.state).toBe("AGENT");
      const inventory = await f.client.listTools();
      expect(inventory.tools.map((t) => t.name)).toContain("request_human");
      expect(inventory.tools.map((t) => t.name)).toContain("wait_for_human");
      await f.call("probe", {}, "b");
      const requested = await f.call("request_human", { reason: "Operator task" });
      expect(requested.structuredContent).toMatchObject({ state: "HUMAN_REQUESTED" });
      expect(typeof (requested.structuredContent as Record<string, unknown>).id).toBe("string");
      const token = await f.take();
      for (const name of [
        "snapshot",
        "get_screenshot",
        "get_page_text",
        "get_network",
        "cookies",
        "evaluate",
        "credentials",
        "request_signin",
        "request_human",
      ]) {
        const result = await f.call(
          name,
          name === "evaluate"
            ? { expression: "document.body.innerText" }
            : name === "request_signin"
              ? { site: "example.com", profile: "p", reason: "r" }
              : name === "request_human"
                ? { reason: "r" }
                : {},
          "b",
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("human_control: Operator task");
        if (!inventory.tools.find((t) => t.name === name)?.outputSchema)
          expect(result.structuredContent).toMatchObject({
            error: "human_control",
            reason: "Operator task",
          });
      }
      const sample = (schema: Record<string, unknown>, key = ""): unknown => {
        if (Array.isArray(schema.enum)) return schema.enum[0];
        if (schema.type === "object")
          return Object.fromEntries(
            ((schema.required ?? []) as string[]).map((key) => [
              key,
              sample((schema.properties as Record<string, Record<string, unknown>>)[key], key),
            ]),
          );
        if (schema.type === "array")
          return Array.from({ length: Math.max(1, Number(schema.minItems ?? 0)) }, () =>
            sample(schema.items as Record<string, unknown>),
          );
        if (schema.type === "number" || schema.type === "integer")
          return Math.max(1, Number(schema.minimum ?? 0));
        if (schema.type === "boolean") return false;
        return /url|site/i.test(key) ? "https://example.com" : "fixture";
      };
      for (const tool of inventory.tools) {
        if (["wait_for_human", "signin_status", "list_lanes"].includes(tool.name)) continue;
        const result = await f.call(
          tool.name,
          sample(tool.inputSchema) as Record<string, unknown>,
          "b",
        );
        expect(result.isError, tool.name).toBe(true);
        expect(JSON.stringify(result.content), tool.name).toContain("human_control:");
      }
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({
        status: "timeout",
      });
      expect((await f.call("wait_for_human", { timeout: 0.01 })).structuredContent).toMatchObject({
        status: "timeout",
      });
      const waiting = f.call("wait_for_human", { timeout: 2 });
      expect((await f.endpoint("back", { token })).body.state).toBe("AGENT");
      expect((await waiting).structuredContent).toMatchObject({ status: "human_done" });
      await f.call("request_human", { reason: "Decline me" });
      expect((await f.endpoint("decline")).status).toBe(200);
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({
        status: "human_declined",
      });
      expect((await f.endpoint("", {}, {})).status).toBe(401);
      for (const action of ["", "take", "heartbeat", "back", "decline"]) {
        expect((await f.endpoint(action, {}, {})).status).toBe(401);
        expect(
          (await f.endpoint(action, {}, { Authorization: "Bearer wrong-synthetic-secret" })).status,
        ).toBe(401);
        for (const host of [
          "attacker.invalid",
          "localhost.attacker.invalid",
          "127.0.0.1.attacker.invalid",
          "[::1].attacker.invalid",
        ])
          expect(
            (await f.endpoint(action, {}, { Authorization: "Bearer synthetic-relay", Host: host }))
              .status,
          ).toBe(403);
      }
      expect(
        (
          await f.endpoint(
            "take",
            {},
            { Authorization: "Bearer synthetic-relay", Host: "attacker.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(JSON.stringify(f.events)).not.toContain(token);
      expect(JSON.stringify(f.events)).not.toContain("synthetic-relay");
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: bounds drain and suppresses late in-flight data`, async () => {
    const f = await fixture(mode);
    try {
      const running = f.call("hung");
      await f.entered.promise;
      const token = await f.take({ reason: "Interrupt" });
      const result = await running;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: "human_control" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_LATE_RESULT");
      f.release.release();
      await f.lateDone.promise;
      expect(f.lateAction()).toBe(false);
      expect((await f.endpoint("back", { token: "other" })).status).toBe(409);
      expect((await f.endpoint("heartbeat", { token: "other" })).status).toBe(409);
      expect((await f.endpoint("take")).status).toBe(409);
      expect((await f.endpoint("heartbeat", { token })).status).toBe(200);
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: bounded operation drains without closing its page`, async () => {
    const f = await fixture(mode);
    try {
      const operation = f.call("bounded");
      await f.entered.promise;
      const [id, page] = [...f.pages][0];
      const take = await f.endpoint("take", { tabId: id });
      expect(take.body).toMatchObject({ state: "DRAINING", inFlight: 1 });
      expect((await f.endpoint("heartbeat", { token: take.body.token })).status).toBe(200);
      expect((await f.call("probe", {}, "b")).isError).toBe(true);
      f.release.release();
      expect((await operation).isError).not.toBe(true);
      await f.state("HUMAN");
      expect(page.isClosed()).toBe(false);
      expect((await f.endpoint("")).body.closedTabIds).toEqual([]);
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: never-settling evaluate closes or fences only its active page`, async () => {
    const f = await fixture(mode);
    try {
      const untouched = await f.context.newPage();
      const operation = f.call("endless");
      await f.entered.promise;
      const [id, page] = [...f.pages][0];
      const token = await f.take({ tabId: id });
      expect((await operation).isError).toBe(true);
      expect(page.isClosed()).toBe(mode === "on");
      expect(untouched.isClosed()).toBe(false);
      const details =
        mode === "off"
          ? { closedTabIds: [], fenced_not_closed: [id], requestedTabClosed: false }
          : { closedTabIds: [id], fenced_not_closed: [], requestedTabClosed: true };
      expect((await f.endpoint("")).body).toMatchObject(details);
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({
        ...details,
      });
      if (mode === "off") {
        expect((await f.endpoint("back", { token })).body.state).toBe("AGENT");
        expect((await f.call("probe")).isError).not.toBe(true);
        expect(await page.evaluate(() => 42)).toBe(42);
      }
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: heartbeat loss stays PAUSED until explicit handback`, async () => {
    const f = await fixture(mode);
    try {
      await f.call("request_human", { reason: "Human input" });
      const token = await f.take();
      const waiting = f.call("wait_for_human", { timeout: 2 });
      await f.advance(1001);
      expect((await waiting).structuredContent).toMatchObject({
        status: "paused",
        state: "PAUSED",
      });
      await f.advance(1000000);
      expect((await f.endpoint("")).body.state).toBe("PAUSED");
      expect((await f.endpoint("heartbeat", { token })).status).toBe(409);
      expect((await f.call("probe")).isError).toBe(true);
      expect((await f.endpoint("back", { token })).body.state).toBe("AGENT");
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: handback releases only agent-held keys/buttons and invalidates refs across lanes`, async () => {
    const f = await fixture(mode);
    try {
      await f.call("probe");
      if (mode === "on") await f.call("probe", {}, "b");
      for (const page of f.pages.values()) {
        await page.setContent(`<button>Button</button><p>${"Page text content ".repeat(100)}</p>`);
        await page.evaluate(() => {
          Object.assign(window, { released: [] as string[], mouseReleased: 0 });
          window.addEventListener("keyup", (event) =>
            (window as unknown as { released: string[] }).released.push(event.key),
          );
          window.addEventListener(
            "mouseup",
            () => (window as unknown as { mouseReleased: number }).mouseReleased++,
          );
        });
      }
      const before = await f.call("snapshot");
      const paginated = await f.call("get_page_text", { paginate: true, maxChars: 100 });
      const cursor = (paginated.structuredContent as Record<string, unknown>).nextCursor;
      expect(typeof cursor).toBe("string");
      const ref = JSON.stringify(before).match(/@((?:f\d+)?e\d+)/)?.[1];
      expect(ref).toBeDefined();
      await f.call("hold_input");
      if (mode === "on") await f.call("hold_input", {}, "b");
      const token = await f.take();
      expect((await f.endpoint("back", { token })).body.state).toBe("AGENT");
      const oldCursor = await f.call("get_page_text", { paginate: true, maxChars: 100, cursor });
      expect(oldCursor.isError).toBe(true);
      expect(JSON.stringify(oldCursor)).toContain("Invalid, expired, or differently scoped cursor");
      for (const page of f.pages.values()) {
        const observed = await page.evaluate(() => ({
          released: (window as unknown as { released: string[] }).released,
          mouseReleased: (window as unknown as { mouseReleased: number }).mouseReleased,
        }));
        expect(observed.released).toEqual(["Shift"]);
        expect(observed.mouseReleased).toBe(1);
      }
      for (const caller of mode === "on" ? ["a", "b"] : ["a"]) {
        const stale = await f.call("click", { ref, timeout: 100 }, caller);
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale)).toContain("stale_ref");
        expect((await f.call("snapshot", {}, caller)).isError).not.toBe(true);
      }
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: browser loss and shutdown terminate waiters`, async () => {
    const f = await fixture(mode);
    try {
      await f.call("probe");
      await f.call("request_human", { reason: "Browser loss" });
      const waiting = f.call("wait_for_human", { timeout: 120 });
      await f.browser.close();
      expect((await waiting).structuredContent).toMatchObject({ status: "paused" });
      expect((await f.call("probe")).isError).toBe(true);
    } finally {
      await f.close();
    }
    const shutdown = await fixture(mode);
    try {
      await shutdown.call("request_human", { reason: "Shutdown" });
      const waiting = shutdown.call("wait_for_human", { timeout: 120 });
      shutdown.handle.handoff?.shutdown();
      expect((await waiting).structuredContent).toMatchObject({ status: "paused" });
    } finally {
      await shutdown.close();
    }
  }, 15000);

  test(`handoff ${mode}: security bounds rotated MCP callers and all snapshot channels`, async () => {
    const f = await fixture(mode);
    try {
      const ids: unknown[] = [];
      for (let i = 0; i < 8; i++) {
        const after = f.events.length;
        const result = await f.call("request_human", { reason: `reason-${i}` }, `rotated-${i}`);
        ids.push((result.structuredContent as Record<string, unknown>)?.id);
        const event = await f.state("HUMAN_REQUESTED", after);
        expect(event.requests).toHaveLength(i + 1);
      }
      const refused = await f.call("request_human", { reason: "extra" }, "rotated-extra");
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: "handoff_busy: 8 pending requests (limit 8)",
      });
      const status = (await f.endpoint("")).body;
      expect((status.requests as Array<{ id: unknown }>).map((request) => request.id)).toEqual(ids);
      expect((await f.call("probe")).isError).not.toBe(true);
      expect(
        (
          (await f.call("wait_for_human", { timeout: 0 })).structuredContent as Record<
            string,
            unknown
          >
        )?.requests,
      ).toHaveLength(8);
      const token = await f.take();
      expect(
        ((await f.call("probe")).structuredContent as Record<string, unknown>)?.requests,
      ).toHaveLength(8);
      for (const event of f.events)
        if (Array.isArray(event.requests)) expect(event.requests.length).toBeLessThanOrEqual(8);
      await f.endpoint("back", { token });
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: security rejects foreign HTTP origins and identifies a displaced holder`, async () => {
    const f = await fixture(mode);
    try {
      const statuses: number[] = [];
      for (const action of ["", "take", "heartbeat", "back", "decline"])
        statuses.push(
          (
            await f.endpoint(
              action,
              {},
              { Authorization: "Bearer synthetic-relay", Origin: "https://evil.example" },
            )
          ).status,
        );
      expect(statuses).toEqual([403, 403, 403, 403, 403]);
      expect(
        (
          await fetch(`${f.url}/handoff/take`, {
            method: "OPTIONS",
            headers: { Origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect((await f.endpoint("")).status).toBe(200);
      const extension = {
        Authorization: "Bearer synthetic-relay",
        Origin: `chrome-extension://${"a".repeat(32)}`,
      };
      expect((await f.endpoint("", {}, extension)).status).toBe(200);
      const oldToken = await f.take();
      await f.advance(1001);
      const token = await f.take();
      for (const action of ["heartbeat", "back"]) {
        const displaced = await f.endpoint(action, { token: oldToken });
        expect(displaced.status).toBe(409);
        expect(displaced.body.error).toBe("handoff_displaced");
      }
      expect((await f.endpoint("back", { token }, extension)).body.state).toBe("AGENT");
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: security aggregates eight due notifications into one push per tick`, async () => {
    const received: Array<{ body: string; title: string | null }> = [];
    const entered = barrier();
    const release = barrier();
    const ntfy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        received.push({ body: await request.text(), title: request.headers.get("title") });
        entered.release();
        await release.promise;
        return new Response("ok");
      },
    });
    const f = await fixture(mode, `http://127.0.0.1:${ntfy.port}/synthetic-topic`);
    try {
      for (let i = 0; i < 8; i++)
        await f.call("request_human", { reason: `reason-${i}` }, `rotated-${i}`);
      const sending = f.advance(60000);
      await entered.promise;
      await f.handle.handoff?.tick();
      expect(received).toHaveLength(1);
      release.release();
      await sending;
      expect(received).toHaveLength(1);
      expect(received[0].title).toBe("8 pending human requests");
      expect(received[0].body).toContain("8 pending requests");
      await f.advance(60000);
      expect(received).toHaveLength(1);
    } finally {
      release.release();
      await f.close();
      await ntfy.stop(true);
    }
  }, 15000);

  test(`handoff ${mode}: request limits are per caller and duplicate requests merge`, async () => {
    const f = await fixture(mode);
    try {
      const first = await f.call("request_human", { reason: "one" });
      expect((await f.call("request_human", { reason: "one" })).structuredContent).toEqual(
        first.structuredContent,
      );
      await f.call("request_human", { reason: "two" });
      await f.call("request_human", { reason: "three" });
      expect((await f.call("request_human", { reason: "four" })).structuredContent).toMatchObject({
        error: "rate_limited",
      });
      expect((await f.call("request_human", { reason: "four" }, "b")).isError).not.toBe(true);
      for (let i = 0; i < 4; i++) await f.endpoint("decline");
      for (let i = 3; i < 10; i++) {
        await f.call("request_human", { reason: `request-${i}` });
        await f.endpoint("decline");
      }
      expect((await f.call("request_human", { reason: "eleven" })).structuredContent).toMatchObject(
        { error: "rate_limited" },
      );
      await f.advance(3600001);
      expect((await f.call("request_human", { reason: "new-hour" })).isError).not.toBe(true);
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: sends one ntfy push after 60 seconds with only request metadata`, async () => {
    const received: string[] = [];
    const ntfy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        received.push(await request.text());
        return new Response("ok");
      },
    });
    const f = await fixture(mode, `http://127.0.0.1:${ntfy.port}/synthetic-topic`);
    try {
      await f.call("request_human", { reason: "Please enter the code" });
      await f.advance(59999);
      expect(received).toEqual([]);
      await f.advance(1);
      expect(received).toEqual([
        "Agent asks for browser control: Please enter the code; tab current",
      ]);
      await f.advance(60000);
      expect(received).toHaveLength(1);
      expect(received[0]).not.toContain("synthetic-relay");
      expect(received[0]).not.toContain("sessionID");
    } finally {
      await f.close();
      await ntfy.stop(true);
    }
  }, 15000);

  test(`handoff ${mode}: later manual takeover does not reuse a declined wait result`, async () => {
    const f = await fixture(mode);
    try {
      await f.call("request_human", { reason: "Decline" });
      await f.endpoint("decline");
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({
        status: "human_declined",
      });
      const token = await f.take();
      expect((await f.call("wait_for_human", { timeout: 0 })).structuredContent).toMatchObject({
        status: "timeout",
      });
      const waiting = f.call("wait_for_human", { timeout: 2 });
      await f.endpoint("back", { token });
      expect((await waiting).structuredContent).toMatchObject({ status: "human_done" });
    } finally {
      await f.close();
    }
  }, 15000);

  test(`handoff ${mode}: viewer input hook must finish before agents resume and timeout stays PAUSED`, async () => {
    const entered = barrier();
    const release = barrier();
    const f = await fixture(mode, undefined, {
      releaseHumanInput: async () => {
        entered.release();
        await release.promise;
      },
      humanInputReleaseMs: 1000,
    });
    try {
      const token = await f.take();
      const back = f.endpoint("back", { token });
      await entered.promise;
      expect((await f.endpoint("")).body.state).toBe("RESYNC");
      expect((await f.call("probe")).isError).toBe(true);
      release.release();
      expect((await back).body.state).toBe("AGENT");
    } finally {
      release.release();
      await f.close();
    }
    const timeout = await fixture(mode, undefined, {
      releaseHumanInput: () => new Promise(() => {}),
      humanInputReleaseMs: 10,
    });
    try {
      const token = await timeout.take();
      expect((await timeout.endpoint("back", { token })).status).toBe(409);
      expect((await timeout.endpoint("")).body.state).toBe("PAUSED");
      expect((await timeout.call("probe")).isError).toBe(true);
    } finally {
      await timeout.close();
    }
  }, 15000);
}
