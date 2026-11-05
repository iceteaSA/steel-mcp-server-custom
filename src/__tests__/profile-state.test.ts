import { afterEach, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "patchright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../manager.js";
import { EnvSchema } from "../env.js";
import { encryptJSON } from "../crypto.js";
import {
  mergeProfileData,
  httpOrigin,
  storageSchema,
  readProfileData,
  withProfileWrite,
  writeProfileData,
} from "../profile-store.js";
import { chromiumPath } from "./browser-processes.js";

let browser: Browser;
let context: BrowserContext;
let manager: BrowserManager;
let directory: string;
let site: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "profile-state-"));
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<body>profile</body>", { headers: { "Content-Type": "text/html" } }),
  });
  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  });
  const operator = await browser.newContext();
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: "off",
    OUTPUT_DIR: directory,
    PROFILES_DIR: directory,
    RELAY_PORT: "0",
  });
  manager = new BrowserManager(env);
  manager.initialize = async () => {
    Object.assign(manager, { browser, browserContext: operator });
  };
  await manager.createProfile("state");
  context = browser.contexts().find((item) => item !== operator)!;
});
afterEach(async () => {
  await browser?.close();
  await site?.stop(true);
  await rm(directory, { recursive: true, force: true });
});

test("profile save excludes inherited about:blank storage keys and restores the HTTP origin", async () => {
  const page = context.pages()[0];
  const origin = site.url.origin;
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem("httpToken", "CANARY_HTTP"));
  const { page: popup } = await manager.newTab(origin, undefined, "state");
  await popup.evaluate(() => {
    location.href = "about:blank";
  });
  await popup.waitForURL("about:blank");
  await popup.evaluate(() => localStorage.setItem("popupToken", "CANARY_POPUP"));
  expect(popup.url()).toBe("about:blank");
  expect(new URL(popup.url()).origin).toBe("null");
  expect(await popup.evaluate(() => localStorage.getItem("httpToken"))).toBe("CANARY_HTTP");
  expect(manager.tabIds).toHaveLength(2);
  await manager.saveProfile("state");
  const saved = await readProfileData(join(directory, "state.json"));
  expect(saved.localStorage).not.toHaveProperty("null");
  expect(saved.localStorage?.[origin]?.httpToken).toBe("CANARY_HTTP");
  for (const key of Object.keys(saved.localStorage ?? {}))
    expect(storageSchema.safeParse({ [key]: {} }).success).toBe(true);
  expect(httpOrigin(origin + "/path")).toBe(origin);
  expect(httpOrigin("https://example.test/path")).toBe("https://example.test");
  for (const url of [
    "about:blank",
    "data:text/html,profile",
    "chrome://settings",
    "chrome-extension://example/page.html",
    "file:///profile.html",
    "blob:https://example.test/id",
  ])
    expect(httpOrigin(url)).toBeUndefined();
  await manager.deleteProfile("state");
  const restored = await manager.createProfile("state", origin);
  expect(restored.restored).toBe(true);
  const restoredPage = await manager.getPage({ tabId: restored.tabId });
  expect(await restoredPage.evaluate(() => localStorage.getItem("httpToken"))).toBe("CANARY_HTTP");
});

test("CHIPS cookies keep partition identity through save, merge, read, and actual Chromium restore", async () => {
  await context.addCookies([
    {
      name: "same-name",
      value: "CANARY_PARTITIONED",
      domain: "third.example",
      path: "/",
      secure: true,
      sameSite: "None",
      partitionKey: "https://top.example",
    },
    {
      name: "same-name",
      value: "CANARY_UNPARTITIONED",
      domain: "third.example",
      path: "/",
      secure: true,
      sameSite: "None",
    },
  ]);
  const actual = await context.cookies();
  expect(actual).toHaveLength(2);
  expect(actual.find((cookie) => cookie.value === "CANARY_PARTITIONED")?.partitionKey).toBe(
    "https://top.example",
  );
  const file = join(directory, "state.json");
  await manager.saveProfile("state");
  const saved = await readProfileData(file);
  expect(saved.cookies).toHaveLength(2);
  const partitioned = saved.cookies!.find((cookie) => cookie.value === "CANARY_PARTITIONED")!;
  expect(partitioned.partitionKey).toBe("https://top.example");
  expect(
    saved.cookies!.find((cookie) => cookie.value === "CANARY_UNPARTITIONED")?.partitionKey,
  ).toBeUndefined();
  const merged = mergeProfileData(saved, {
    cookies: [{ ...partitioned, value: "CANARY_UPDATED" }],
  });
  expect(merged.cookies).toHaveLength(2);
  await withProfileWrite(file, () => writeProfileData(file, merged));
  expect((await readProfileData(file)).cookies).toEqual(merged.cookies);
  await manager.deleteProfile("state");
  expect((await manager.createProfile("state")).restored).toBe(true);
  const restored = await manager.getPage();
  const cookies = await restored.context().cookies();
  expect(cookies).toHaveLength(2);
  expect(cookies.find((cookie) => cookie.partitionKey === "https://top.example")?.value).toBe(
    "CANARY_UPDATED",
  );
  expect(cookies.find((cookie) => cookie.partitionKey === undefined)?.value).toBe(
    "CANARY_UNPARTITIONED",
  );
});

test("the strict profile reader preserves partitionKey returned by actual Chromium", async () => {
  await context.addCookies([
    {
      name: "partitioned",
      value: "CANARY_READER",
      domain: "third.example",
      path: "/",
      secure: true,
      sameSite: "None",
      partitionKey: "https://top.example",
    },
  ]);
  const cookies = await context.cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0].partitionKey).toBe("https://top.example");
  const file = join(directory, "state.json");
  await withProfileWrite(file, () => writeProfileData(file, { cookies }));
  expect((await readProfileData(file)).cookies?.[0].partitionKey).toBe("https://top.example");
});

test("underscore cookie domains survive actual Chromium save and restore", async () => {
  const domains = ["test_host.example.test", "_service.example.test", "service_.example.test"];
  await context.addCookies(domains.map((domain) => ({ name: "session", value: "COOKIE_CANARY", domain, path: "/" })));
  expect((await context.cookies()).map((cookie) => cookie.domain).sort()).toEqual([...domains].sort());
  await manager.saveProfile("state");
  const saved = await readProfileData(join(directory, "state.json"));
  expect(saved.cookies?.map((cookie) => cookie.domain).sort()).toEqual([...domains].sort());
  await manager.deleteProfile("state");
  expect((await manager.createProfile("state")).restored).toBe(true);
  const restored = (await manager.getPage()).context();
  expect((await restored.cookies()).map((cookie) => cookie.domain).sort()).toEqual([...domains].sort());
});

test("compatibility mode still ignores a malformed plaintext restore when encryption is off", async () => {
  await writeFile(join(directory, "broken.json"), '{"cookies": invalid}');
  const restored = await manager.createProfile("broken");
  expect(restored.restored).toBe(false);
  const page = await manager.getPage(restored.tabId);
  expect(await page.context().cookies()).toEqual([]);
});

test("compatibility mode refuses an encrypted restore without a passphrase", async () => {
  const file = join(directory, "locked.json");
  const encrypted = encryptJSON({ cookies: [] }, "test-passphrase");
  await writeFile(file, encrypted);
  const contexts = browser.contexts().length;
  await expect(manager.createProfile("locked")).rejects.toThrow("CREDENTIALS_PASSPHRASE");
  expect(browser.contexts()).toHaveLength(contexts);
  expect(await Bun.file(file).text()).toBe(encrypted);
});
