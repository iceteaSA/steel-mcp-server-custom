import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "patchright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { chromiumPath, retainedBrowserCount } from "./browser-processes.js";
import { BrowserManager } from "../manager.js";
import { EnvSchema } from "../env.js";
import { SigninStore } from "../signin.js";
import { startRelayServer } from "../relay.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";

function data(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as Record<string, unknown> | undefined;
}
function call(
  client: Client,
  caller: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
) {
  return client.callTool({
    name,
    arguments: args,
    ...(caller ? { _meta: { "ai.opencode/sessionID": caller } } : {}),
  });
}
async function port() {
  const socket = http.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
async function processFixture(mode: "on" | "off") {
  const directory = await mkdtemp(path.join(tmpdir(), "signin-index-"));
  const relayPort = await port();
  const transport = new StdioClientTransport({
    command: "/usr/bin/node",
    args: [path.resolve(import.meta.dir, "../../dist/index.cjs")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      BROWSER_MODE: "steel",
      STEEL_BASE_URL: "http://127.0.0.1:1",
      STEEL_LANES: mode,
      LANE_DRAIN_MS: "20",
      RELAY_PORT: String(relayPort),
      RELAY_SECRET: "fake-int-secret",
      OUTPUT_DIR: directory,
      PROFILES_DIR: directory,
      CREDENTIALS_FILE: path.join(directory, "fake-credentials.json"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "signin-int", version: "1" });
  await client.connect(transport);
  const origin = `http://127.0.0.1:${relayPort}`;
  const headers = { Authorization: "Bearer fake-int-secret", "Content-Type": "application/json" };
  return {
    client,
    origin,
    headers,
    directory,
    transport,
    close: async () => {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const mode of ["on", "off"] as const) {
  test(`INT actual index shares one sign-in store with relay and uses ${mode} caller mode without opening a browser`, async () => {
    const f = await processFixture(mode);
    try {
      const listed = (await f.client.listTools()).tools;
      for (const name of ["request_signin", "signin_status", "cancel_signin"]) {
        const tool = listed.find((tool) => tool.name === name);
        expect(tool).toBeDefined();
        for (const hint of [
          "readOnlyHint",
          "destructiveHint",
          "idempotentHint",
          "openWorldHint",
        ] as const)
          expect(typeof tool?.annotations?.[hint]).toBe("boolean");
      }
      if (mode === "on")
        expect(
          JSON.stringify(
            await call(f.client, undefined, "request_signin", {
              site: "example.com",
              profile: "work",
              reason: "test",
            }),
          ),
        ).toContain("no_caller");
      if (mode === "on") {
        for (const name of ["request_signin", "signin_status", "cancel_signin"]) {
          const missing = await call(
            f.client,
            undefined,
            name,
            name === "request_signin"
              ? { site: "example.com", profile: "work", reason: "test" }
              : { id: "missing" },
          );
          expect(missing.isError).toBe(true);
          expect(data(missing)).toEqual({ error: "no_caller" });
        }
      }
      const created = data(
        await call(f.client, "a", "request_signin", {
          site: "example.com",
          profile: "work",
          reason: "test",
        }),
      );
      expect(created?.status).toBe("pending");
      const id = String(created?.id);
      const pending = await fetch(f.origin + "/signin", { headers: f.headers }).then((response) =>
        response.json(),
      );
      expect(pending.requests).toHaveLength(1);
      expect(pending.requests[0].caller.sessionID).toBe(mode === "on" ? "a" : "single-process");
      if (mode === "on") {
        expect(data(await call(f.client, "b", "signin_status", { id }))).toEqual({
          error: "signin_unknown",
        });
        expect(data(await call(f.client, "b", "cancel_signin", { id }))).toEqual({
          error: "signin_unknown",
        });
        expect(data(await call(f.client, "b", "signin_status", { id: "absent" }))).toEqual({
          error: "signin_unknown",
        });
        expect(data(await call(f.client, "a", "list_lanes"))).toEqual({ lanes: [] });
        const parallel = await Promise.all([
          call(f.client, "a", "request_signin", {
            site: "example.org",
            profile: "left",
            reason: "parallel",
          }),
          call(f.client, "b", "request_signin", {
            site: "example.net",
            profile: "right",
            reason: "parallel",
          }),
        ]);
        const parallelPending = await fetch(f.origin + "/signin", { headers: f.headers }).then(
          (response) => response.json(),
        );
        expect(
          parallelPending.requests.find(
            (request: { id: string }) => request.id === data(parallel[0])?.id,
          )?.caller.sessionID,
        ).toBe("a");
        expect(
          parallelPending.requests.find(
            (request: { id: string }) => request.id === data(parallel[1])?.id,
          )?.caller.sessionID,
        ).toBe("b");
      } else
        expect(data(await call(f.client, "b", "signin_status", { id }))?.status).toBe("pending");
      const waiting = call(f.client, "a", "request_signin", {
        site: "example.com",
        profile: "work",
        reason: "test",
        wait: 5,
      });
      expect(data(await call(f.client, "a", "signin_status", { id }))?.status).toBe("pending");
      const pushed = await fetch(f.origin + `/signin/${id}/push`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({
          profile: "work",
          cookies: [{ name: "sid", value: "CANARY_INT", domain: "example.com", path: "/" }],
        }),
      });
      expect(pushed.status).toBe(200);
      expect(await pushed.json()).toMatchObject({
        status: "approved",
        cookieCount: 1,
        liveApplied: false,
      });
      expect(data(await waiting)).toMatchObject({ id, status: "approved", cookieCount: 1 });
      expect(data(await call(f.client, "a", "signin_status", { id }))?.status).toBe("approved");
      const next = data(
        await call(f.client, "a", "request_signin", {
          site: "example.org",
          profile: "other",
          reason: "cancel",
        }),
      );
      expect(data(await call(f.client, "a", "cancel_signin", { id: next?.id }))?.status).toBe(
        "cancelled",
      );
      const repeated = await call(f.client, "a", "cancel_signin", { id: next?.id });
      expect(repeated.isError).not.toBe(true);
      expect(data(repeated)?.status).toBe("cancelled");
      const alreadyApproved = await call(f.client, "a", "cancel_signin", { id });
      expect(alreadyApproved.isError).not.toBe(true);
      expect(data(alreadyApproved)?.status).toBe("approved");
      expect((await call(f.client, undefined, "list_profiles")).isError).not.toBe(true);
      expect(JSON.stringify(await call(f.client, undefined, "list_profiles"))).not.toContain(
        ".signin-state",
      );
      expect((await call(f.client, undefined, "credentials")).isError).not.toBe(true);
      if (mode === "on")
        expect(
          JSON.stringify(
            await call(f.client, undefined, "credentials", {
              name: "fake",
              url: "https://example.com",
              username: "fake",
              password: "fake",
            }),
          ),
        ).toContain("no_caller");
    } finally {
      await f.close();
    }
  }, 20000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`INT actual process ${signal} returns a cancelled waiter and flushes state inside 2020 ms`, async () => {
    const f = await processFixture("on");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const created = data(
        await call(f.client, "a", "request_signin", {
          site: "example.com",
          profile: "work",
          reason: "signal",
        }),
      );
      expect(created?.status).toBe("pending");
      const waiting = call(f.client, "a", "request_signin", {
        site: "example.com",
        profile: "work",
        reason: "signal",
        wait: 120,
      });
      expect(data(await call(f.client, "a", "signin_status", { id: created?.id }))?.status).toBe(
        "pending",
      );
      const closed = new Promise<void>((resolve) => {
        const original = f.transport.onclose;
        f.transport.onclose = () => {
          original?.();
          resolve();
        };
      });
      const at = performance.now();
      const pid = f.transport.pid;
      if (!pid) throw new Error("Missing child PID");
      process.kill(pid, signal);
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("signal exceeded 2020 ms")), 2020);
        }),
      ]);
      expect(performance.now() - at).toBeLessThan(2020);
      expect(data(await waiting)?.status).toBe("cancelled");
      const saved = JSON.parse(
        await readFile(path.join(f.directory, ".signin-state.json"), "utf8"),
      );
      expect(saved.requests[0].status).toBe("cancelled");
    } finally {
      clearTimeout(deadline);
      await f.close();
    }
  }, 10000);
}

