import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startRelayServer, type PushPayload } from "../relay";
import { SigninStore } from "../signin";
import { WebSocket } from "ws";
import { readProfileData } from "../profile-store";

let server: http.Server;
let directory: string;
let origin: string;
let store: SigninStore;
let now: number;
let updates: string[];
const caller = { sessionID: "session-test", agent: "tester" };
const input = { site: "https://login.example.com", profile: "work", reason: "Read account" };
const state = {
  profile: "work",
  cookies: [{ name: "sid", value: "CANARY_PRIVATE", domain: ".example.com", path: "/" }],
  localStorage: { "https://login.example.com": { token: "CANARY_PRIVATE" } },
};

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-relay-"));
  now = 1_000_000;
  updates = [];
  store = await SigninStore.open({
    profilesDir: path.join(directory, "profiles"),
    now: () => now,
    automaticTimers: false,
  });
  server = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "fake-signin-secret",
    profilesDir: path.join(directory, "profiles"),
    credentialsFile: path.join(directory, "credentials.json"),
    signinStore: store,
    onProfileUpdated: (profile) => {
      updates.push(profile);
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  store.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.rm(directory, { recursive: true, force: true });
});

function post(id: string, body: PushPayload = state) {
  return fetch(origin + `/signin/${id}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

for (const mode of ["manual", "signin"] as const) {
  async function pushMode() {
    if (mode === "signin") return post((await store.create(caller, input)).id);
    return fetch(origin + "/push", {
      method: "POST",
      headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
  }
  it(`${mode} push creates a missing profile without weakening strict reads`, async () => {
    const file = path.join(directory, "profiles/work.json");
    await expect(readProfileData(file)).rejects.toThrow();
    expect((await pushMode()).status).toBe(200);
    expect((await readProfileData(file)).cookies?.[0].value).toBe("CANARY_PRIVATE");
  });
  it(`${mode} push rejects schema-invalid saved state without replacing it`, async () => {
    const file = path.join(directory, "profiles/work.json");
    const invalid = JSON.stringify({ cookies: [{ name: "invalid", value: 12 }] });
    await fs.writeFile(file, invalid);
    await expect(readProfileData(file)).rejects.toThrow();
    expect((await pushMode()).status).toBe(400);
    expect(await fs.readFile(file, "utf8")).toBe(invalid);
  });
}

it("requires Bearer authentication before listing pending sign-in requests", async () => {
  const response = await fetch(origin + "/signin");
  expect(response.status).toBe(401);
});

it("audits a request push without HTTP authorization without recording supplied values", async () => {
  const response = await fetch(origin + "/signin/unknown/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  expect(response.status).toBe(401);
  const auditFile = path.join(directory, "profiles", ".signin-audit.jsonl");
  expect(await fs.exists(auditFile)).toBe(true);
  const audit = await fs.readFile(auditFile, "utf8");
  expect(audit).toContain("rejected:unauthorized");
  expect(audit).not.toContain("CANARY_PRIVATE");
});

it("lists pending sign-in requests without exposing saved state", async () => {
  const response = await fetch(origin + "/signin", {
    headers: { Authorization: "Bearer fake-signin-secret" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ requests: [] });
});

it("accepts explicit IP-origin state but rejects an address suffix as a parent domain", async () => {
  const site = "http://127.0.0.1:8123";
  const request = await store.create(caller, { ...input, site });
  const payload = {
    profile: "work",
    cookies: [{ ...state.cookies[0], domain: "0.0.1" }],
    localStorage: { [site]: { token: "CANARY_PRIVATE" } },
  };
  const rejected = await post(request.id, payload);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: "signin_site_mismatch" });
  const accepted = await post(request.id, {
    ...payload,
    cookies: [{ ...state.cookies[0], domain: "127.0.0.1" }],
  });
  expect(accepted.status).toBe(200);
  expect(await store.status(caller, request.id)).toMatchObject({
    status: "approved",
    counts: { cookieCount: 1, storageKeyCount: 1 },
  });
});

it("rejects an unknown request id instead of writing a profile", async () => {
  const response = await fetch(origin + "/signin/unknown/push", {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: "work",
      cookies: [{ name: "sid", value: "CANARY_PRIVATE", domain: "example.com", path: "/" }],
    }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "signin_unknown" });
  expect(await fs.exists(path.join(directory, "profiles", "work.json"))).toBe(false);
});

it("accepts only a pending request, writes counts, applies live once, and audits no values", async () => {
  const request = await store.create(caller, input);
  const responses = await Promise.all([post(request.id), post(request.id)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await store.status(caller, request.id)).toMatchObject({
    status: "approved",
    counts: { cookieCount: 1, storageKeyCount: 1 },
  });
  expect(updates).toEqual(["work"]);
  const saved = JSON.parse(
    await fs.readFile(path.join(directory, "profiles", "work.json"), "utf8"),
  );
  expect(saved.cookies[0].value).toBe("CANARY_PRIVATE");
  expect(saved.localStorage["https://login.example.com"].token).toBe("CANARY_PRIVATE");
  const audit = await fs.readFile(path.join(directory, "profiles", ".signin-audit.jsonl"), "utf8");
  expect(audit).not.toContain("CANARY_PRIVATE");
  const rows = audit
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    rows.some(
      (row) => row.decision === "approved" && row.cookieCount === 1 && row.storageKeyCount === 1,
    ),
  ).toBe(true);
  expect(rows.some((row) => row.decision === "rejected:signin_used")).toBe(true);
});

for (const status of ["expired", "cancelled", "denied"] as const) {
  it(`rejects a ${status} request with an audit row and no profile write`, async () => {
    const request = await store.create(caller, input);
    if (status === "expired") now += 300_000;
    if (status === "cancelled") await store.cancel(caller, request.id);
    if (status === "denied") await store.deny(request.id, "No");
    const response = await post(request.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `signin_${status}` });
    expect(await fs.exists(path.join(directory, "profiles", "work.json"))).toBe(false);
    expect(
      await fs.readFile(path.join(directory, "profiles", ".signin-audit.jsonl"), "utf8"),
    ).toContain(`rejected:signin_${status}`);
  });
}

for (const domain of ["other.test", "sibling.example.com", "com", "example.com.evil.test"]) {
  it(`rejects out-of-scope cookie domain ${domain}`, async () => {
    const request = await store.create(caller, input);
    const response = await post(request.id, {
      ...state,
      cookies: [{ ...state.cookies[0], domain }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "signin_site_mismatch" });
    expect(await fs.exists(path.join(directory, "profiles", "work.json"))).toBe(false);
  });
}

it("rejects another profile and another storage origin", async () => {
  const request = await store.create(caller, input);
  const mismatch = await post(request.id, { ...state, profile: "other" });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toEqual({ error: "signin_profile_mismatch" });
  const second = await store.create(caller, input);
  const storage = await post(second.id, {
    ...state,
    localStorage: { "https://sibling.example.com": { token: "CANARY_PRIVATE" } },
  });
  expect(storage.status).toBe(400);
  expect(await storage.json()).toEqual({ error: "signin_site_mismatch" });
  expect(updates).toEqual([]);
});

it("keeps a request pending after a rejected scope check so the operator can retry correctly", async () => {
  const request = await store.create(caller, input);
  expect((await post(request.id, { ...state, profile: "other" })).status).toBe(400);
  expect((await store.status(caller, request.id)).status).toBe("pending");
  expect((await post(request.id)).status).toBe(200);
});

it("requires explicit remember opt-in and supports listing and revocation", async () => {
  const request = await store.create(caller, input);
  expect((await post(request.id)).status).toBe(200);
  expect(await store.grants()).toEqual([]);
  const remembered = await store.create(caller, input);
  const response = await fetch(origin + `/signin/${remembered.id}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, remember: true }),
  });
  expect(response.status).toBe(200);
  const grants = await fetch(origin + "/signin/grants", {
    headers: { Authorization: "Bearer fake-signin-secret" },
  });
  const body = await grants.json();
  expect(body.grants).toHaveLength(1);
  expect(
    (
      await fetch(origin + `/signin/grants/${body.grants[0].id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer fake-signin-secret" },
      })
    ).status,
  ).toBe(200);
  expect(await store.grants()).toEqual([]);
});

async function rememberGrant() {
  const request = await store.create(caller, input);
  await store.consume(request.id, {
    validate: () => {},
    write: async () => ({ cookieCount: 0, storageKeyCount: 0 }),
    remember: true,
  });
}

it("rejects automatic approval after its remembered grant is revoked", async () => {
  await rememberGrant();
  const request = await store.create(caller, input);
  await store.revoke((await store.grants())[0].id);
  const response = await fetch(origin + `/signin/${request.id}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, useGrant: true }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "signin_grant_required" });
  expect(await fs.exists(path.join(directory, "profiles", "work.json"))).toBe(false);
});

