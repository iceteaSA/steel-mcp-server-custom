export const DEFAULTS = {
  serverUrl: "http://localhost:3001",
  serverSecret: "",
  profileName: "vivaldi",
  includeStorage: true,
  pinnedSites: [],
  syncEnabled: false,
  syncMinutes: 30,
};

export const getSettings = () => chrome.storage.local.get(DEFAULTS);

export const DISCOVERY_ORIGINS = ["http://*/*", "https://*/*"];

export async function revokeDiscoveryAccess() {
  await chrome.permissions.remove({ origins: DISCOVERY_ORIGINS });
  for (const origin of DISCOVERY_ORIGINS) {
    if (await chrome.permissions.contains({ origins: [origin] })) {
      throw new Error(
        "Discovery access remains enabled. Remove all-site access in Chrome extension settings.",
      );
    }
  }
}

export async function requestAccess(origins) {
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

export function siteUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Open an HTTP or HTTPS site, then try again.");
  }
  return url;
}

export function relayUrl(value) {
  let url;
  try {
    url = siteUrl(value);
  } catch {
    throw new Error("Enter an HTTP or HTTPS relay URL in Settings.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use only the relay origin, with no path, query, or embedded credentials.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS for a remote relay to protect sign-ins in transit.");
  }
  return url.origin;
}

export function hostPattern(value) {
  const url = siteUrl(value);
  return `${url.protocol}//${url.hostname}/*`;
}

export function sitePatterns(value) {
  const url = siteUrl(value);
  return [`*://${url.hostname}/*`];
}

export function parentDomains(hostname) {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return [];
  const labels = hostname.split(".");
  return labels.slice(1, -1).map((_label, index) => labels.slice(index + 1).join("."));
}

export function validProfile(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error("Use a profile name with 1-64 letters, digits, hyphens, or underscores.");
  }
  return value;
}

