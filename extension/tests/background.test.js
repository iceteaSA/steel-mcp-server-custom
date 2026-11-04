import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
let events;
let state;
let badge;
let requests;
let grants;
let alarm;
let accessLevel;
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
  globalThis.chrome = {
    runtime: {
      id: "fixture-extension",
      onMessage: event("message"),
      onInstalled: event("installed"),
      onStartup: event("startup"),
    },
    storage: {
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
    permissions: { contains: async () => grants },
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
      clear: async () => {
        alarm = null;
      },
      create: async (_name, input) => {
        alarm = input;
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
  await import("../background.js");
});
afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("MV3 transfer worker", () => {
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
      if (!failure) expect(response.data.map((entry) => entry.domain)).toEqual(["example.com"]);
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
