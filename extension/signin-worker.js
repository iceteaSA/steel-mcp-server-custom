import { getSettings, relayUrl, hostPattern, relayRequest, pushSignin } from "./core.js";
import { createBadgeRenderer } from "./badge.js";

export function startSigninWorker() {
  const alarmName = "steel-signin-poll";
  let socket;
  let connections = Promise.resolve();
  let ping;
  let pending = [];
  let updates = Promise.resolve();
  let relayState;
  const badge = createBadgeRenderer(() => pending.length);
  let stopped = false;
  const relayReady = chrome.storage.session.get("signinRelay").then(({ signinRelay }) => {
    if (signinRelay?.status === "disconnected" && Number.isFinite(signinRelay.since))
      relayState = { status: "disconnected", since: signinRelay.since };
  });
  const applying = new Set();
  const completed = new Map();

  function relay(status) {
    updates = updates
      .catch(() => {})
      .then(async () => {
        await relayReady;
        if (relayState?.status !== status) {
          relayState = status === "disconnected" ? { status, since: Date.now() } : { status };
          await chrome.storage.session.set({ signinRelay: relayState });
        }
        await badge();
      });
    return updates;
  }

  const review = (id) =>
    chrome.tabs.create({
      url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`),
    });
  async function deny(id) {
    await relayRequest(`/signin/${encodeURIComponent(id)}/deny`, {
      method: "POST",
      body: { note: "Denied from notification" },
    });
    await chrome.notifications.clear(`signin:${id}`);
    await poll();
  }
  async function render(requests) {
    for (const [id, expires] of completed) if (expires <= Date.now()) completed.delete(id);
    const active = requests.filter(
      (request) => request.expires > Date.now() && !completed.has(request.id),
    );
    const { signinNotified = [] } = await chrome.storage.session.get("signinNotified");
    const notified = new Set(signinNotified);
    for (const request of active) {
      if (request.remembered && !applying.has(request.id)) {
        applying.add(request.id);
        try {
          await pushSignin(request, false, true);
          completed.set(request.id, request.expires);
          continue;
        } catch {
          /* An operator click in Review is necessary for host access. */
        } finally {
          applying.delete(request.id);
        }
      }
      if (notified.has(request.id)) continue;
      await chrome.notifications.create(`signin:${request.id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Steel sign-in request",
        message: `${request.caller.agent ?? "Agent"} asks for ${request.site} sign-in into profile ${request.profile}: ${request.reason}`,
        requireInteraction: true,
        buttons: [{ title: "Review" }, { title: "Deny" }],
      });
      notified.add(request.id);
    }
    pending = active.filter((request) => !completed.has(request.id));
    const ids = new Set(pending.map((request) => request.id));
    for (const id of signinNotified)
      if (!ids.has(id)) await chrome.notifications.clear(`signin:${id}`);
    await chrome.storage.session.set({ signinNotified: [...notified].filter((id) => ids.has(id)) });
    await badge();
  }
  function update(requests) {
    updates = updates.catch(() => {}).then(() => render(requests));
    return updates;
  }
  async function poll() {
    const { requests } = await relayRequest("/signin");
    if (!Array.isArray(requests)) throw new Error("Invalid pending request list.");
    await update(requests);
  }
  function connect() {
    connections = connections
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        try {
          const settings = await getSettings();
          if (!settings.serverUrl || !settings.serverSecret) {
            await relay("unconfigured");
            return;
          }
          const origin = relayUrl(settings.serverUrl);
          if (!(await chrome.permissions.contains({ origins: [hostPattern(origin)] }))) {
            clearInterval(ping);
            socket?.close();
            socket = undefined;
            await relay("needs_access");
            return;
          }
          if (socket && socket.readyState <= 1) return;
          const current = new WebSocket(origin.replace(/^http/, "ws") + "/signin/events");
          socket = current;
          let currentPing;
          current.onopen = () => {
            if (socket !== current || stopped) return;
            current.send(JSON.stringify({ secret: settings.serverSecret }));
            void relay("connected").catch(() => {});
            currentPing = setInterval(() => {
              if (current.readyState === 1) current.send(JSON.stringify({ type: "keepalive" }));
            }, 20_000);
            ping = currentPing;
          };
          current.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === "pending" && Array.isArray(message.requests))
                void update(message.requests).catch(() => {});
            } catch {
              current.close();
            }
          };
          current.onclose = () => {
            clearInterval(currentPing);
            if (socket !== current) return;
            socket = undefined;
            if (!stopped) void relay("disconnected").catch(() => {});
          };
          current.onerror = () => current.close();
        } catch {
          await relay("disconnected");
        }
      });
    return connections;
  }
  async function start() {
    await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    await connect();
    await poll().catch(() => {});
  }
  chrome.permissions.onAdded.addListener(start);
  chrome.permissions.onRemoved.addListener(start);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === alarmName) return Promise.all([connect(), poll().catch(() => {})]);
  });
  chrome.notifications.onButtonClicked.addListener((id, button) => {
    if (!id.startsWith("signin:")) return;
    if (button === 0) return review(id.slice(7));
    if (button === 1) return deny(id.slice(7)).catch(() => {});
  });
  chrome.notifications.onClicked.addListener((id) => {
    if (id.startsWith("signin:")) return review(id.slice(7));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "session" && changes.signinRelay) || (area === "local" && changes.lastResults))
      return badge().catch(() => {});
    if (area !== "local" || (!changes.serverUrl && !changes.serverSecret)) return;
    socket?.close();
    socket = undefined;
    void start().catch(() => {});
  });
  void start().catch(() => {});
  return {
    start,
    poll,
    update,
    refreshBadge: badge,
    get pending() {
      return pending;
    },
    get relayDisconnected() {
      return relayState?.status === "disconnected";
    },
    stop() {
      stopped = true;
      clearInterval(ping);
      socket?.close();
    },
  };
}
