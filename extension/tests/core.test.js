import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as core from "../core.js";
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
const signin = {
  id: "request-one",
  site: "https://login.example.com",
  domains: ["login.example.com", "example.com"],
  profile: "work",
  expires: Date.now() + 300000,
};
afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("request-scoped sign-in transfer", () => {
  it("requests exact hosts on the click before any asynchronous read, then pushes only scoped state", async () => {
    const calls = [];
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({ serverUrl: "http://localhost:3001", serverSecret: "fixture-only" }),
        },
      },
      permissions: {
        request: (input) => {
          calls.push({ permission: input });
          return Promise.resolve(true);
        },
        contains: async () => true,
      },
      cookies: {
        getAll: async () => {
          calls.push("cookies");
          return [
            { name: "sid", value: "CANARY_PRIVATE", domain: ".example.com", path: "/" },
            { name: "sibling", value: "CANARY_PRIVATE", domain: "sibling.example.com", path: "/" },
            { name: "public", value: "CANARY_PRIVATE", domain: "com", path: "/" },
          ];
        },
      },
      tabs: { query: async () => [{ id: 1, url: "https://login.example.com/private" }] },
      scripting: {
        executeScript: async () => [
          { result: { keyCount: 1, entries: { token: "CANARY_PRIVATE" } } },
        ],
      },
    };
    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ status: "approved", cookieCount: 1, storageKeyCount: 1 });
    };
    const transfer = core.approveSignin(signin, true);
    expect(calls).toEqual([
      {
        permission: {
          origins: [
            "https://login.example.com/*",
            "http://login.example.com/*",
            "https://example.com/*",
            "http://example.com/*",
          ],
        },
      },
    ]);
    expect(await transfer).toMatchObject({ status: "approved" });
    expect(calls.at(-1)).toEqual({
      url: "http://localhost:3001/signin/request-one/push",
      body: {
        profile: "work",
        cookies: [{ name: "sid", value: "CANARY_PRIVATE", domain: ".example.com", path: "/" }],
        localStorage: { "https://login.example.com": { token: "CANARY_PRIVATE" } },
        remember: true,
      },
    });
  });

  it("sends no data when request host permission is denied", async () => {
    let reads = 0;
    globalThis.chrome = {
      permissions: { request: async () => false },
      cookies: {
        getAll: async () => {
          reads++;
          return [];
        },
      },
    };
    await expect(core.approveSignin(signin, false)).rejects.toThrow("not granted");
    expect(reads).toBe(0);
  });

  it("previews cookie names and storage counts without returning values", async () => {
    globalThis.chrome = {
      permissions: { contains: async () => true },
      cookies: {
        getAll: async () => [
          { name: "sid", value: "CANARY_PRIVATE", domain: ".example.com", path: "/" },
        ],
      },
      tabs: { query: async () => [{ id: 1, url: "https://login.example.com/private" }] },
      scripting: {
        executeScript: async (input) => {
          expect(input.args[1]).toBe(true);
          return [{ result: { keyCount: 2 } }];
        },
      },
    };
    const preview = await core.previewSignin(signin);
    expect(preview).toEqual({
      cookies: [{ name: "sid", domain: ".example.com" }],
      cookieCount: 1,
      storage: [{ origin: "https://login.example.com", keyCount: 2 }],
      storageAvailable: true,
    });
    expect(JSON.stringify(preview)).not.toContain("CANARY_PRIVATE");
  });
});

describe("explicit host permissions", () => {
  it("grants exact site hosts and lists parents without a public-suffix guess", () => {
    expect(sitePatterns("https://login.accounts.example.co.uk")).toEqual([
      "https://login.accounts.example.co.uk/*",
      "http://login.accounts.example.co.uk/*",
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

  it("uses the popup's tab ID instead of a window query", async () => {
    const queries = [];
    globalThis.chrome = {
      runtime: { id: "fixture-extension" },
      tabs: {
        get: async (id) => (id === 7 ? { id: 7, url: "https://app.example.com/login" } : null),
        query: async (query) => {
          queries.push(query);
          return [{ id: 1, url: "https://other-window.example" }];
        },
      },
    };
    expect((await currentTab(7))?.url).toBe("https://app.example.com/login");
    expect(queries).toEqual([]);
  });

  it("returns no site for a non-HTTP tab ID or a closed tab", async () => {
    globalThis.chrome = {
      runtime: { id: "fixture-extension" },
      tabs: {
        get: async (id) => {
          if (id === 8) return { id: 8, url: "vivaldi://startpage" };
          throw new Error("No tab with id");
        },
        query: async () => [{ id: 1, url: "https://other-window.example" }],
      },
    };
    expect(await currentTab(8)).toBeNull();
    expect(await currentTab(9)).toBeNull();
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

// Chrome accepts permissions.request and permissions.contains only when ONE declared pattern
// contains each requested pattern (URLPatternSet::Contains). A "*://" request is not inside
// "http://*/*" or "https://*/*" alone, so Chrome refuses it with
// "Only permissions specified in the manifest may be requested."
function chromeContains(declared, requested) {
  const parse = (pattern) => {
    const match = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!match) throw new Error(`bad pattern ${pattern}`);
    return { scheme: match[1], host: match[2], path: match[3] };
  };
  const one = (outer, inner) =>
    (outer.scheme === "*" || outer.scheme === inner.scheme) &&
    (outer.host === "*" || outer.host === inner.host) &&
    outer.path === "/*";
  const pool = declared.map(parse);
  return requested.every((pattern) => pool.some((outer) => one(outer, parse(pattern))));
}

describe("requested host patterns fit the manifest one pattern at a time", () => {
  it("covers site, parent and sign-in patterns with a declared optional pattern", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    );
    const declared = manifest.optional_host_permissions;
    expect(chromeContains(declared, ["*://example.com/*"])).toBe(false);
    const requests = [
      sitePatterns("https://login.example.com/path"),
      sitePatterns("http://127.0.0.1:8080/"),
      core.signinPatterns({ domains: ["login.example.com", "example.com"] }),
    ];
    for (const requested of requests) {
      expect(requested.length).toBeGreaterThan(0);
      expect({ requested, ok: chromeContains(declared, requested) }).toEqual({
        requested,
        ok: true,
      });
    }
    expect(core.domainPatterns("example.com")).toEqual([
      "https://example.com/*",
      "http://example.com/*",
    ]);
    expect(chromeContains(declared, core.domainPatterns("example.com"))).toBe(true);
  });
  it("builds no wildcard-scheme host pattern in the extension sources", async () => {
    for (const file of ["core.js", "background.js", "popup.js", "approval.js", "options.js"]) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect({ file, wildcard: source.includes("`*://${") }).toEqual({ file, wildcard: false });
    }
  });
});
