import {
  getSettings,
  siteUrl,
  hostPattern,
  validProfile,
  relayRequest,
  normalizeDomain,
  cookiesForSite,
  convertCookie,
  currentTab,
  readStorage,
  parentDomains,
  domainPatterns,
  revokeDiscoveryAccess,
  DISCOVERY_ORIGINS,
} from "./core.js";
import { startSigninWorker } from "./signin-worker.js";

let running = false;
const ALARM = "steel-pinned-sync";
// A worker restart clears local state. The session record keeps the deadline.
const DISCOVERY_ALARM = "steel-discovery-deadline";
const DISCOVERY_LIMIT = 60000;
let discovering = false;

async function finishDiscovery() {
  await revokeDiscoveryAccess();
  await chrome.storage.session.remove("discoveryRun");
  await chrome.alarms.clear(DISCOVERY_ALARM);
}

async function recoverDiscovery() {
  const { discoveryRun } = await chrome.storage.session.get("discoveryRun");
  const startedAt = discoveryRun?.startedAt;
  if (
    Number.isFinite(startedAt) &&
    startedAt <= Date.now() &&
    Date.now() < startedAt + DISCOVERY_LIMIT
  ) {
    await chrome.alarms.create(DISCOVERY_ALARM, { when: startedAt + DISCOVERY_LIMIT });
    return;
  }
  if (!discovering) await finishDiscovery();
}

async function beginDiscovery() {
  const startedAt = Date.now();
  await chrome.storage.session.set({ discoveryRun: { startedAt } });
  await chrome.alarms.create(DISCOVERY_ALARM, { when: startedAt + DISCOVERY_LIMIT });
}

async function configureAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM);
  if (settings.syncEnabled && settings.pinnedSites.length) {
    await chrome.alarms.create(ALARM, {
      periodInMinutes: Math.max(5, Number(settings.syncMinutes) || 30),
    });
  }
}