it("accepts automatic approval only while its exact site/profile grant is active", async () => {
  await rememberGrant();
  const request = await store.create(caller, input);
  const response = await fetch(origin + `/signin/${request.id}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, useGrant: true }),
  });
  expect(response.status).toBe(200);
  expect(await store.status(caller, request.id)).toMatchObject({
    status: "approved",
    counts: { cookieCount: 1, storageKeyCount: 1 },
  });
});

it("accepts an optional operator note on approval without putting it in the audit row", async () => {
  const request = await store.create(caller, input);
  const response = await fetch(origin + `/signin/${request.id}/push`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, note: "Approved for this task" }),
  });
  expect(response.status).toBe(200);
  expect((await store.status(caller, request.id)).note).toBe("Approved for this task");
  expect(
    await fs.readFile(path.join(directory, "profiles", ".signin-audit.jsonl"), "utf8"),
  ).not.toContain("Approved for this task");
});

it("authenticates a WebSocket through its first message and sends pending state", async () => {
  const request = await store.create(caller, input);
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/signin/events");
  const message = new Promise<string>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => resolve(data.toString()));
  });
  socket.once("open", () => socket.send(JSON.stringify({ secret: "fake-signin-secret" })));
  expect(JSON.parse(await message)).toMatchObject({
    type: "pending",
    requests: [{ id: request.id }],
  });
  socket.terminate();
});

it("rejects a correct first secret when the authentication deadline already elapsed", async () => {
  await store.create(caller, input);
  const originalNow = Date.now;
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/signin/events");
  const outcome = new Promise<number | string>((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("message", () => resolve("disclosed pending requests"));
    socket.once("error", reject);
  });
  socket.once("open", () => {
    Date.now = () => originalNow() + 2100;
    socket.send(JSON.stringify({ secret: "fake-signin-secret" }));
  });
  try {
    expect(await outcome).toBe(1008);
  } finally {
    Date.now = originalNow;
    socket.terminate();
  }
});

for (const secret of [undefined, "wrong-secret"]) {
  it(`closes WebSocket ${secret === undefined ? "without authentication after two seconds" : "with a wrong secret"} without disclosing requests`, async () => {
    await store.create(caller, input);
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/signin/events");
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    const closed = new Promise<number>((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
    });
    socket.once("open", () => {
      if (secret) socket.send(JSON.stringify({ secret }));
    });
    expect(await closed).toBe(1008);
    expect(messages).toEqual([]);
  });
}

it("closes within one second with authenticated, unauthenticated and idle HTTP connections", async () => {
  const authenticated = new WebSocket(origin.replace("http:", "ws:") + "/signin/events");
  const snapshot = new Promise<void>((resolve, reject) => {
    authenticated.once("message", () => resolve());
    authenticated.once("error", reject);
  });
  authenticated.once("open", () =>
    authenticated.send(JSON.stringify({ secret: "fake-signin-secret" })),
  );
  await snapshot;
  const unauthenticated = new WebSocket(origin.replace("http:", "ws:") + "/signin/events");
  await new Promise<void>((resolve, reject) => {
    unauthenticated.once("open", resolve);
    unauthenticated.once("error", reject);
  });
  expect((await fetch(origin + "/status")).status).toBe(200);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = new Promise<boolean>((resolve) => server.close(() => resolve(true)));
    const timedOut = new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(false), 1000);
    });
    expect(await Promise.race([closed, timedOut])).toBe(true);
    expect(server.listening).toBe(false);
    expect(authenticated.readyState).not.toBe(WebSocket.OPEN);
    expect(unauthenticated.readyState).not.toBe(WebSocket.OPEN);
    const replacement = http.createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(Number(new URL(origin).port), "127.0.0.1", resolve);
    });
    expect(replacement.listening).toBe(true);
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  } finally {
    if (deadline) clearTimeout(deadline);
    authenticated.terminate();
    unauthenticated.terminate();
  }
});
