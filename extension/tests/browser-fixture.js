import { chromium } from "patchright";
import { chromiumPath } from "../../src/__tests__/browser-processes.js";
import { fileURLToPath } from "node:url";

export async function extensionBrowser() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (!/^\/[a-z-]+\.(html|js|css)$/.test(path)) return new Response(null, { status: 404 });
      return new Response(Bun.file(new URL(`..${path}`, import.meta.url)));
    },
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox"] });
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return {
    browser,
    origin: `http://127.0.0.1:${server.port}`,
    async close() {
      await browser.close();
      server.stop(true);
    },
  };
}

export async function unpackedExtensionBrowser(forceDark = false) {
  const path = fileURLToPath(new URL("../", import.meta.url));
  const context = await chromium.launchPersistentContext("", {
    executablePath: chromiumPath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-sandbox", `--disable-extensions-except=${path}`, `--load-extension=${path}`,
      ...(forceDark ? ["--enable-features=WebContentsForceDark", "--force-dark-mode"] : [])],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10000 });
    return { context, origin: new URL(worker.url()).origin.replace("null", worker.url().split("/").slice(0, 3).join("/")) };
  } catch (error) { await context.close(); throw error; }
}

export function mockChrome({ requests = [], granted = false, allow = true, relayState } = {}) {
  globalThis.calls = [];
  globalThis.chromeChanges = [];
  const record = (value) => {
    calls.push(value);
    document.documentElement.dataset.calls = JSON.stringify(calls);
  };
  addEventListener("mockRelayState", () => {
    const newValue = JSON.parse(document.documentElement.dataset.relayState);
    for (const listener of chromeChanges) listener({ signinRelay: { newValue } }, "session");
  });
  const settings = { serverUrl: "http://localhost:3001", serverSecret: "SYNTHETIC_SECRET", profileName: "work", pinnedSites: [], includeStorage: true };
  const site = { url: "https://login.example.com/", domain: "login.example.com", granted, cookieCount: 2, parents: [{ domain: "example.com", granted: false }] };
  globalThis.chrome = {
    storage: {
      local: { get: async () => settings, set: async (value) => Object.assign(settings, value) },
      session: { get: async () => ({ signinRelay: relayState }) },
      onChanged: { addListener: (fn) => chromeChanges.push(fn) },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => origin.includes("localhost")),
      request: async (permission) => { record(["grant", permission]); return allow; },
    },
    runtime: {
      getURL: (path) => path,
      sendMessage: async (message) => {
        record(["send", message]);
        let data;
        if (message.type === "site") data = site;
        if (message.type === "site-list") data = [site];
        if (message.type === "profiles") data = { profiles: [{ name: "work" }] };
        if (message.type === "summary") data = { domains: [] };
        if (message.type === "push") data = [{ ok: true, domain: site.domain, profile: "work", cookieCount: 2, storageKeyCount: 0 }];
        return { ok: true, data };
      },
    },
    tabs: { query: async () => [{ id: 7, url: site.url }], create: async () => {} },
    cookies: { getAll: async () => [] },
    scripting: { executeScript: async () => [] },
  };
  globalThis.fetch = async () => Response.json({ requests, grants: [] });
}
