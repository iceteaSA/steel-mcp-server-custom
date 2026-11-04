import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
let events;
let state;
let badge;
let requests;
let grants;
let alarm;
let accessLevel;
let sessionState;
let alarms;
const originalNow = Date.now;
const tab = { id: 1, url: "https://example.com/account", lastAccessed: 10 };
const fixtureCookie = {
  name: "fixture-name",
  value: "fixture-cookie-value",
  domain: "example.com",
  path: "/account",
  sameSite: "lax",
  secure: true,
  httpOnly: true,
};

function event(name) {
  return {
    addListener: (listener) => {
      events[name] = listener;
    },
  };
}
async function message(input) {
  return new Promise((resolve) => events.message(input, { id: "fixture-extension" }, resolve));
}

beforeEach(async () => {
  events ??= {};
  requests = [];
  grants = true;
  alarm = null;
  badge = "";
  accessLevel = "";
  state = {
    serverUrl: "http://localhost:3001",
    serverSecret: "fixture-only",
    profileName: "work",
    includeStorage: true,
  };
  sessionState = {};
  alarms = new Map();
  globalThis.chrome = {
    runtime: {
      id: "fixture-extension",
      onMessage: event("message"),
      onInstalled: event("installed"),
      onStartup: event("startup"),
    },
    storage: {
      session: {
        get: async () => ({ ...sessionState }),
        set: async (value) => {
          Object.assign(sessionState, value);
        },
        remove: async (key) => {
          delete sessionState[key];
        },
      },
      local: {
        get: async (keys) =>
          Array.isArray(keys)
            ? Object.fromEntries(keys.map((key) => [key, state[key]]))
            : { ...keys, ...state },
        set: async (input) => {
          Object.assign(state, input);
        },
        setAccessLevel: async (input) => {
          accessLevel = input.accessLevel;
        },
      },
      onChanged: event("changed"),
    },
    permissions: {
      contains: async (input) =>
        input.origins.some((origin) => ["http://*/*", "https://*/*"].includes(origin))
          ? false
          : grants,
      remove: async () => true,
      onAdded: event("permissionAdded"),
    },
    cookies: { getAll: async () => [fixtureCookie] },
    tabs: { query: async () => [tab] },
    scripting: {
      executeScript: async (input) => [
        {
          result: input.args[1]
            ? { keyCount: 1 }
            : { keyCount: 1, entries: { fixture: "fixture-storage-value" } },
        },
      ],
    },
    action: {
      setBadgeText: async (input) => {
        badge = input.text;
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    alarms: {
      clear: async (name) => {
        alarms.delete(name);
        if (name === "steel-pinned-sync") alarm = null;
      },
      create: async (name, input) => {
        alarms.set(name, input);
        if (name === "steel-pinned-sync") alarm = input;
      },
      onAlarm: event("alarm"),
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: event("context") },
    commands: { onCommand: event("command") },
  };
  globalThis.fetch = async (url, input) => {
    requests.push({ url, input });
    return Response.json({ cookieCount: 1 });
  };
  const worker = await import("../background.js");
  await worker.discoveryReady;
});
afterEach(() => {
  Date.now = originalNow;
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("MV3 transfer worker", () => {
  it("revokes a killed run at its recorded deadline after worker restart", () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./worker-start.mjs", import.meta.url)),
        JSON.stringify({ startedAt: 90000 }),
        "100000",
        "expire",
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).origins).toEqual(["https://example.com/*"]);
  });
  for (const lifecycle of ["startup", "installed"]) {
    it(`revokes orphan wildcard access on ${lifecycle} and preserves exact hosts`, async () => {
      const origins = new Set(["https://example.com/*", "http://*/*", "https://*/*"]);
      chrome.permissions.contains = async (input) =>
        input.origins.every((origin) => origins.has(origin));
      chrome.permissions.remove = async (input) => {
        for (const origin of input.origins) origins.delete(origin);
        return true;
      };
      await events[lifecycle]();
      expect([...origins]).toEqual(["https://example.com/*"]);
    });
  }
  for (const [label, record] of [
    ["no", null],
    ["expired", { startedAt: 1 }],
    ["malformed", { startedAt: "90000" }],
    ["future", { startedAt: 100001 }],
  ]) {
    it(`revokes orphan access at worker evaluation with ${label} run record`, () => {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./worker-start.mjs", import.meta.url)),
          JSON.stringify(record),
          "100000",
        ],
        { encoding: "utf8" },
      );
      expect(child.status).toBe(0);
      const proof = JSON.parse(child.stdout);
      expect(proof.origins).toEqual(["https://example.com/*"]);
    });
  }
  it("retains a young recorded run only until its deadline after worker restart", () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./worker-start.mjs", import.meta.url)),
        JSON.stringify({ startedAt: 90000 }),
        "100000",
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    const proof = JSON.parse(child.stdout);
    expect(proof.alarm).toEqual({ when: 150000 });
    expect(proof.origins.includes("http://*/*")).toBe(true);
    expect(proof.origins.includes("https://example.com/*")).toBe(true);
  });

  it("expires an onAdded wildcard grant even when no discover message arrives", async () => {
    const origins = new Set(["https://example.com/*", "http://*/*", "https://*/*"]);
    chrome.permissions.contains = async (input) =>
      input.origins.every((origin) => origins.has(origin));
    chrome.permissions.remove = async (input) => {
      for (const origin of input.origins) origins.delete(origin);
      return true;
    };
    Date.now = () => 1000;
    await events.permissionAdded?.({ origins: ["http://*/*", "https://*/*"] });
    expect(alarms.get("steel-discovery-deadline")).toEqual({ when: 61000 });
    Date.now = () => 61000;
    await events.alarm({ name: "steel-discovery-deadline" });
    expect([...origins]).toEqual(["https://example.com/*"]);
  });

  it("keeps a running discover until completion and then removes wildcard access", async () => {
    const origins = new Set(["https://example.com/*", "http://*/*", "https://*/*"]);
    chrome.permissions.contains = async (input) =>
      input.origins.every((origin) => origins.has(origin));
    chrome.permissions.remove = async (input) => {
      for (const origin of input.origins) origins.delete(origin);
      return true;
    };
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    chrome.cookies.getAll = async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return [fixtureCookie];
    };
    Date.now = () => 1000;
    const response = message({ type: "discover" });
    await started;
    expect(sessionState.discoveryRun).toEqual({ startedAt: 1000 });
    Date.now = () => 61000;
    await events.alarm({ name: "steel-discovery-deadline" });
    expect(origins.has("http://*/*")).toBe(true);
    release();
    expect((await response).ok).toBe(true);
    expect([...origins]).toEqual(["https://example.com/*"]);
    expect(sessionState.discoveryRun).toBeUndefined();
  });

  it("does not push another tab when the options page is active", async () => {
    chrome.tabs.query = async () => [
      { id: 2, url: "chrome-extension://fixture-extension/options.html" },
      tab,
    ];
    await events.command("push-site");
    expect(requests.length).toBe(0);
  });
  for (const failure of [false, true]) {
    it(`revokes only wildcard discovery access after ${failure ? "failure" : "success"}`, async () => {
      const origins = new Set([
        "https://example.com/*",
        "http://localhost/*",
        "http://*/*",
        "https://*/*",
      ]);
      const removals = [];
      chrome.permissions.remove = async (input) => {
        removals.push(input);
        for (const origin of input.origins) origins.delete(origin);
        return true;
      };
      chrome.permissions.contains = async (input) =>
        input.origins.every((origin) => origins.has(origin));
      if (failure)
        chrome.cookies.getAll = async () => {
          throw new Error("fixture cookie read failed");
        };
      const response = await message({ type: "discover" });
      expect(removals).toEqual([{ origins: ["http://*/*", "https://*/*"] }]);
      expect([...origins]).toEqual(["https://example.com/*", "http://localhost/*"]);
      expect(response.ok).toBe(!failure);
      if (!failure) {
        expect(response.data.map((entry) => entry.domain)).toEqual(["example.com"]);
        expect(JSON.stringify(sessionState.discoveredSites).includes("fixture-")).toBe(false);
      }
    });
  }

  it("returns site counts without cookie or storage entries", async () => {
    const response = await message({ type: "site" });
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      domain: "example.com",
      url: "https://example.com",
      tabId: 1,
      granted: true,
      cookieCount: 1,
      storageKeyCount: 1,
      parents: [],
    });
    expect(JSON.stringify(response).includes("fixture-")).toBe(false);
  });

  it("pushes data but persists only counts and status", async () => {
    const response = await message({
      type: "push",
      sites: [{ url: tab.url, tabId: 1 }],
      profile: "work",
      includeStorage: true,
    });
    expect(response.ok).toBe(true);
    expect(response.data[0]).toEqual({
      domain: "example.com",
      profile: "work",
      ok: true,
      cookieCount: 1,
      storageKeyCount: 1,
      warning: "",
    });
    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("http://localhost:3001/push");
    expect(JSON.stringify(state.lastResults).includes("fixture-")).toBe(false);
    expect(badge).toBe("OK");
  });

  it("refuses to push an ungranted site", async () => {
    grants = false;
    const response = await message({
      type: "push",
      sites: [{ url: tab.url }],
      profile: "work",
      includeStorage: false,
    });
    expect(response.data[0].ok).toBe(false);
    expect(response.data[0].error.includes("Site access missing")).toBe(true);
    expect(requests.length).toBe(0);
    expect(badge).toBe("ERR");
  });

  it("reports storage failures with a warning badge, not silent success", async () => {
    chrome.scripting.executeScript = async () => {
      throw new Error("tab closed");
    };
    const response = await message({
      type: "push",
      sites: [{ url: tab.url }],
      profile: "work",
      includeStorage: true,
    });
    expect(response.data[0].ok).toBe(true);
    expect(response.data[0].warning.includes("Storage unavailable")).toBe(true);
    expect(badge).toBe("!");
  });

  it("does not silently discard partitioned cookies", async () => {
    chrome.cookies.getAll = async () => [
      { ...fixtureCookie, partitionKey: { topLevelSite: "https://example.com" } },
    ];
    const response = await message({
      type: "push",
      sites: [{ url: tab.url }],
      profile: "work",
      includeStorage: false,
    });
    expect(response.data[0].ok).toBe(false);
    expect(response.data[0].error.includes("Partitioned cookies")).toBe(true);
    expect(requests.length).toBe(0);
  });

  it("batches per-item outcomes without hiding earlier failures", async () => {
    const response = await message({
      type: "push",
      sites: [{ url: "chrome://settings" }, { url: tab.url }],
      profile: "work",
      includeStorage: false,
    });
    expect(response.data.map((result) => result.ok)).toEqual([false, true]);
    expect(state.lastResults.length).toBe(2);
    expect(badge).toBe("ERR");
  });

  it("registers startup access restrictions and keeps alarms off by default", async () => {
    await events.installed();
    expect(accessLevel).toBe("TRUSTED_CONTEXTS");
    expect(alarm).toBeNull();
    state.syncEnabled = true;
    state.syncMinutes = 30;
    state.pinnedSites = [{ url: "https://example.com", profile: "work", includeStorage: false }];
    expect((await message({ type: "alarm" })).ok).toBe(true);
    expect(alarm).toEqual({ periodInMinutes: 30 });
  });

  it("runs pinned sync through the alarm listener", async () => {
    state.syncEnabled = true;
    state.pinnedSites = [
      { url: "chrome://settings", profile: "work", includeStorage: false },
      { url: "https://example.com", profile: "work", includeStorage: false },
    ];
    await events.alarm({ name: "steel-pinned-sync" });
    expect(state.lastResults.map((result) => result.ok)).toEqual([false, true]);
    expect(badge).toBe("ERR");
  });

  it("uses the same worker path for context menu and keyboard commands", async () => {
    await events.context({ menuItemId: "steel-push" }, tab);
    expect(requests.length).toBe(1);
    await events.command("push-site");
    expect(requests.length).toBe(2);
    expect(badge).toBe("OK");
  });

  it("rejects a second push while another push owns the worker", async () => {
    let release;
    let reached;
    const started = new Promise((resolve) => {
      reached = resolve;
    });
    globalThis.fetch = async () => {
      reached();
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({});
    };
    const first = message({
      type: "push",
      sites: [{ url: tab.url }],
      profile: "work",
      includeStorage: false,
    });
    await started;
    const second = await message({
      type: "push",
      sites: [{ url: tab.url }],
      profile: "work",
      includeStorage: false,
    });
    expect(second.ok).toBe(false);
    expect(second.error.includes("in progress")).toBe(true);
    release();
    expect((await first).ok).toBe(true);
  });
});