async function initialize() {
  await recoverDiscovery();
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "steel-push",
    title: "Push this site to Steel",
    contexts: ["page"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
  await configureAlarm();
  await signinWorker?.start();
}

async function setResults(results) {
  const failed = results.some((result) => !result.ok);
  const warning = results.some((result) => result.warning);
  await chrome.storage.local.set({ lastResults: results, lastSync: new Date().toISOString() });
  await chrome.action.setBadgeText({
    text: signinWorker?.pending.length
      ? String(signinWorker.pending.length)
      : failed
        ? "ERR"
        : warning
          ? "!"
          : "OK",
  });
  await chrome.action.setBadgeBackgroundColor({
    color: failed ? "#b42318" : warning ? "#805500" : "#167044",
  });
  await chrome.action.setTitle({
    title: failed
      ? "Steel: push failed. Open for recovery steps."
      : warning
        ? "Steel: cookies pushed; storage incomplete."
        : "Steel: last push completed",
  });
}

async function pushSites(sites, profile, includeStorage, previousResults = []) {
  if (running)
    throw new Error("A push is in progress. Wait for its results before starting another.");
  if (!Array.isArray(sites) || !sites.length || sites.length > 100)
    throw new Error("Select between 1 and 100 sites.");
  validProfile(profile);
  running = true;
  const results = [...previousResults];
  try {
    const settings = await getSettings();
    for (const item of sites) {
      let domain = "Site";
      try {
        const url = siteUrl(item.url);
        domain = url.hostname;
        if (!(await chrome.permissions.contains({ origins: [hostPattern(url.href)] }))) {
          throw new Error(
            "Site access missing. Open this site and choose Grant site access before pushing.",
          );
        }
        const rawCookies = await cookiesForSite(url.href);
        if (rawCookies.some((cookie) => cookie.partitionKey)) {
          throw new Error(
            "Partitioned cookies cannot be restored by this relay. Use a direct sign-in in Steel for this site.",
          );
        }
        let storage = { available: false, keyCount: 0 };
        if (includeStorage) {
          const tabs = await chrome.tabs.query({});
          const tab =
            tabs.find(
              (candidate) =>
                candidate.id === item.tabId && candidate.url?.startsWith(url.origin + "/"),
            ) ?? tabs.find((candidate) => candidate.url?.startsWith(url.origin + "/"));
          storage = await readStorage(tab?.id, url.origin);
        }
        if (!rawCookies.length && !storage.keyCount) {
          throw new Error(
            "No sign-in data found. Sign in on this site, grant access, and keep its tab open for storage.",
          );
        }
        const payload = { profile, cookies: rawCookies.map(convertCookie) };
        if (storage.available) payload.localStorage = { [url.origin]: storage.entries };
        await relayRequest("/push", { method: "POST", body: payload, settings });
        results.push({
          domain,
          profile,
          ok: true,
          cookieCount: rawCookies.length,
          storageKeyCount: storage.keyCount,
          warning:
            includeStorage && !storage.available
              ? "Cookies pushed. Storage unavailable: keep this origin open and retry."
              : "",
        });
      } catch (error) {
        results.push({ domain, profile, ok: false, error: error.message });
      }
      await setResults([...results]);
    }
    return results;
  } finally {
    running = false;
  }
}

async function pushTab(tab) {
  try {
    if (!tab?.url) throw new Error("Open a site and grant its access in the popup first.");
    const settings = await getSettings();
    await pushSites(
      [{ url: tab.url, tabId: tab.id }],
      settings.profileName,
      settings.includeStorage,
    );
  } catch (error) {
    await setResults([{ domain: "Current site", ok: false, error: error.message }]);
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case "signin-pending":
      return relayRequest("/signin");
    case "signin-deny":
      return relayRequest(`/signin/${encodeURIComponent(message.id)}/deny`, {
        method: "POST",
        body: { note: message.note ?? "" },
      });
    case "prepare-discovery":
      if (discovering) throw new Error("Discovery is already running. Wait for it to finish.");
      await beginDiscovery();
      return true;
    case "recover-discovery":
      await recoverDiscovery();
      return true;
    case "end-discovery":
      if (!discovering) await finishDiscovery();
      return true;
    case "discover":
      if (discovering) throw new Error("Discovery is already running. Wait for it to finish.");
      discovering = true;
      try {
        await beginDiscovery();
        const domains = await handleMessage({ type: "sites" });
        await chrome.storage.session.set({ discoveredSites: domains });
        return domains;
      } finally {
        discovering = false;
        await finishDiscovery();
      }
    case "site-list": {
      const current = await handleMessage({ type: "sites" });
      const { discoveredSites = [] } = await chrome.storage.session.get("discoveredSites");
      const merged = new Map(discoveredSites.map((entry) => [entry.domain, entry]));
      for (const entry of current) merged.set(entry.domain, entry);
      return [...merged.values()].sort((a, b) => a.domain.localeCompare(b.domain));
    }
    case "profiles":
      return relayRequest("/profiles");
    case "summary":
      return relayRequest(`/profiles/${encodeURIComponent(validProfile(message.profile))}`);
    case "remove": {
      if (!/^[a-zA-Z0-9.-]{1,253}$/.test(message.domain))
        throw new Error("Select a domain from the profile summary.");
      return relayRequest(
        `/profiles/${encodeURIComponent(validProfile(message.profile))}/domains/${encodeURIComponent(message.domain)}`,
        { method: "DELETE" },
      );
    }
    case "site": {
      const tab = await currentTab(message.tabId);
      if (!tab?.url) return null;
      const url = siteUrl(tab.url);
      const granted = await chrome.permissions.contains({ origins: [hostPattern(url.href)] });
      const storage = granted
        ? await readStorage(tab.id, url.origin, true)
        : { available: false, keyCount: 0 };
      return {
        domain: url.hostname,
        url: url.origin,
        tabId: tab.id,
        granted,
        cookieCount: granted ? (await cookiesForSite(url.href)).length : null,
        storageKeyCount: storage.available ? storage.keyCount : null,
        parents: await Promise.all(
          parentDomains(url.hostname).map(async (domain) => ({
            domain,
            granted: await chrome.permissions.contains({ origins: domainPatterns(domain) }),
          })),
        ),
      };
    }
    case "sites": {
      const cookies = await chrome.cookies.getAll({});
      const domains = new Map();
      for (const cookie of cookies) {
        const domain = normalizeDomain(cookie.domain);
        const entry = domains.get(domain) ?? {
          domain,
          cookieCount: 0,
          url: `${cookie.secure ? "https" : "http"}://${domain}`,
        };
        entry.cookieCount++;
        if (cookie.secure) entry.url = `https://${domain}`;
        domains.set(domain, entry);
      }
      const tabs = await chrome.tabs.query({});
      for (const entry of domains.values()) {
        const tab = tabs.find((candidate) => {
          try {
            return siteUrl(candidate.url).hostname === entry.domain;
          } catch {
            return false;
          }
        });
        if (tab) {
          entry.url = siteUrl(tab.url).origin;
          entry.tabId = tab.id;
        }
      }
      return [...domains.values()].sort((a, b) => a.domain.localeCompare(b.domain));
    }
    case "push":
      return pushSites(message.sites, message.profile, message.includeStorage);
    case "alarm":
      await configureAlarm();
      await signinWorker?.start();
      return true;
    default:
      throw new Error("Unknown extension action. Reload the extension.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  discoveryReady
    .then(() => handleMessage(message))
    .then(
      (data) => respond({ ok: true, data }),
      (error) => respond({ ok: false, error: error.message }),
    );
  return true;
});
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "steel-push") return pushTab(tab);
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "push-site") return currentTab().then(pushTab);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DISCOVERY_ALARM) {
    if (discovering) return;
    return recoverDiscovery();
  }
  if (alarm.name !== ALARM) return;
  return getSettings()
    .then(async (settings) => {
      if (!settings.syncEnabled || running) return;
      let results = [];
      for (const pin of settings.pinnedSites) {
        results = await pushSites([pin], pin.profile, pin.includeStorage, results);
      }
    })
    .catch(() =>
      setResults([
        {
          domain: "Pinned sites",
          ok: false,
          error: "Pinned sync failed. Check Settings and site access.",
        },
      ]),
    );
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.syncEnabled || changes.syncMinutes || changes.pinnedSites))
    void configureAlarm();
});
chrome.permissions.onAdded.addListener(async (permissions) => {
  if (
    !permissions.origins?.some((origin) =>
      [...DISCOVERY_ORIGINS, "*://*/*", "<all_urls>"].includes(origin),
    )
  )
    return;
  await discoveryReady;
  const { discoveryRun } = await chrome.storage.session.get("discoveryRun");
  const when = Number.isFinite(discoveryRun?.startedAt)
    ? discoveryRun.startedAt + DISCOVERY_LIMIT
    : Date.now() + DISCOVERY_LIMIT;
  await chrome.alarms.create(DISCOVERY_ALARM, { when });
});

export const discoveryReady = recoverDiscovery().catch(async () => {
  await chrome.alarms.create(DISCOVERY_ALARM, { when: Date.now() + DISCOVERY_LIMIT });
});

const signinWorker = chrome.notifications ? startSigninWorker() : null;
