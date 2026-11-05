import { afterEach, beforeEach, expect, it } from "bun:test";
import { startSigninWorker } from "../signin-worker.js";
import { chromeContains } from "./permission-fixture.js";

const original = {
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
let client;
let sockets;
let events;
let notifications;
let badges;
let tabs;
let requests;
let fetches;
let session;
let alarms;
let timers;
let settings;
let localState;
let origins;
const request = {
  id: "one",
  caller: { agent: "agent", title: "Task" },
  site: "https://example.com",
  domains: ["example.com"],
  profile: "work",
  reason: "Read account",
  expires: Date.now() + 300_000,
};
function event(name) {
  return {
    addListener(listener) {
      events[name] = listener;
    },
  };
}

beforeEach(() => {
  sockets = [];
  events = {};
  notifications = [];
  badges = [];
  tabs = [];
  fetches = [];
  session = {};
  alarms = [];
  timers = new Map();
  requests = [{ ...request }];
  settings = { serverUrl: "http://localhost:3001", serverSecret: "fake-secret" };
  localState = {};
  origins = ["http://localhost/*", "https://example.com/*", "http://example.com/*"];
  globalThis.setInterval = (callback, delay) => {
    const id = timers.size + 1;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  globalThis.WebSocket = class {
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    receive(data) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  };
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://fake/${path}` },
    storage: {
      local: {
        get: async () => ({ ...settings, ...localState }),
      },
      session: {
        get: async () => ({ ...session }),
        set: async (value) => Object.assign(session, value),
      },
      onChanged: event("changed"),
    },
    permissions: {
      contains: async (input) => chromeContains(origins, input.origins),
      onAdded: event("permissionAdded"),
      onRemoved: event("permissionRemoved"),
    },
    alarms: {
      create: async (name, options) => alarms.push({ name, options }),
      onAlarm: event("alarm"),
    },
    notifications: {
      create: async (id, options) => notifications.push({ id, options }),
      clear: async () => {},
      onButtonClicked: event("button"),
      onClicked: event("clicked"),
    },
    action: {
      setBadgeText: async ({ text }) => badges.push(text),
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: { create: async (input) => tabs.push(input), query: async () => [] },
    cookies: {
      getAll: async () => [
        { name: "sid", value: "CANARY_PRIVATE", domain: "example.com", path: "/" },
      ],
    },
  };
  globalThis.fetch = async (url, options) => {
    fetches.push({ url, options });
    if (url.endsWith("/push") || url.endsWith("/deny")) {
      requests = [];
      return Response.json({ status: "approved", cookieCount: 1, storageKeyCount: 0 });
    }
    return Response.json({ requests });
  };
});
afterEach(() => {
  client?.stop();
  Object.assign(globalThis, original);
});

it("authenticates the socket in its first message, keeps it alive under 30 seconds, and polls every 30 seconds", async () => {
  client = startSigninWorker();
  await client.start();
  expect(sockets).toHaveLength(1);
  expect(sockets[0].url).toBe("ws://localhost:3001/signin/events");
  sockets[0].open();
  expect(sockets[0].sent).toEqual([{ secret: "fake-secret" }]);
  expect([...timers.values()].map((timer) => timer.delay)).toEqual([20_000]);
  [...timers.values()][0].callback();
  expect(sockets[0].sent.at(-1)).toEqual({ type: "keepalive" });
  expect(alarms).toContainEqual({ name: "steel-signin-poll", options: { periodInMinutes: 0.5 } });
  const before = fetches.length;
  await events.alarm({ name: "steel-signin-poll" });
  expect(fetches.length).toBe(before + 1);
});

it("deduplicates interactive notifications, shows pending count, opens Review, and denies the selected id", async () => {
  client = startSigninWorker();
  await client.start();
  await client.update(requests);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    id: "signin:one",
    options: {
      requireInteraction: true,
      message: "agent asks for https://example.com sign-in into profile work: Read account",
      buttons: [{ title: "Review" }, { title: "Deny" }],
    },
  });
  expect(badges.at(-1)).toBe("1");
  await events.button("signin:one", 0);
  expect(tabs).toEqual([{ url: "chrome-extension://fake/approval.html?id=one" }]);
  await events.button("signin:one", 1);
  expect(fetches.some((entry) => entry.url.endsWith("/signin/one/deny"))).toBe(true);
  expect(badges.at(-1)).toBe("");
  expect(JSON.stringify(session)).not.toContain("CANARY_PRIVATE");
});

