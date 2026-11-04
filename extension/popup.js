import {
  getSettings,
  validProfile,
  sitePatterns,
  requestAccess,
  DISCOVERY_ORIGINS,
  revokeDiscoveryAccess,
  send,
} from "./core.js";

const $ = (id) => document.getElementById(id);
let site = null;
let sites = [];
const selected = new Set();
let connected = false;
let busy = false;

function status(text, error = false) {
  $("status").textContent = text;
  $("status").className = `notice ${error ? "error" : "success"}`;
}
function destination() {
  return validProfile($("profilePicker").value || $("profileName").value.trim());
}
function updateActions() {
  $("profilePicker").disabled = busy;
  $("profileName").disabled = busy;
  $("includeStorage").disabled = busy;
  $("grantParent").disabled =
    busy ||
    !site?.parents?.some((parent) => parent.domain === $("parentDomain").value && !parent.granted);
  $("pushBtn").disabled = busy || !connected || !site?.granted;
  $("pinSite").disabled = busy || !site?.granted;
  $("pushSelected").disabled = busy || !connected || !selected.size;
  $("pushSelected").textContent = `Push selected sites (${selected.size})`;
  $("newProfileFields").hidden = Boolean($("profilePicker").value);
}
function renderResults(results = []) {
  $("results").replaceChildren();
  for (const result of results) {
    const li = document.createElement("li");
    li.className = result.ok ? (result.warning ? "" : "success") : "error";
    li.textContent = `${result.ok ? (result.warning ? "NOTE" : "✓") : "✗"} ${result.domain}${result.profile ? ` → ${result.profile}` : ""}: ${result.ok ? `${result.cookieCount} cookies · ${result.storageKeyCount} storage keys${result.warning ? `. ${result.warning}` : ""}` : result.error}`;
    $("results").append(li);
  }
}
async function loadResults() {
  const { lastResults, lastSync } = await chrome.storage.local.get(["lastResults", "lastSync"]);
  renderResults(lastResults);
  $("lastSync").textContent = lastSync
    ? `Last transfer: ${new Date(lastSync).toLocaleString()}`
    : "";
}
async function loadSite() {
  site = await send("site");
  $("currentDomain").textContent = site?.domain || "No supported site open";
  $("siteCounts").textContent = site
    ? site.granted
      ? `${site.cookieCount} cookies · ${site.storageKeyCount ?? "unavailable"} storage keys · granted domains only`
      : "Grant site access to count and transfer its sign-in data."
    : "Open an HTTP or HTTPS tab, then reopen this popup.";
  $("grantSite").hidden = !site || site.granted;
  const previousParent = $("parentDomain").value;
  $("parentDomain").replaceChildren();
  $("parentPanel").hidden = !site?.parents?.length;
  for (const parent of site?.parents ?? [])
    $("parentDomain").add(
      new Option(`${parent.domain}${parent.granted ? " (granted)" : ""}`, parent.domain),
    );
  if (site?.parents?.some((parent) => parent.domain === previousParent))
    $("parentDomain").value = previousParent;
  updateActions();
}
async function loadSites() {
  sites = await send("sites");
  const available = new Set(sites.map((entry) => entry.domain));
  for (const domain of selected) if (!available.has(domain)) selected.delete(domain);
  renderSites();
}
function renderSites() {
  $("siteList").replaceChildren();
  const query = $("siteSearch").value.toLowerCase();
  for (const entry of sites.filter((entry) => entry.domain.includes(query))) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(entry.domain);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(entry.domain);
      else selected.delete(entry.domain);
      updateActions();
    });
    label.append(input, document.createTextNode(`${entry.domain} · ${entry.cookieCount} cookies`));
    li.append(label);
    $("siteList").append(li);
  }
  if (!$("siteList").children.length) {
    const li = document.createElement("li");
    li.textContent = "No matching cookie domains. Grant site access or use temporary discovery.";
    $("siteList").append(li);
  }
  updateActions();
}
async function loadProfiles() {
  try {
    const data = await send("profiles");
    const settings = await getSettings();
    const previous = $("profilePicker").value || settings.profileName;
    $("profilePicker").replaceChildren(new Option("Create a new profile", ""));
    for (const profile of data.profiles)
      $("profilePicker").add(new Option(profile.name, profile.name));
    if (data.profiles.some((profile) => profile.name === previous))
      $("profilePicker").value = previous;
    connected = true;
    $("connection").textContent = "✓ Relay connected · secret accepted";
    $("connection").className = "notice success";
  } catch (error) {
    connected = false;
    $("connection").textContent = error.message;
    $("connection").className = "notice error";
  }
  updateActions();
}
async function loadSummary() {
  $("profileDomains").replaceChildren();
  if (!$("profilePicker").value) {
    const li = document.createElement("li");
    li.textContent = "Choose an existing profile to inspect its saved data.";
    $("profileDomains").append(li);
    return;
  }
  const profile = $("profilePicker").value;
  const summary = await send("summary", { profile });
  for (const entry of summary.domains) {
    const li = document.createElement("li");
    li.className = "profile-domain";
    const text = document.createElement("span");
    text.textContent = `${entry.domain} · ${entry.cookieCount} cookies · ${entry.storageKeyCount} storage keys`;
    const remove = document.createElement("button");
    remove.className = "small";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${entry.domain} from ${profile}`);
    remove.addEventListener("click", async () => {
      if (
        !confirm(
          `Remove saved cookies and localStorage for ${entry.domain} from ${profile}? Subdomains and credentials will remain. Active Steel sessions are not changed.`,
        )
      )
        return;
      remove.disabled = true;
      try {
        await send("remove", { profile, domain: entry.domain });
        await loadSummary();
        status(`Removed ${entry.domain} from saved profile ${profile}.`);
      } catch (error) {
        status(error.message, true);
        remove.disabled = false;
      }
    });
    li.append(text, remove);
    $("profileDomains").append(li);
  }
  if (!summary.domains.length) {
    const li = document.createElement("li");
    li.textContent = "This saved profile has no domains.";
    $("profileDomains").append(li);
  }
}
async function push(items) {
  busy = true;
  updateActions();
  status("Transfer in progress. You can close this popup; the worker will continue.");
  try {
    const profile = destination();
    const granted = await requestAccess([
      ...new Set(items.flatMap((item) => sitePatterns(item.url))),
    ]);
    if (!granted)
      throw new Error("Selected-site access was not granted. No sign-in data was sent.");
    await chrome.storage.local.set({
      profileName: profile,
      includeStorage: $("includeStorage").checked,
    });
    const results = await send("push", {
      sites: items,
      profile,
      includeStorage: $("includeStorage").checked,
    });
    renderResults(results);
    status(
      results.some((result) => !result.ok)
        ? "Some sites failed. Follow the steps listed below and retry those sites."
        : results.some((result) => result.warning)
          ? "Transfer complete with storage warnings. Check each result before using the profile."
          : "Transfer complete. Recreate the Steel profile to load its saved data.",
      results.some((result) => !result.ok),
    );
    await loadProfiles();
    await loadSummary();
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    updateActions();
  }
}

$("grantSite").addEventListener("click", async () => {
  try {
    if (!site) return;
    const granted = await requestAccess(sitePatterns(site.url));
    if (!granted)
      throw new Error(
        "Access was not granted. No data was sent. Grant access to enable this site.",
      );
    await loadSite();
    await loadSites();
  } catch (error) {
    status(error.message, true);
  }
});
$("parentDomain").addEventListener("change", updateActions);
$("grantParent").addEventListener("click", async () => {
  try {
    const domain = $("parentDomain").value;
    if (!site?.parents?.some((parent) => parent.domain === domain)) return;
    const granted = await requestAccess([`*://${domain}/*`]);
    if (!granted)
      throw new Error(
        "Parent cookie access was not granted. Counts can omit shared sign-in cookies.",
      );
    await loadSite();
    await loadSites();
    status(`Parent cookie access granted for ${domain}. Check the updated counts before pushing.`);
  } catch (error) {
    status(error.message, true);
  }
});
$("discoverSites").addEventListener("click", async () => {
  $("discoverSites").disabled = true;
  try {
    const granted = await requestAccess(DISCOVERY_ORIGINS);
    if (!granted)
      throw new Error("All-site discovery was not granted. Individual site access still works.");
    sites = await send("discover");
    renderSites();
    await loadSite();
    status(
      "Discovery complete. Temporary all-site access removed. Push requests access only for selected sites.",
    );
  } catch (error) {
    status(error.message, true);
  } finally {
    try {
      await revokeDiscoveryAccess();
    } catch (error) {
      status(error.message, true);
    }
    $("discoverSites").disabled = false;
  }
});
$("profilePicker").addEventListener("change", async () => {
  updateActions();
  try {
    await chrome.storage.local.set({ profileName: destination() });
    await loadSummary();
  } catch (error) {
    status(error.message, true);
  }
});
$("includeStorage").addEventListener("change", () => {
  void chrome.storage.local.set({ includeStorage: $("includeStorage").checked });
});
$("pushBtn").addEventListener("click", () => {
  if (site) void push([site]);
});
$("pushSelected").addEventListener("click", () => {
  void push(sites.filter((entry) => selected.has(entry.domain)));
});
$("siteSearch").addEventListener("input", renderSites);
$("refreshSummary").addEventListener("click", () => {
  void loadSummary().catch((error) => status(error.message, true));
});
$("pinSite").addEventListener("click", async () => {
  try {
    const profile = destination();
    const settings = await getSettings();
    const pin = {
      url: site.url,
      domain: site.domain,
      profile,
      includeStorage: $("includeStorage").checked,
    };
    const pins = settings.pinnedSites.filter(
      (entry) => !(entry.url === pin.url && entry.profile === profile),
    );
    if (pins.length >= 100) throw new Error("Pin limit reached. Remove a pin in Settings first.");
    await chrome.storage.local.set({ pinnedSites: [...pins, pin] });
    status(
      `Pinned ${site.domain} → ${profile}. ${settings.syncEnabled ? "Scheduled sync is enabled." : "Enable scheduled sync in Settings when ready."}`,
    );
  } catch (error) {
    status(error.message, true);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.lastResults || changes.lastSync)) void loadResults();
});

async function init() {
  const settings = await getSettings();
  $("profileName").value = settings.profileName;
  $("includeStorage").checked = settings.includeStorage;
  await Promise.all([loadResults(), loadSite(), loadSites(), loadProfiles()]);
  await loadSummary();
}
void init().catch((error) => status(error.message, true));
