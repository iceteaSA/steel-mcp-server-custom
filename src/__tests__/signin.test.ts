import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { SigninStore, normalizeSite } from "../signin";
import { request_signin, signin_status, cancel_signin } from "../tools/signin";

let directory: string;
let now: number;
let store: SigninStore;
const caller = { sessionID: "session-a", agent: "agent", title: "Task" };
const input = { site: "https://login.example.com", profile: "work", reason: "Read account" };

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-store-"));
  now = 1_000_000;
  store = await SigninStore.open({
    profilesDir: directory,
    now: () => now,
    automaticTimers: false,
  });
});
afterEach(async () => {
  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

it("normalizes origins and bounds parent domains at the registrable domain", () => {
  expect(normalizeSite("https://login.example.co.uk")).toEqual({
    site: "https://login.example.co.uk",
    host: "login.example.co.uk",
    domains: ["login.example.co.uk", "example.co.uk"],
  });
  expect(() => normalizeSite("co.uk")).toThrow("invalid_site");
  expect(() => normalizeSite("login.example.com")).toThrow("invalid_site");
  expect(() => normalizeSite("https://example.com/private?token=CANARY_PRIVATE")).toThrow(
    "invalid_site",
  );
  expect(() => normalizeSite("https://user:CANARY_PRIVATE@example.com")).toThrow("invalid_site");
});

it("merges pending duplicates, persists them with mode 0600, and isolates callers", async () => {
  const first = await store.create(caller, input);
  expect((await store.create(caller, input)).id).toBe(first.id);
  expect(first.expires - first.created).toBe(300_000);
  expect(first.caller).toEqual(caller);
  expect(await store.pending()).toHaveLength(1);
  expect((await fs.stat(path.join(directory, ".signin-state.json"))).mode & 0o777).toBe(0o600);
  const restored = await SigninStore.open({
    profilesDir: directory,
    now: () => now,
    automaticTimers: false,
  });
  expect((await restored.status(caller, first.id)).id).toBe(first.id);
  await expect(restored.status({ sessionID: "other" }, first.id)).rejects.toThrow("signin_unknown");
  restored.close();
});

it("enforces three pending requests and ten requests per caller per hour without charging merges", async () => {
  for (let index = 0; index < 3; index++)
    await store.create(caller, { ...input, profile: `p${index}` });
  await expect(store.create(caller, { ...input, profile: "p3" })).rejects.toThrow("rate_limited");
  const first = (await store.pending())[0];
  expect((await store.create(caller, { ...input, profile: first.profile })).id).toBe(first.id);
  for (const item of await store.pending()) await store.cancel(caller, item.id);
  for (let index = 3; index < 10; index++) {
    const request = await store.create(caller, { ...input, profile: `p${index}` });
    await store.cancel(caller, request.id);
  }
  await expect(store.create(caller, input)).rejects.toThrow("rate_limited");
  now += 3_600_001;
  expect((await store.create(caller, input)).status).toBe("pending");
});

it("expires and cancels requests and maps terminal tool errors without exposing state", async () => {
  const request = await request_signin(store, caller, input);
  expect(request.status).toBe("pending");
  await cancel_signin(store, caller, { id: request.id });
  expect(await signin_status(store, caller, { id: request.id })).toMatchObject({
    status: "cancelled",
    error: "signin_cancelled",
  });
  const expired = await store.create(caller, input);
  now += 300_000;
  expect(await signin_status(store, caller, { id: expired.id })).toMatchObject({
    status: "expired",
    error: "signin_expired",
  });
  const denied = await store.create(caller, input);
  await store.deny(denied.id, "Not this account");
  expect(await signin_status(store, caller, { id: denied.id })).toMatchObject({
    status: "denied",
    error: "signin_denied",
    note: "Not this account",
  });
});

it("keeps remembered grants off by default, bounds them to a site/profile, expires and revokes them", async () => {
  expect(await store.grants()).toEqual([]);
  await store.remember(input.site, input.profile);
  expect(await store.hasGrant(input.site, input.profile)).toBe(true);
  expect(await store.hasGrant("https://sibling.example.com", input.profile)).toBe(false);
  expect(await store.hasGrant(input.site, "other")).toBe(false);
  const [grant] = await store.grants();
  expect(grant.expires - grant.created).toBe(7 * 86_400_000);
  await store.revoke(grant.id);
  expect(await store.hasGrant(input.site, input.profile)).toBe(false);
  await store.remember(input.site, input.profile);
  now += 7 * 86_400_000;
  expect(await store.grants()).toEqual([]);
});

it("removes remembered authorization from pending requests when a grant is revoked or expires", async () => {
  await store.remember(input.site, input.profile);
  const request = await store.create(caller, input);
  expect(request.remembered).toBe(true);
  await store.revoke((await store.grants())[0].id);
  expect((await store.pending())[0].remembered).toBe(false);
  await store.cancel(caller, request.id);
  await store.remember(input.site, input.profile);
  now += 7 * 86_400_000 - 60_000;
  await store.create(caller, input);
  now += 60_000;
  expect((await store.pending())[0].remembered).toBe(false);
});

it("writes audit counts but never state values, and keeps the audit file at 0600", async () => {
  const request = await store.create(caller, input);
  await store.approve(request.id, { cookieCount: 2, storageKeyCount: 3 });
  const audit = await fs.readFile(path.join(directory, ".signin-audit.jsonl"), "utf8");
  expect(audit).not.toContain("CANARY_PRIVATE");
  const rows = audit
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.at(-1)).toMatchObject({
    caller,
    site: input.site,
    profile: "work",
    decision: "approved",
    cookieCount: 2,
    storageKeyCount: 3,
  });
  expect((await fs.stat(path.join(directory, ".signin-audit.jsonl"))).mode & 0o777).toBe(0o600);
});

it("long-polls until an operator decision and bounds wait to 120 seconds", async () => {
  const request = await store.create(caller, input);
  const waiting = request_signin(store, caller, { ...input, wait: 120 });
  await store.deny(request.id, "No");
  expect(await waiting).toMatchObject({ status: "denied", error: "signin_denied", note: "No" });
  await expect(request_signin(store, caller, { ...input, wait: 121 })).rejects.toThrow(
    "invalid_wait",
  );
});

it("sends one high-priority ntfy message after 60 seconds with a fake clock and no URL paths", async () => {
  const messages: { priority: string | string[] | undefined; text: string }[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    messages.push({ priority: request.headers.priority, text: Buffer.concat(chunks).toString() });
    response.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing ntfy address");
  const file = path.join(directory, "fake-topic");
  await fs.writeFile(file, `http://127.0.0.1:${address.port}/fake-topic`, { mode: 0o600 });
  const notified = await SigninStore.open({
    profilesDir: path.join(directory, "ntfy"),
    now: () => now,
    automaticTimers: false,
    ntfyTopicFile: file,
  });
  try {
    await notified.create(caller, {
      ...input,
      reason: "Read https://example.com/private-path?token=CANARY_PRIVATE " + "x".repeat(200),
    });
    now += 59_999;
    await notified.tick();
    expect(messages).toEqual([]);
    now++;
    await notified.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0].priority).toBe("high");
    expect(messages[0].text).toContain(
      "agent asks for https://login.example.com sign-in into profile work: Read https://example.com",
    );
    expect(messages[0].text).not.toContain("private-path");
    expect(messages[0].text).not.toContain("CANARY_PRIVATE");
    now += 60_000;
    await notified.tick();
    expect(messages).toHaveLength(1);
    await fs.chmod(file, 0o640);
    await notified.create({ sessionID: "new-caller" }, input);
    now += 60_000;
    await notified.tick();
    expect(messages).toHaveLength(1);
    expect(
      await fs.readFile(path.join(directory, "ntfy", ".signin-audit.jsonl"), "utf8"),
    ).toContain("ntfy_failed");
  } finally {
    notified.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("does not hold the request store queue while ntfy waits for a response", async () => {
  const file = path.join(directory, "fake-topic");
  await fs.writeFile(file, "https://ntfy.invalid/fake-topic", { mode: 0o600 });
  const notified = await SigninStore.open({ profilesDir: path.join(directory, "nonblocking"), now: () => now, automaticTimers: false, ntfyTopicFile: file });
  const originalFetch = globalThis.fetch;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const response = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => { entered(); await response; return new Response("ok"); }) as typeof fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  try {
    await notified.create(caller, input);
    now += 60_000;
    sending = notified.tick();
    await started;
    const created = notified.create({ sessionID: "other" }, input).then(() => true);
    const blocked = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000); });
    expect(await Promise.race([created, blocked])).toBe(true);
  } finally {
    release();
    if (timer) clearTimeout(timer);
    await sending;
    globalThis.fetch = originalFetch;
    notified.close();
  }
});