it("uses remembered grants without a notification or duplicate push when a stale snapshot arrives", async () => {
  requests = [{ ...request, remembered: true }];
  const stale = structuredClone(requests);
  client = startSigninWorker();
  await client.start();
  await client.update(stale);
  expect(notifications).toEqual([]);
  expect(fetches.filter((entry) => entry.url.endsWith("/push"))).toHaveLength(1);
  expect(
    JSON.parse(fetches.find((entry) => entry.url.endsWith("/push")).options.body).useGrant,
  ).toBe(true);
  expect(badges.at(-1)).toBe("");
  expect(client.pending).toEqual([]);
  expect(JSON.stringify(session)).not.toContain("CANARY_PRIVATE");
});

it("records relay transitions without settings and keeps the outage time and down badge across retries", async () => {
  requests = [];
  client = startSigninWorker();
  await client.start();
  sockets[0].open();
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "connected" });
  sockets[0].close();
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "disconnected", since: expect.any(Number) });
  const since = session.signinRelay.since;
  expect(badges.at(-1)).toBe("!");
  const count = badges.length;
  await events.alarm({ name: "steel-signin-poll" });
  sockets[1].close();
  await client.update([]);
  expect(session.signinRelay.since).toBe(since);
  expect(badges.slice(count)).toEqual([]);
  await events.alarm({ name: "steel-signin-poll" });
  sockets[2].open();
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "connected" });
  expect(badges.at(-1)).toBe("");
  expect(JSON.stringify(session)).not.toContain("fake-secret");
  expect(JSON.stringify(session)).not.toContain("localhost");
});

it("shows relay down even with pending requests and preserves the pending badge on recovery", async () => {
  client = startSigninWorker();
  await client.start();
  sockets[0].open();
  await client.update(requests);
  sockets[0].onerror();
  await client.update(requests);
  expect(badges.at(-1)).toBe("!");
  await events.alarm({ name: "steel-signin-poll" });
  sockets[1].open();
  await client.update(requests);
  expect(badges.at(-1)).toBe("1");
});

it("records synchronous connection failures without persisting exception text", async () => {
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("SYNTHETIC_SECRET URL");
    }
  };
  client = startSigninWorker();
  await client.start();
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "disconnected", since: expect.any(Number) });
  expect(JSON.stringify(session)).not.toContain("SYNTHETIC_SECRET");
  expect(badges.at(-1)).toBe("!");
});

it("restores the stored push failure after ERR to down to reconnected", async () => {
  requests = [];
  client = startSigninWorker();
  await client.start();
  sockets[0].open();
  await client.update([]);
  localState.lastResults = [{ ok: false, domain: "example.com", error: "Synthetic failure" }];
  localState.lastSync = "2026-11-05T00:00:00Z";
  await chrome.action.setBadgeText({ text: "ERR" });
  expect(badges.at(-1)).toBe("ERR");
  sockets[0].close();
  await client.update([]);
  expect(badges.at(-1)).toBe("!");
  await events.alarm({ name: "steel-signin-poll" });
  sockets[1].open();
  await client.update([]);
  expect(badges.at(-1)).toBe("ERR");
  expect(localState.lastSync).toBe("2026-11-05T00:00:00Z");
});

