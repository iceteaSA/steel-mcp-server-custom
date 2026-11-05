import { afterEach, beforeEach, expect, it } from "bun:test";
import { startSigninWorker } from "../signin-worker.js";

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
        get: async () => ({ serverUrl: "http://localhost:3001", serverSecret: "fake-secret" }),
      },
      session: {
        get: async () => ({ ...session }),
        set: async (value) => Object.assign(session, value),
      },
      onChanged: event("changed"),
    },
    permissions: { contains: async () => true },
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
