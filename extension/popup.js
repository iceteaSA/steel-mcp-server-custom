// Steel Cookie Push — popup logic

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const DEFAULTS = {
  serverUrl: "http://localhost:3001",
  serverSecret: "",
  profileName: "vivaldi",
};

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (items) => resolve(items));
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, resolve);
  });
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/** Get all cookies for a specific domain (and its subdomains). */
function getCookiesForDomain(domain) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain }, (cookies) => resolve(cookies || []));
  });
}

/** Get ALL cookies from the browser. */
function getAllCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({}, (cookies) => resolve(cookies || []));
  });
}

/** Convert chrome.cookies format → relay format. */
function convertCookie(c) {
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  };
  // expirationDate is epoch seconds; session cookies have no expirationDate
  if (c.expirationDate) {
    cookie.expires = c.expirationDate;
  }
  if (c.httpOnly) cookie.httpOnly = true;
  if (c.secure) cookie.secure = true;
  if (c.sameSite && c.sameSite !== "unspecified") {
    // Chrome uses lowercase; Playwright wants Title Case
    cookie.sameSite = c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1);
  }
  return cookie;
}

// ---------------------------------------------------------------------------
// localStorage extraction via scripting API
// ---------------------------------------------------------------------------

async function getLocalStorage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const entries = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) entries[key] = localStorage.getItem(key) ?? "";
        }
        return { origin: location.origin, entries };
      },
    });
    if (results && results[0] && results[0].result) {
      const { origin, entries } = results[0].result;
      if (Object.keys(entries).length > 0) {
        return { [origin]: entries };
      }
    }
  } catch (err) {
    console.warn("Failed to extract localStorage:", err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Push to relay
// ---------------------------------------------------------------------------

async function pushToRelay(payload, serverUrl, secret) {
  const url = serverUrl.replace(/\/$/, "") + "/push";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function testConnection(serverUrl) {
  const url = serverUrl.replace(/\/$/, "") + "/status";
  const res = await fetch(url);
  return res.json();
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus(msg, type) {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${type}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await loadSettings();

  // Populate settings fields
  $("serverUrl").value = settings.serverUrl;
  $("serverSecret").value = settings.serverSecret;
  $("profileName").value = settings.profileName;

  // Get current tab info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    $("currentDomain").textContent = "No active tab";
    return;
  }

  let domain;
  try {
    const u = new URL(tab.url);
    domain = u.hostname;
  } catch {
    $("currentDomain").textContent = "Invalid URL";
    return;
  }

  $("currentDomain").textContent = domain;

  // Count cookies for this domain
  const domainCookies = await getCookiesForDomain(domain);
  $("cookieCount").textContent = `${domainCookies.length} cookie(s)`;

  // Enable push button if server is configured
  if (settings.serverSecret) {
    $("pushBtn").disabled = false;
  }

  // Auto-set credential name to domain
  $("credName").value = domain.replace(/^www\./, "");

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  // Toggle credentials section
  $("includeCredentials").addEventListener("change", (e) => {
    $("credentialFields").style.display = e.target.checked ? "block" : "none";
  });

  // Toggle settings
  $("settingsToggle").addEventListener("click", () => {
    $("settingsPanel").classList.toggle("visible");
  });

  // Save settings
  $("saveSettings").addEventListener("click", async () => {
    const newSettings = {
      serverUrl: $("serverUrl").value.trim() || DEFAULTS.serverUrl,
      serverSecret: $("serverSecret").value.trim(),
      profileName: $("profileName").value.trim() || DEFAULTS.profileName,
    };
    await saveSettings(newSettings);
    $("pushBtn").disabled = !newSettings.serverSecret;
    showStatus("Settings saved", "success");
  });

  // Test connection
  $("testConnection").addEventListener("click", async () => {
    try {
      const url = $("serverUrl").value.trim() || DEFAULTS.serverUrl;
      const data = await testConnection(url);
      showStatus(`Connected: ${data.server} v${data.version}`, "success");
    } catch (err) {
      showStatus(`Connection failed: ${err.message}`, "error");
    }
  });

  // PUSH button
  $("pushBtn").addEventListener("click", async () => {
    const btn = $("pushBtn");
    btn.disabled = true;
    btn.textContent = "Pushing...";

    try {
      const currentSettings = await loadSettings();
      const profileName = $("profileName").value.trim() || currentSettings.profileName;

      // Save profile name for next time
      await saveSettings({ ...currentSettings, profileName });

      // Collect cookies
      const allCookies = $("includeAllCookies").checked;
      const rawCookies = allCookies
        ? await getAllCookies()
        : await getCookiesForDomain(domain);
      const cookies = rawCookies.map(convertCookie);

      // Collect localStorage
      let localStorage = null;
      if ($("includeLocalStorage").checked) {
        localStorage = await getLocalStorage(tab.id);
      }

      // Collect credentials
      let credentials = null;
      if ($("includeCredentials").checked) {
        const name = $("credName").value.trim();
        const username = $("credUsername").value.trim();
        const password = $("credPassword").value;
        if (name && username && password) {
          credentials = { name, url: domain, username, password };
        }
      }

      // Build payload
      const payload = { profile: profileName };
      if (cookies.length > 0) payload.cookies = cookies;
      if (localStorage) payload.localStorage = localStorage;
      if (credentials) payload.credentials = credentials;

      // Send
      const result = await pushToRelay(
        payload,
        currentSettings.serverUrl,
        currentSettings.serverSecret
      );

      showStatus(result.message, "success");
    } catch (err) {
      showStatus(`Push failed: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Push to Steel";
    }
  });
});