test("INT live profile pushes update only holding lane contexts; absent membership defers state until next profile use", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "signin-live-"));
  const retained = retainedBrowserCount();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  });
  if (Bun.version.startsWith("1.3.")) expect(retainedBrowserCount()).toBe(retained + 1);
  const operator = await browser.newContext();
  await operator.newPage();
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<title>INT</title>"),
  });
  const origin = `http://127.0.0.1:${site.port}`;
  const env = EnvSchema.parse({
    BROWSER_MODE: "steel",
    STEEL_BASE_URL: "http://127.0.0.1:1",
    STEEL_LANES: "on",
    RELAY_PORT: "0",
    PROFILES_DIR: directory,
    CREDENTIALS_FILE: path.join(directory, "fake-credentials.json"),
    TAB_IDLE_TIMEOUT_MS: "0",
    SETTLE_TIMEOUT_MS: "0",
  });
  const root = new BrowserManager(env);
  const laneManagers: BrowserManager[] = [];
  const selected: BrowserManager[] = [];
  const createLane = root.createLane.bind(root);
  root.createLane = async (...args: Parameters<BrowserManager["createLane"]>) => {
    const lane = await createLane(...args);
    laneManagers.push(lane);
    const apply = lane.applyProfileUpdated.bind(lane);
    lane.applyProfileUpdated = async (profile) => {
      selected.push(lane);
      return apply(profile);
    };
    return lane;
  };
  Object.assign(root, {
    _connectSteel: async () => {
      Object.assign(root, { browser, browserContext: operator });
    },
  });
  const server = new McpServer({ name: "signin-live", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), { manager: root, env });
  for (const register of Object.values(groups))
    register(handle.register, handle.manager ?? root, env);
  const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  handle.register.signin = { store: Promise.resolve(store), getCaller: () => handle.getCaller() };
  const relay = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "fake-live-secret",
    profilesDir: directory,
    credentialsFile: env.CREDENTIALS_FILE,
    signinStore: store,
    onProfileUpdated: (profile) => handle.applyProfileUpdated(profile),
  });
  await once(relay, "listening");
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("Missing live relay address");
  const client = new Client({ name: "signin-live", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const push = async (profile: string, value: string, siteOrigin = origin) => {
    const pending = await store.create(
      { sessionID: "a" },
      { site: siteOrigin, profile, reason: "test" },
    );
    return fetch(`http://127.0.0.1:${address.port}/signin/${pending.id}/push`, {
      method: "POST",
      headers: { Authorization: "Bearer fake-live-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        profile,
        cookies: [{ name: "sid", value, domain: new URL(siteOrigin).hostname, path: "/" }],
        localStorage: { [siteOrigin]: { token: value } },
      }),
    }).then((response) => response.json());
  };
  try {
    expect(
      (await call(client, "a", "new_tab", { profile: "work", url: origin + "/a" })).isError,
    ).not.toBe(true);
    expect(
      (await call(client, "b", "new_tab", { profile: "other", url: origin + "/b" })).isError,
    ).not.toBe(true);
    const a = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === origin + "/a")!;
    const b = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === origin + "/b")!;
    expect((await push("work", "CANARY_LIVE")).liveApplied).toBe(true);
    expect(selected.map((lane) => laneManagers.indexOf(lane))).toEqual([0]);
    expect(selected.map((lane) => laneManagers.indexOf(lane))).not.toContain(1);
    expect(await a.context().cookies()).toContainEqual(
      expect.objectContaining({ name: "sid", value: "CANARY_LIVE" }),
    );
    expect(await a.evaluate(() => localStorage.getItem("token"))).toBe("CANARY_LIVE");
    expect(await b.context().cookies()).toEqual([]);
    expect(await b.evaluate(() => localStorage.getItem("token"))).toBeNull();
    expect(await operator.cookies()).toEqual([]);
    const unvisited = `http://localhost:${site.port}`;
    expect((await push("work", "CANARY_UNVISITED", unvisited)).liveApplied).toBe(true);
    expect(
      (await a.context().storageState()).origins.find((entry) => entry.origin === unvisited)
        ?.localStorage,
    ).toContainEqual({ name: "token", value: "CANARY_UNVISITED" });
    expect(await b.context().cookies()).toEqual([]);
    const originalNewPage = a.context().newPage.bind(a.context());
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    a.context().newPage = async () => {
      const page = await originalNewPage();
      enter();
      await gate;
      return page;
    };
    try {
      const pushing = push("work", "CANARY_RACE", unvisited);
      await entered;
      const saving = call(client, "a", "save_profile", { name: "work" });
      await Bun.sleep(50);
      release();
      expect((await saving).isError).not.toBe(true);
      expect((await pushing).liveApplied).toBe(true);
      const saved = JSON.parse(await readFile(path.join(directory, "work.json"), "utf8"));
      expect(saved.localStorage[unvisited]?.token).toBe("CANARY_RACE");
      expect(
        (await a.context().storageState()).origins.find((entry) => entry.origin === unvisited)
          ?.localStorage,
      ).toContainEqual({ name: "token", value: "CANARY_RACE" });
    } finally {
      release();
      a.context().newPage = originalNewPage;
    }
    await a.evaluate(() => localStorage.setItem("token", "CANARY_STALE"));
    expect(
      (
        await fetch(`http://127.0.0.1:${address.port}/push`, {
          method: "POST",
          headers: { Authorization: "Bearer fake-live-secret", "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: "work",
            localStorage: { [origin]: { token: "CANARY_MANUAL" } },
          }),
        })
      ).status,
    ).toBe(200);
    expect((await call(client, "a", "save_profile", { name: "work" })).isError).not.toBe(true);
    expect(
      JSON.parse(await readFile(path.join(directory, "work.json"), "utf8")).localStorage[origin]
        .token,
    ).toBe("CANARY_MANUAL");
    const own = data(await call(client, "a", "list_profiles"))?.profiles as Array<{
      name: string;
      active: boolean;
    }>;
    const foreign = data(await call(client, "b", "list_profiles"))?.profiles as Array<{
      name: string;
      active: boolean;
    }>;
    expect(own.find((p) => p.name === "work")?.active).toBe(true);
    expect(foreign.find((p) => p.name === "work")?.active).toBe(false);
    expect((await push("late", "CANARY_LATE")).liveApplied).toBe(false);
    expect(
      (await call(client, "c", "new_tab", { profile: "late", url: origin + "/late" })).isError,
    ).not.toBe(true);
    const late = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === origin + "/late")!;
    expect(await late.context().cookies()).toContainEqual(
      expect.objectContaining({ name: "sid", value: "CANARY_LATE" }),
    );
    expect(await late.evaluate(() => localStorage.getItem("token"))).toBe("CANARY_LATE");
    await call(client, "a", "delete_profile", { name: "work" });
    expect((await push("work", "CANARY_DEFERRED")).liveApplied).toBe(false);
    expect(await b.context().cookies()).toEqual([]);
  } finally {
    await handle.close?.();
    await client.close();
    await server.close();
    store.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await root.stop();
    await browser.close();
    site.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("INT store shutdown cancels waiters, flushes terminal state, and rejects new requests", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "signin-shutdown-"));
  const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  let id: string | undefined;
  let waiting: ReturnType<SigninStore["wait"]> | undefined;
  try {
    const pending = await store.create(
      { sessionID: "a" },
      { site: "example.com", profile: "work", reason: "test" },
    );
    id = pending.id;
    waiting = store.wait({ sessionID: "a" }, pending.id, 120);
    const shutdown = store.shutdown;
    expect(typeof shutdown).toBe("function");
    await shutdown.call(store);
    expect((await waiting).status).toBe("cancelled");
    expect(
      JSON.parse(await readFile(path.join(directory, ".signin-state.json"), "utf8")).requests[0]
        .status,
    ).toBe("cancelled");
    await expect(
      store.create({ sessionID: "a" }, { site: "example.org", profile: "next", reason: "test" }),
    ).rejects.toThrow("signin_cancelled");
  } finally {
    if (id) await store.cancel({ sessionID: "a" }, id).catch(() => {});
    await waiting;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