export async function relayRequest(route, { method = "GET", body, settings } = {}) {
  settings ??= await getSettings();
  if (!settings.serverSecret) throw new Error("Open Settings and save the relay secret first.");
  const origin = relayUrl(settings.serverUrl);
  if (!(await chrome.permissions.contains({ origins: [hostPattern(origin)] }))) {
    throw new Error("Open Settings and save the relay URL to grant connection access.");
  }
  let response;
  try {
    response = await fetch(origin + route, {
      method,
      headers: {
        Authorization: `Bearer ${settings.serverSecret}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Relay unreachable. Check the URL, HTTPS certificate, and relay process in Settings.",
    );
  }
  if (response.status === 401)
    throw new Error("Secret rejected. Set the matching RELAY_SECRET in Settings.");
  if (response.status === 403)
    throw new Error(
      "Use a loopback Host for the relay. Set a loopback URL or set the trusted proxy upstream Host to loopback.",
    );
  if (response.status === 404)
    throw new Error(
      "Profile or endpoint not found. Refresh profiles; use a relay with profile management support.",
    );
  if (!response.ok)
    throw new Error(
      "Relay rejected the request. Check the profile name, relay files, and server permissions.",
    );
  try {
    return await response.json();
  } catch {
    throw new Error("Invalid relay reply. Check the relay URL and server version.");
  }
}

export function normalizeDomain(domain) {
  return domain.replace(/^\./, "").toLowerCase();
}

export async function cookiesForSite(url) {
  const hostname = siteUrl(url).hostname.toLowerCase();
  const cookies = await chrome.cookies.getAll({});
  return cookies.filter((cookie) => {
    const domain = normalizeDomain(cookie.domain);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

export function convertCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expirationDate ? { expires: cookie.expirationDate } : {}),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite && cookie.sameSite !== "unspecified"
      ? {
          sameSite:
            cookie.sameSite === "no_restriction"
              ? "None"
              : cookie.sameSite[0].toUpperCase() + cookie.sameSite.slice(1),
        }
      : {}),
  };
}

export async function currentTab(tabId) {
  // The popup sends its own active tab ID. In the service worker, "currentWindow" has no window of its own and
  // can resolve to a different browser window.
  const active = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (active?.url?.match(/^https?:/)) return active;
  return null;
}

export async function readStorage(tabId, expectedOrigin, countOnly = false) {
  if (!tabId) return { available: false, keyCount: 0 };
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (origin, counts) => {
        if (location.origin !== origin) return null;
        if (counts) return { keyCount: localStorage.length };
        const entries = Object.create(null);
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key !== null) entries[key] = localStorage.getItem(key) ?? "";
        }
        return { keyCount: localStorage.length, entries };
      },
      args: [expectedOrigin, countOnly],
    });
    if (result?.result) return { available: true, ...result.result };
  } catch {
    /* A tab can close or navigate during a push. */
  }
  return { available: false, keyCount: 0 };
}

export async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension worker unavailable. Reload the extension and try again.",
    );
  return response.data;
}

export function signinPatterns(request) {
  return request.domains.map((domain) => `*://${domain}/*`);
}

async function signinData(request, countOnly) {
  if (request.expires <= Date.now())
    throw new Error("This request expired. Ask for a new request.");
  const granted = [];
  for (const domain of request.domains) {
    if (await chrome.permissions.contains({ origins: [`*://${domain}/*`] })) granted.push(domain);
  }
  const cookies = (await chrome.cookies.getAll({})).filter((cookie) =>
    granted.includes(normalizeDomain(cookie.domain)),
  );
  const requested = siteUrl(
    request.site.includes("://") ? request.site : `https://${request.site}`,
  );
  const host = requested.hostname;
  const tab = (await chrome.tabs.query({})).find((candidate) => {
    try {
      const url = siteUrl(candidate.url);
      return url.hostname === host && url.origin === requested.origin;
    } catch {
      return false;
    }
  });
  const origin = tab ? siteUrl(tab.url).origin : null;
  const storage =
    tab && granted.includes(host)
      ? await readStorage(tab.id, origin, countOnly)
      : { available: false, keyCount: 0 };
  return { cookies, origin, storage };
}

export async function previewSignin(request) {
  const data = await signinData(request, true);
  return {
    cookies: data.cookies.map(({ name, domain }) => ({ name, domain })),
    cookieCount: data.cookies.length,
    storage: data.storage.available
      ? [{ origin: data.origin, keyCount: data.storage.keyCount }]
      : [],
    storageAvailable: data.storage.available,
  };
}

export async function pushSignin(request, remember = false, useGrant = false, note) {
  if (!(await chrome.permissions.contains({ origins: signinPatterns(request) })))
    throw new Error("Request site access was not granted. Open Review.");
  const data = await signinData(request, false);
  if (data.cookies.some((cookie) => cookie.partitionKey))
    throw new Error("Partitioned cookies cannot be restored. Sign in directly in Steel.");
  if (!data.cookies.length && !data.storage.keyCount)
    throw new Error("No sign-in data found. Sign in on this site and keep its tab open.");
  return relayRequest(`/signin/${encodeURIComponent(request.id)}/push`, {
    method: "POST",
    body: {
      profile: validProfile(request.profile),
      cookies: data.cookies.map((cookie) => ({
        ...convertCookie(cookie),
        ...(typeof cookie.hostOnly === "boolean" ? { hostOnly: cookie.hostOnly } : {}),
      })),
      ...(data.storage.available ? { localStorage: { [data.origin]: data.storage.entries } } : {}),
      remember: remember === true,
      ...(useGrant ? { useGrant: true } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  });
}

export function approveSignin(request, remember = false, note) {
  // The Chrome permission API must run in the approval click, before an asynchronous read.
  const permission = chrome.permissions.request({ origins: signinPatterns(request) });
  return Promise.resolve(permission).then((allowed) => {
    if (!allowed) throw new Error("Request site access was not granted. No data was sent.");
    return pushSignin(request, remember, false, note);
  });
}
