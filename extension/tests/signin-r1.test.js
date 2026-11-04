import { afterEach, expect, it } from "bun:test";
import { previewSignin, pushSignin, convertCookie } from "../core.js";
const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; });
const request = { id: "r1", site: "example.com", domains: ["example.com"], profile: "work", expires: Date.now() + 300_000 };

it("reads bare-domain storage only from HTTPS on the default port", async () => {
  const origins = [];
  globalThis.chrome = {
    permissions: { contains: async () => true }, cookies: { getAll: async () => [] },
    tabs: { query: async () => [{ id: 1, url: "http://example.com/" }, { id: 2, url: "https://example.com:8443/" }, { id: 3, url: "https://example.com/" }] },
    scripting: { executeScript: async (input) => { origins.push(input.args[0]); return [{ result: { keyCount: 1 } }]; } },
  };
  expect((await previewSignin(request)).storage).toEqual([{ origin: "https://example.com", keyCount: 1 }]);
  expect(origins).toEqual(["https://example.com"]);
});
it("carries Chrome hostOnly in sign-in pushes without changing manual cookie conversion", async () => {
  const cookie = { name: "__Host-sid", value: "CANARY_PRIVATE", domain: "example.com", path: "/", secure: true, hostOnly: true };
  let body;
  globalThis.chrome = {
    storage: { local: { get: async () => ({ serverUrl: "http://localhost:3001", serverSecret: "fake-r1-secret" }) } },
    permissions: { contains: async () => true }, cookies: { getAll: async () => [cookie] }, tabs: { query: async () => [] },
  };
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ status: "approved" }); };
  await pushSignin(request);
  expect(body.cookies[0].hostOnly).toBe(true);
  expect(convertCookie(cookie)).not.toHaveProperty("hostOnly");
});