it("derives the result after a push lands during a queued reconnect", async () => {
  requests = [];
  client = startSigninWorker();
  await client.start();
  sockets[0].close();
  await client.update([]);
  await events.alarm({ name: "steel-signin-poll" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const set = chrome.storage.session.set;
  let held = false;
  chrome.storage.session.set = async (value) => {
    if (value.signinNotified && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return set(value);
  };
  const update = client.update([]);
  await entered.promise;
  sockets[1].open();
  localState.lastResults = [{ ok: false, domain: "example.com", error: "Synthetic failure" }];
  events.changed({ lastResults: { newValue: localState.lastResults } }, "local");
  release.resolve();
  await update;
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "connected" });
  expect(badges.at(-1)).toBe("ERR");
});

for (const missing of ["secret", "URL"]) {
  it(`marks a missing ${missing} as unconfigured without an outage badge`, async () => {
    requests = [];
    if (missing === "secret") settings.serverSecret = "";
    else settings.serverUrl = "";
    client = startSigninWorker();
    await client.start();
    await client.update([]);
    expect(session.signinRelay).toEqual({ status: "unconfigured" });
    expect(badges.at(-1)).toBe("");
    expect(sockets).toEqual([]);
  });
}

it("marks saved settings without relay access as needs_access ahead of pending and push badges", async () => {
  origins = ["https://unrelated.example/*"];
  localState.lastResults = [{ ok: false, domain: "example.com" }];
  client = startSigninWorker();
  await client.start();
  await client.update(requests);
  expect(session.signinRelay).toEqual({ status: "needs_access" });
  expect(badges.at(-1)).toBe("!");
  expect(sockets).toEqual([]);
  expect(fetches).toEqual([]);
});

it("connects immediately on relay permission addition and drops the socket on removal", async () => {
  origins = [];
  requests = [];
  client = startSigninWorker();
  await client.start();
  expect(sockets).toEqual([]);
  expect(events.permissionAdded).toBeFunction();
  expect(events.permissionRemoved).toBeFunction();
  origins.push("http://localhost/*");
  await events.permissionAdded({ origins: ["http://localhost/*"] });
  expect(sockets).toHaveLength(1);
  sockets[0].open();
  await client.update([]);
  expect(session.signinRelay).toEqual({ status: "connected" });
  expect(badges.at(-1)).toBe("");
  origins = [];
  await events.permissionRemoved({ origins: ["http://localhost/*"] });
  await client.update([]);
  expect(sockets[0].readyState).toBe(3);
  expect(session.signinRelay).toEqual({ status: "needs_access" });
  expect(badges.at(-1)).toBe("!");
  origins.push("http://*/*");
  await events.permissionAdded({ origins: ["http://*/*"] });
  expect(sockets).toHaveLength(2);
});

it("rechecks a permission change that arrives during an in-flight permission read", async () => {
  requests = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const contains = chrome.permissions.contains;
  let held = false;
  chrome.permissions.contains = async (input) => {
    const allowed = await contains(input);
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return allowed;
  };
  client = startSigninWorker();
  await entered.promise;
  origins = [];
  const changed = events.permissionRemoved?.({ origins: ["http://localhost/*"] });
  release.resolve();
  await changed;
  await client.update([]);
  expect(events.permissionRemoved).toBeFunction();
  expect(session.signinRelay).toEqual({ status: "needs_access" });
  expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it("recomputes the badge on session relay and local result changes without changing the result time", async () => {
  requests = [];
  client = startSigninWorker();
  await client.start();
  sockets[0].open();
  await client.update([]);
  localState.lastResults = [{ ok: true, domain: "example.com" }];
  localState.lastSync = "2026-11-05T00:00:00Z";
  await events.changed({ lastResults: { newValue: localState.lastResults } }, "local");
  await client.update([]);
  expect(badges.at(-1)).toBe("OK");
  session.signinRelay = { status: "disconnected", since: Date.now() };
  await events.changed({ signinRelay: { newValue: session.signinRelay } }, "session");
  await client.update([]);
  expect(badges.at(-1)).toBe("!");
  session.signinRelay = { status: "connected" };
  await events.changed({ signinRelay: { newValue: session.signinRelay } }, "session");
  await client.update([]);
  expect(badges.at(-1)).toBe("OK");
  expect(localState.lastSync).toBe("2026-11-05T00:00:00Z");
});
