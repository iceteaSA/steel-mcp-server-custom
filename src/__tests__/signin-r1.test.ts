import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { startRelayServer } from "../relay";
import { SigninStore } from "../signin";

let directory: string;
let store: SigninStore;
let server: http.Server;
let origin: string;
let wsOrigin: string;
let serial: number;
let clients: WebSocket[];
let connections: Socket[];
let node: ChildProcessWithoutNullStreams | undefined;
let nodeExit: Promise<number | null> | undefined;
let relayBundle: string | undefined;
const input = { site: "https://login.example.com", profile: "work", reason: "Read account" };
const cookie = { name: "sid", value: "CANARY_PRIVATE", domain: "login.example.com", path: "/" };

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-r1-"));
  serial = 0;
  clients = [];
  connections = [];
  node = undefined;
  nodeExit = undefined;
  store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  server = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "fake-r1-secret",
    profilesDir: directory,
    credentialsFile: path.join(directory, "fake-credentials.json"),
    signinStore: store,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  origin = `http://127.0.0.1:${address.port}`;
  wsOrigin = origin.replace("http:", "ws:");
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  for (const connection of connections) connection.destroy();
  if (node) {
    node.stdin.end();
    const deadline = setTimeout(() => node?.kill("SIGKILL"), 2000);
    const code = await nodeExit;
    clearTimeout(deadline);
    expect(code).toBe(0);
  }
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(directory, { recursive: true, force: true });
});
async function useNodeRelay() {
  if (!relayBundle) {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../relay.ts")],
      target: "node",
      format: "cjs",
    });
    if (!build.success) throw new AggregateError(build.logs, "Node relay fixture build failed");
    relayBundle = await build.outputs[0].text();
  }
  const bundle = path.join(directory, "relay-node.cjs");
  await fs.writeFile(bundle, relayBundle, { mode: 0o600 });
  const child = spawn(
    "/usr/bin/node",
    [path.resolve(import.meta.dir, "../../scripts/signin-node-fixture.cjs"), bundle, directory],
    { stdio: "pipe" },
  );
  node = child;
  nodeExit = new Promise((resolve) => child.once("close", resolve));
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data.toString();
  });
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Node relay fixture startup timed out: ${errors}`)),
      2000,
    );
    const lines = createInterface({ input: child.stdout });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Node relay fixture exited ${code}: ${errors}`));
    });
    lines.once("line", (line) => {
      clearTimeout(deadline);
      lines.close();
      resolve(JSON.parse(line).port);
    });
  });
  origin = `http://127.0.0.1:${port}`;
  wsOrigin = origin.replace("http:", "ws:");
}
async function request(site = input.site) {
  return store.create({ sessionID: `r1-${++serial}` }, { ...input, site });
}
function push(id: string, body: unknown, route = `/signin/${id}/push`) {
  return fetch(origin + route, {
    method: "POST",
    headers: { Authorization: "Bearer fake-r1-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

for (const storageOrigin of [
  "http://example.com",
  "https://example.com:8443",
  "http://example.com:8443",
]) {
  it(`rejects bare-domain storage from ${storageOrigin} without writing or consuming the request`, async () => {
    const pending = await request("example.com");
    const result = await push(pending.id, {
      profile: "work",
      localStorage: { [storageOrigin]: { token: "CANARY_PRIVATE" } },
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "signin_site_mismatch" });
    expect((await store.request(pending.id)).status).toBe("pending");
    expect(await fs.exists(path.join(directory, "work.json"))).toBe(false);
  });
}
for (const site of [
  "example.com",
  "http://example.com",
  "http://example.com:8123",
  "https://example.com:8443",
]) {
  it(`accepts storage from the requested canonical origin for ${site}`, async () => {
    const pending = await request(site);
    const storageOrigin = site.includes("://") ? site : `https://${site}`;
    expect(
      (
        await push(pending.id, {
          profile: "work",
          localStorage: { [storageOrigin]: { token: "CANARY_PRIVATE" } },
        })
      ).status,
    ).toBe(200);
  });
}

for (const invalid of [
  { ...cookie, name: "__Secure-sid", secure: false },
  { ...cookie, name: "__Secure-sid" },
  { ...cookie, name: "__Host-sid", secure: false, hostOnly: true },
  { ...cookie, name: "__Host-sid", secure: true, hostOnly: true, path: "/sub" },
  { ...cookie, name: "__Host-sid", secure: true, hostOnly: false },
  { ...cookie, name: "__Host-sid", secure: true },
  { ...cookie, name: "__Host-sid", secure: true, hostOnly: true, domain: ".login.example.com" },
  { ...cookie, name: "__Host-sid", secure: true, hostOnly: true, domain: "example.com" },
]) {
  it(`rejects invalid prefixed cookie ${JSON.stringify({ ...invalid, value: undefined })}`, async () => {
    const pending = await request();
    const result = await push(pending.id, { profile: "work", cookies: [invalid] });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "signin_cookie_prefix" });
    expect((await store.request(pending.id)).status).toBe("pending");
    expect(await fs.exists(path.join(directory, "work.json"))).toBe(false);
    const audit = await fs.readFile(path.join(directory, ".signin-audit.jsonl"), "utf8");
    expect(audit).not.toContain("CANARY_PRIVATE");
  });
}
it("accepts valid prefixes and keeps hostOnly as sign-in wire metadata only", async () => {
  const pending = await request();
  const result = await push(pending.id, {
    profile: "work",
    cookies: [
      { ...cookie, name: "__Host-sid", secure: true, hostOnly: true },
      { ...cookie, name: "__Secure-sid", secure: true },
    ],
  });
  expect(result.status).toBe(200);
  const saved = JSON.parse(await fs.readFile(path.join(directory, "work.json"), "utf8"));
  expect(saved.cookies).toHaveLength(2);
  expect(saved.cookies[0]).not.toHaveProperty("hostOnly");
});
it("keeps manual push prefix handling unchanged", async () => {
  expect(
    (
      await push(
        "unused",
        { profile: "work", cookies: [{ ...cookie, name: "__Secure-sid", secure: false }] },
        "/push",
      )
    ).status,
  ).toBe(200);
});

for (const route of ["/push", "/signin/unknown/push"]) {
  it(`answers an oversized body on ${route} with JSON 413 and a clean close`, async () => {
    await useNodeRelay();
    const result = await push(
      "unknown",
      { profile: "work", cookies: [{ ...cookie, value: "x".repeat(6 * 1024 * 1024) }] },
      route,
    );
    expect(result.status).toBe(413);
    expect(result.headers.get("connection")).toBe("close");
    expect(await result.json()).toEqual({ error: "body_too_large" });
    expect(await fs.exists(path.join(directory, "work.json"))).toBe(false);
  });
}

for (const browserOrigin of [
  "https://evil.example",
  "http://localhost:8123",
  "null",
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil",
]) {
  it(`rejects WebSocket Origin ${browserOrigin} before a handshake or authentication`, async () => {
    await useNodeRelay();
    const outcome = new Promise<number>((resolve, reject) => {
      const upgrade = http.request(origin + "/signin/events", {
        headers: {
          Origin: browserOrigin,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
        },
      });
      upgrade.once("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      upgrade.once("upgrade", (_response, socket) => {
        connections.push(socket);
        resolve(101);
      });
      upgrade.once("error", reject);
      upgrade.end();
    });
    expect(await outcome).toBe(403);
  });
}
it("accepts an extension Origin but still requires the first secret frame", async () => {
  await useNodeRelay();
  const client = new WebSocket(wsOrigin + "/signin/events", {
    origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  });
  clients.push(client);
  client.on("error", () => {});
  await once(client, "open");
  const message = once(client, "message");
  client.send(JSON.stringify({ secret: "fake-r1-secret" }));
  expect(JSON.parse((await message)[0].toString()).type).toBe("pending");
});

it("handles a socket error while rejecting an upgrade instead of crashing the relay", () => {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  server.emit(
    "upgrade",
    { headers: { host: "127.0.0.1", origin: "https://evil.example" }, url: "/signin/events" },
    socket,
    Buffer.alloc(0),
  );
  expect(() => socket.emit("error", new Error("fake peer reset"))).not.toThrow();
  expect(socket.destroyed).toBe(true);
});

it("admits only 16 WebSockets including unauthenticated sockets, closes overflow with 1013, and keeps the two-second auth deadline", async () => {
  await useNodeRelay();
  for (let index = 0; index < 16; index++) {
    const client = new WebSocket(wsOrigin + "/signin/events");
    clients.push(client);
    client.on("error", () => {});
    await once(client, "open");
  }
  const normalClosures = clients.map((client) => once(client, "close").then(([code]) => code));
  const overflow = new WebSocket(wsOrigin + "/signin/events");
  clients.push(overflow);
  overflow.on("error", () => {});
  expect((await once(overflow, "close"))[0]).toBe(1013);
  expect(await Promise.all(normalClosures)).toEqual(Array(16).fill(1008));
});

it("answers 503 beyond 64 concurrent HTTP connections, including sockets without a request", async () => {
  await useNodeRelay();
  const port = Number(new URL(origin).port);
  for (let index = 0; index < 64; index++) {
    const connection = connect({ host: "127.0.0.1", port });
    connections.push(connection);
    connection.on("error", () => {});
    await once(connection, "connect");
  }
  const result = await new Promise<{ status: number; body: string; close: string | undefined }>(
    (resolve, reject) => {
      http
        .get(origin + "/status", { agent: false }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              close: response.headers.connection,
            }),
          );
          response.once("error", reject);
        })
        .once("error", reject);
    },
  );
  expect(result.status).toBe(503);
  expect(JSON.parse(result.body)).toEqual({ error: "connection_limit" });
  expect(result.close).toBe("close");
});
