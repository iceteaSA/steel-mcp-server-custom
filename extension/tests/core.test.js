import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULTS,
  requestAccess,
  relayUrl,
  hostPattern,
  validProfile,
  cookiesForSite,
  convertCookie,
  readStorage,
  relayRequest,
  currentTab,
  sitePatterns,
  parentDomains,
} from "../core.js";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("explicit host permissions", () => {
  it("grants exact site hosts and lists parents without a public-suffix guess", () => {
    expect(sitePatterns("https://login.accounts.example.co.uk")).toEqual([
      "*://login.accounts.example.co.uk/*",
    ]);
    expect(parentDomains("login.accounts.example.co.uk")).toEqual([
      "accounts.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(parentDomains("127.0.0.1")).toEqual([]);
    expect(parentDomains("[::1]")).toEqual([]);
    expect(parentDomains("localhost")).toEqual([]);
  });
  it("requests optional access when the host is not granted", async () => {
    const calls = [];
    globalThis.chrome = {
      permissions: {
        contains: async () => false,
        request: async (input) => {
          calls.push(input);
          return true;
        },
      },
    };
    expect(await requestAccess(["https://example.com/*"])).toBe(true);
    expect(calls).toEqual([{ origins: ["https://example.com/*"] }]);
  });
  it("does not request a host that is already granted", async () => {
    let called = false;
    globalThis.chrome = {
      permissions: {
        contains: async () => true,
        request: async () => {
          called = true;
        },
      },
    };
    expect(await requestAccess(["https://example.com/*"])).toBe(true);
    expect(called).toBe(false);
  });
  it("preserves a denied grant", async () => {
    globalThis.chrome = {
      permissions: { contains: async () => false, request: async () => false },
    };
    expect(await requestAccess(["https://example.com/*"])).toBe(false);
  });
  it("ships no permanent hosts and leaves automatic sync off", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    );
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(DEFAULTS.syncEnabled).toBe(false);
    expect(DEFAULTS.pinnedSites).toEqual([]);
  });
});

describe("transfer boundaries", () => {
  it("gives loopback Host recovery steps for a relay 403", async () => {
    globalThis.chrome = { permissions: { contains: async () => true } };
    globalThis.fetch = async () => Response.json({ error: "fixture-only" }, { status: 403 });
    await expect(
      relayRequest("/profiles", {
        settings: { serverUrl: "http://localhost:3001", serverSecret: "fixture-only" },
      }),
    ).rejects.toThrow("loopback Host");
  });
  it("does not replace an unsupported active tab with an unrelated site", async () => {
    globalThis.chrome = {
      runtime: { id: "fixture-extension" },
      tabs: {
        query: async (query) =>
          query.active
            ? [{ id: 1, url: "chrome://settings" }]
            : [{ id: 2, url: "https://example.com" }],
      },
    };
    expect(await currentTab()).toBeNull();
  });

  it("does not use another site when an extension popup tab is active", async () => {
    globalThis.chrome = {
      runtime: { id: "fixture-extension" },
      tabs: {
        query: async (query) =>
          query.active
            ? [{ id: 1, url: "chrome-extension://fixture-extension/popup.html" }]
            : [
                { id: 2, url: "https://example.com", lastAccessed: 20 },
                { id: 3, url: "https://other.example", lastAccessed: 10 },
              ],
      },
    };
    expect(await currentTab()).toBeNull();
  });

  it("returns no site when the options page is active", async () => {
    globalThis.chrome = {
      runtime: { id: "fixture-extension" },
      tabs: {
        query: async (query) =>
          query.active
            ? [{ id: 1, url: "chrome-extension://fixture-extension/options.html" }]
            : [{ id: 2, url: "https://example.com" }],
      },
    };
    expect(await currentTab()).toBeNull();
  });

  it("allows HTTPS remote relays and HTTP loopback only", () => {
    expect(relayUrl("https://relay.example.com:3001")).toBe("https://relay.example.com:3001");
    expect(relayUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(() => relayUrl("http://relay.example.com")).toThrow("Use HTTPS");
    expect(() => relayUrl("https://user:private@relay.example.com")).toThrow("no path");
    expect(() => relayUrl("https://relay.example.com/?token=private")).toThrow("no path");
    expect(() => relayUrl("file:///tmp")).toThrow("HTTP or HTTPS");
    expect(hostPattern("http://localhost:3921")).toBe("http://localhost/*");
  });
  it("validates profile names before requests", () => {
    expect(validProfile("work-1_personal")).toBe("work-1_personal");
    for (const name of [undefined, null, 12, "", "../work", "a/b", "x".repeat(65)])
      expect(() => validProfile(name)).toThrow("1-64");
  });
  it("includes parent-domain cookies at all paths but not siblings", async () => {
    globalThis.chrome = {
      cookies: {
        getAll: async () => [
          { domain: ".example.com", path: "/account" },
          { domain: "app.example.com", path: "/" },
          { domain: "other.example.com", path: "/" },
          { domain: "notexample.com", path: "/" },
        ],
      },
    };
    const cookies = await cookiesForSite("https://app.example.com");
    expect(cookies.map((cookie) => cookie.domain)).toEqual([".example.com", "app.example.com"]);
    expect(cookies[0].path).toBe("/account");
  });
  it("converts cookie flags and session expiry", () => {
    const cookie = convertCookie({
      name: "session",
      value: "fixture-only",
      domain: ".example.com",
      path: "/",
      sameSite: "no_restriction",
      secure: true,
      httpOnly: true,
    });
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.expires).toBeUndefined();
    expect(cookie.sameSite).toBe("None");
  });
  it("reports unavailable storage rather than silently treating it as empty", async () => {
    globalThis.chrome = {
      scripting: {
        executeScript: async () => {
          throw new Error("tab closed");
        },
      },
    };
    expect(await readStorage(1, "https://example.com")).toEqual({ available: false, keyCount: 0 });
  });
  it("keeps count-only storage results free of entries", async () => {
    let args;
    globalThis.chrome = {
      scripting: {
        executeScript: async (input) => {
          args = input.args;
          return [{ result: { keyCount: 2 } }];
        },
      },
    };
    expect(await readStorage(1, "https://example.com", true)).toEqual({
      available: true,
      keyCount: 2,
    });
    expect(args).toEqual(["https://example.com", true]);
  });
  it("never shows raw relay errors or follows redirects", async () => {
    let options;
    globalThis.chrome = { permissions: { contains: async () => true } };
    globalThis.fetch = async (_url, init) => {
      options = init;
      return new Response('{"error":"private-marker"}', { status: 400 });
    };
    let message = "";
    try {
      await relayRequest("/push", {
        settings: { serverUrl: "http://localhost:3001", serverSecret: "fixture-only" },
      });
    } catch (error) {
      message = error.message;
    }
    expect(message.includes("private-marker")).toBe(false);
    expect(message.includes("Relay rejected")).toBe(true);
    expect(options.redirect).toBe("error");
  });
});
