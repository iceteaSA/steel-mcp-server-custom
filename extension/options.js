import {
  getSettings,
  relayUrl,
  hostPattern,
  relayRequest,
  requestAccess,
  DISCOVERY_ORIGINS,
  send,
} from "./core.js";
const $ = (id) => document.getElementById(id);
function status(text, error = false) {
  $("status").textContent = text;
  $("status").className = `notice ${error ? "error" : "success"}`;
}
function fields() {
  return {
    serverUrl: relayUrl($("serverUrl").value.trim()),
    serverSecret: $("serverSecret").value.trim(),
    syncEnabled: $("syncEnabled").checked,
    syncMinutes: Number($("syncMinutes").value),
  };
}
async function grant(settings) {
  const allowed = await requestAccess([hostPattern(settings.serverUrl)]);
  if (!allowed) throw new Error("Relay access denied. Save again and grant access to connect.");
}
async function renderPins() {
  const settings = await getSettings();
  $("pins").replaceChildren();
  if (!settings.pinnedSites.length) {
    const li = document.createElement("li");
    li.textContent = "No pinned sites. Pin a site from the transfer panel.";
    $("pins").append(li);
  }
  for (const pin of settings.pinnedSites) {
    const li = document.createElement("li");
    li.className = "profile-domain";
    const text = document.createElement("span");
    text.textContent = `${pin.domain} → ${pin.profile}${pin.includeStorage ? " · cookies + open-tab storage" : " · cookies only"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small";
    button.textContent = "Unpin";
    button.setAttribute("aria-label", `Unpin ${pin.domain} from ${pin.profile}`);
    button.addEventListener("click", async () => {
      const current = await getSettings();
      await chrome.storage.local.set({
        pinnedSites: current.pinnedSites.filter(
          (entry) => !(entry.url === pin.url && entry.profile === pin.profile),
        ),
      });
      await renderPins();
      status("Site unpinned. Its saved profile data remains unchanged.");
    });
    li.append(text, button);
    $("pins").append(li);
  }
}
$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const settings = fields();
    if (!settings.serverSecret) throw new Error("Enter the relay secret before saving.");
    if (
      !Number.isInteger(settings.syncMinutes) ||
      settings.syncMinutes < 5 ||
      settings.syncMinutes > 1440
    )
      throw new Error("Choose a whole-number interval from 5 to 1440 minutes.");
    await grant(settings);
    await chrome.storage.local.set(settings);
    await send("alarm");
    status("Settings saved. Test the connection before pushing sign-ins.");
  } catch (error) {
    status(error.message, true);
  }
});
$("testConnection").addEventListener("click", async () => {
  $("testConnection").disabled = true;
  try {
    const settings = fields();
    await grant(settings);
    const result = await relayRequest("/profiles", { settings });
    status(`✓ Connected. Secret accepted. ${result.profiles.length} saved profiles.`);
  } catch (error) {
    status(error.message, true);
  } finally {
    $("testConnection").disabled = false;
  }
});
function renderDiscovery(domains) {
  $("discoveredDomains").replaceChildren();
  for (const entry of domains) {
    const li = document.createElement("li");
    li.textContent = `${entry.domain} · ${entry.cookieCount} cookies`;
    $("discoveredDomains").append(li);
  }
}
$("discoverSites").addEventListener("click", async () => {
  $("discoverSites").disabled = true;
  try {
    await send("prepare-discovery");
    if (!(await requestAccess(DISCOVERY_ORIGINS)))
      throw new Error("Discovery access denied. The extension sent no sign-in data.");
    renderDiscovery(await send("discover"));
    status("Discovery complete. Broad access removed. Go to the popup and select sites.");
  } catch (error) {
    status(error.message, true);
  } finally {
    try {
      await send("end-discovery");
    } catch (error) {
      status(error.message, true);
    }
    $("discoverSites").disabled = false;
  }
});
async function init() {
  const settings = await getSettings();
  $("serverUrl").value = settings.serverUrl;
  $("serverSecret").value = settings.serverSecret;
  $("syncEnabled").checked = settings.syncEnabled;
  $("syncMinutes").value = settings.syncMinutes;
  await renderPins();
  await send("recover-discovery");
  const { discoveredSites = [] } = await chrome.storage.session.get("discoveredSites");
  renderDiscovery(discoveredSites);
}
void init().catch(() =>
  status("Settings could not load. Reload the extension and try again.", true),
);
