import { afterAll, beforeAll, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { startRelayServer } from "../relay";

let server: http.Server;
let directory: string;
let origin: string;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-relay-"));
  server = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "fake-signin-secret",
    profilesDir: path.join(directory, "profiles"),
    credentialsFile: path.join(directory, "credentials.json"),
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(directory, { recursive: true, force: true });
});

it("requires Bearer authentication before listing pending sign-in requests", async () => {
  const response = await fetch(origin + "/signin");
  expect(response.status).toBe(401);
});

it("lists pending sign-in requests without exposing saved state", async () => {
  const response = await fetch(origin + "/signin", {
    headers: { Authorization: "Bearer fake-signin-secret" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ requests: [] });
});

it("rejects an unknown request id instead of writing a profile", async () => {
  const response = await fetch(origin + "/signin/unknown/push", {
    method: "POST",
    headers: { Authorization: "Bearer fake-signin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "work", cookies: [{ name: "sid", value: "CANARY_PRIVATE", domain: "example.com", path: "/" }] }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "signin_unknown" });
  expect(await fs.exists(path.join(directory, "profiles", "work.json"))).toBe(false);
});
