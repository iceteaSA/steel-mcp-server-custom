import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = process.argv[2];
if (!scratch?.startsWith("/tmp/opencode/"))
  throw new Error("Supply a scratch directory under /tmp/opencode/.");
const { startRelayServer } = createRequire(import.meta.url)(path.join(scratch, "relay.cjs"));
const secret = randomUUID();
const run = await fs.mkdtemp(path.join(scratch, "browser-run-"));
const relay = startRelayServer({
  port: 3921,
  bindAddr: "127.0.0.1",
  secret,
  profilesDir: path.join(run, "profiles"),
  credentialsFile: path.join(run, "credentials.json"),
});
await new Promise((resolve, reject) => {
  relay.once("listening", resolve);
  relay.once("error", reject);
});
const fixture = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Set-Cookie", [
    "fixture_session=fixture-cookie-value; Path=/; HttpOnly; SameSite=Lax",
    "fixture_path=fixture-path-value; Path=/account; SameSite=Lax",
    ...(req.headers.host?.startsWith("app.fixture.test")
      ? ["fixture_parent=fixture-parent-value; Domain=.fixture.test; Path=/; SameSite=Lax"]
      : []),
  ]);
  res.end(
    '<!doctype html><title>Fixture sign-in</title><h1>Fixture site</h1><script>localStorage.setItem("fixture_token", "fixture-storage-value");localStorage.setItem("fixture_theme", "fixture-theme-value");</script>',
  );
});
await new Promise((resolve) => fixture.listen(3922, "127.0.0.1", resolve));
let context;
const errors = [];
try {
  await fs.mkdir(path.join(scratch, "screens"), { recursive: true });
  await fs.rm(path.join(scratch, "profile"), { recursive: true, force: true });
  await fs.rm(path.join(scratch, "parent-profile"), { recursive: true, force: true });
  const extension = path.join(scratch, "test-extension");
  await fs.cp(path.join(root, "extension"), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
  manifest.host_permissions = [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "http://app.fixture.test/*",
  ];
  await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  const browserOptions = {
    executablePath: "/home/icetea/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    headless: false,
    args: [
      "--headless=new",
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      "--no-sandbox",
      "--host-resolver-rules=MAP *.fixture.test 127.0.0.1",
    ],
  };
  context = await chromium.launchPersistentContext(path.join(scratch, "profile"), browserOptions);
  context.on("page", (page) => page.on("pageerror", () => errors.push("extension page error")));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.alarms.clearAll();
  });
  await context.clearCookies();
  const site = await context.newPage();
  await site.goto("http://127.0.0.1:3922");
  await site.evaluate(() => localStorage.clear());
  await site.reload();
  const options = await context.newPage();
  await options.setViewportSize({ width: 800, height: 1000 });
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator("#serverUrl").fill("http://127.0.0.1:3921");
  await options.locator("#serverSecret").fill(secret);
  assert.equal(await options.locator("#serverUrl").inputValue(), "http://127.0.0.1:3921");
  await options.getByRole("button", { name: "Save settings and grant relay access" }).click();
  try {
    await options
      .locator("#status")
      .filter({ hasText: "Settings saved" })
      .waitFor({ timeout: 15000 });
  } catch {
    console.error("Options status:", await options.locator("#status").innerText());
    console.error("Page error count:", errors.length);
    await options.screenshot({
      path: path.join(scratch, "screens/options-failure.png"),
      fullPage: true,
    });
    throw new Error("Options save failed before relay connection test");
  }
  assert.equal(
    await worker.evaluate(async () => (await chrome.storage.local.get("serverUrl")).serverUrl),
    "http://127.0.0.1:3921",
  );
  await options.locator("#testConnection").click();
  try {
    await options.locator("#status").filter({ hasText: "Secret accepted" }).waitFor();
  } catch {
    console.error("Connection-test status:", await options.locator("#status").innerText());
    console.error("Connection-test URL:", await options.locator("#serverUrl").inputValue());
    throw new Error("Authenticated fixture connection test failed");
  }
  assert.equal(await options.locator("#serverSecret").getAttribute("type"), "password");
  assert.equal(await options.locator("#syncEnabled").isChecked(), false);
  await options.locator("#serverSecret").fill("wrong-fixture-secret");
  await options.locator("#testConnection").click();
  await options.locator("#status").filter({ hasText: "Secret rejected" }).waitFor();
  await options.locator("#serverSecret").fill(secret);
  await options.locator("#testConnection").click();
  await options.locator("#status").filter({ hasText: "Secret accepted" }).waitFor();
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 850 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator("#connection").filter({ hasText: "secret accepted" }).waitFor();
  await popup.locator("#currentDomain").filter({ hasText: "127.0.0.1" }).waitFor();
  if (await popup.locator("#grantSite").isVisible()) await popup.locator("#grantSite").click();
  await popup.locator("#siteCounts").filter({ hasText: "2 cookies · 2 storage keys" }).waitFor();
  await popup.locator("#profileName").fill("fixture");
  await popup.locator("#pushBtn").click();
  await popup.locator("#status").filter({ hasText: "Transfer complete" }).waitFor();
  await popup.locator("#summaryPanel").evaluate((element) => {
    element.open = true;
  });
  await popup
    .locator("#profileDomains")
    .filter({ hasText: "127.0.0.1 · 2 cookies · 2 storage keys" })
    .waitFor();
  const response = await fetch("http://127.0.0.1:3921/profiles/fixture", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const summary = await response.json();
  assert.deepEqual(summary, {
    name: "fixture",
    domains: [{ domain: "127.0.0.1", cookieCount: 2, storageKeyCount: 2 }],
  });
  const body = await popup.locator("body").innerText();
  assert.equal(/fixture-(cookie|storage|path|theme)-value/.test(body), false);
  await popup.screenshot({ path: path.join(scratch, "screens/popup.png"), fullPage: true });
  await options.screenshot({ path: path.join(scratch, "screens/options.png"), fullPage: true });

  const secondSite = await context.newPage();
  await secondSite.goto("http://localhost:3922");
  await secondSite.evaluate(() => localStorage.clear());
  await secondSite.reload();
  await popup.reload();
  await popup.locator("#connection").filter({ hasText: "secret accepted" }).waitFor();
  await popup.locator("#batchPanel").evaluate((element) => {
    element.open = true;
  });
  await popup.locator("#siteSearch").fill("localhost");
  assert.equal(await popup.locator("#siteList input").count(), 1);
  await popup.locator("#siteList input").check();
  await popup.locator("#siteSearch").fill("127.0.0.1");
  assert.equal(await popup.locator("#siteList input").count(), 1);
  await popup.locator("#siteList input").check();
  await popup.locator("#pushSelected").filter({ hasText: "(2)" }).click();
  await popup.locator("#status").filter({ hasText: "Transfer complete" }).waitFor();
  assert.equal(await popup.locator("#results li").count(), 2);
  const batchSummary = await (
    await fetch("http://127.0.0.1:3921/profiles/fixture", {
      headers: { Authorization: `Bearer ${secret}` },
    })
  ).json();
  assert.deepEqual(
    batchSummary.domains.map((entry) => ({
      domain: entry.domain,
      cookies: entry.cookieCount,
      storage: entry.storageKeyCount,
    })),
    [
      { domain: "127.0.0.1", cookies: 2, storage: 2 },
      { domain: "localhost", cookies: 2, storage: 2 },
    ],
  );
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "OK");
  await popup.locator("#pinSite").click();
  await popup.locator("#status").filter({ hasText: "Pinned" }).waitFor();
  await options.reload();
  await options.locator("#pins").filter({ hasText: "fixture" }).waitFor();
  await options.locator("#syncEnabled").check();
  await options.getByRole("button", { name: "Save settings and grant relay access" }).click();
  await options.locator("#status").filter({ hasText: "Settings saved" }).waitFor();
  assert.equal(
    (await worker.evaluate(() => chrome.alarms.get("steel-pinned-sync"))).periodInMinutes,
    30,
  );
  await options.locator("#pins").getByRole("button", { name: "Unpin", exact: false }).click();
  await options.locator("#pins").filter({ hasText: "No pinned sites" }).waitFor();
  await options.getByRole("button", { name: "Save settings and grant relay access" }).click();
  await options.locator("#status").filter({ hasText: "Settings saved" }).waitFor();
  assert.equal(await worker.evaluate(() => chrome.alarms.get("steel-pinned-sync")), undefined);

  await popup.locator("#summaryPanel").evaluate((element) => {
    element.open = true;
  });
  await popup.locator("#refreshSummary").click();
  popup.once("dialog", (dialog) => dialog.accept());
  await popup.getByRole("button", { name: "Remove localhost from fixture", exact: true }).click();
  await popup.locator("#status").filter({ hasText: "Removed localhost" }).waitFor();
  const afterDelete = await (
    await fetch("http://127.0.0.1:3921/profiles/fixture", {
      headers: { Authorization: `Bearer ${secret}` },
    })
  ).json();
  assert.deepEqual(
    afterDelete.domains.map((entry) => entry.domain),
    ["127.0.0.1"],
  );
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.screenshot({ path: path.join(scratch, "screens/popup-dark.png"), fullPage: true });
  await options.emulateMedia({ colorScheme: "dark" });
  await options.screenshot({
    path: path.join(scratch, "screens/options-dark.png"),
    fullPage: true,
  });
  const childSite = await context.newPage();
  await childSite.goto("http://app.fixture.test:3922");
  await childSite.evaluate(() => localStorage.clear());
  await childSite.reload();
  await popup.reload();
  await popup.locator("#currentDomain").filter({ hasText: "app.fixture.test" }).waitFor();
  await popup.locator("#siteCounts").filter({ hasText: "2 cookies · 2 storage keys" }).waitFor();
  await popup.locator("#parentPanel").evaluate((element) => {
    element.open = true;
  });
  assert.equal(await popup.locator("#parentDomain").inputValue(), "fixture.test");
  assert.equal(await popup.locator("#grantParent").isEnabled(), true);
  await popup.screenshot({
    path: path.join(scratch, "screens/parent-access-needed.png"),
    fullPage: true,
  });
  await worker.evaluate(() => chrome.storage.local.clear());
  await context.close();
  manifest.host_permissions.push("*://fixture.test/*");
  await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(
    path.join(scratch, "parent-profile"),
    browserOptions,
  );
  context.on("page", (page) => page.on("pageerror", () => errors.push("extension page error")));
  const parentWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const parentId = new URL(parentWorker.url()).hostname;
  await parentWorker.evaluate(
    async (settings) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(settings);
    },
    { serverUrl: "http://127.0.0.1:3921", serverSecret: secret, profileName: "parent-fixture" },
  );
  await context.clearCookies();
  const parentSite = await context.newPage();
  await parentSite.goto("http://app.fixture.test:3922");
  const parentPopup = await context.newPage();
  await parentPopup.setViewportSize({ width: 440, height: 850 });
  await parentPopup.goto(`chrome-extension://${parentId}/popup.html`);
  await parentPopup
    .locator("#siteCounts")
    .filter({ hasText: "3 cookies · 2 storage keys" })
    .waitFor();
  await parentPopup.locator("#pushBtn").click();
  await parentPopup.locator("#status").filter({ hasText: "Transfer complete" }).waitFor();
  const parentSummary = await (
    await fetch("http://127.0.0.1:3921/profiles/parent-fixture", {
      headers: { Authorization: `Bearer ${secret}` },
    })
  ).json();
  assert.deepEqual(parentSummary.domains, [
    { domain: "app.fixture.test", cookieCount: 2, storageKeyCount: 2 },
    { domain: "fixture.test", cookieCount: 1, storageKeyCount: 0 },
  ]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: test-only local-fixture grants; extension loads; auth rejection and recovery; fixture push; count-only summary; two-site searchable batch; badge; pin/unpin and alarms; confirmed domain removal; parent-cookie access boundary and transfer; no values in UI; default sync off; light/dark screenshots.",
  );
} finally {
  for (const worker of context?.serviceWorkers() ?? [])
    await worker.evaluate(() => chrome.storage.local.clear()).catch(() => {});
  await context?.close();
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => relay.close(resolve));
  await fs.rm(run, { recursive: true, force: true });
  for (const directory of ["profile", "parent-profile", "test-extension"]) {
    await fs.rm(path.join(scratch, directory), { recursive: true, force: true });
  }
}
