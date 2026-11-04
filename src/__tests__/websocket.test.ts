import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "patchright";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { register as registerExtraction } from "../tools/extraction.js";
import { register as registerInteraction } from "../tools/interaction.js";
import type { ToolSpec } from "../tools/shared.js";
import { clearSnapshot, getStoredSnapshot } from "../snapshot.js";

test("settle injection on document load preserves page WebSocket upgrades", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(
        "<!doctype html><title>WebSocket fixture</title><body>Local fixture</body>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const profile = await mkdtemp(join(tmpdir(), "steel-websocket-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    timeout: 5000,
    args: ["--no-sandbox"],
  });
  try {
    const page = context.pages()[0];
    const mgr = new BrowserManager(
      EnvSchema.parse({ BROWSER_MODE: "local", TAB_IDLE_TIMEOUT_MS: "0" }),
    );
    const internals = mgr as unknown as { allocateTab(page: Page): number };
    internals.allocateTab(page);
    for (const path of ["/first", "/second"]) {
      await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => typeof (window as unknown as { __steelSettle?: unknown }).__steelSettle === "object",
        undefined,
        { timeout: 3000 },
      );
      const reply = await page.evaluate(
        (port) =>
          new Promise<string>((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/echo`);
            const timeout = setTimeout(() => {
              socket.close();
              reject(new Error("WebSocket echo timed out"));
            }, 3000);
            socket.onopen = () => socket.send("settle-preserves-websocket");
            socket.onmessage = (event) => {
              clearTimeout(timeout);
              socket.close();
              resolve(String(event.data));
            };
            socket.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebSocket upgrade failed"));
            };
          }),
        server.port,
      );
      expect(reply).toBe("settle-preserves-websocket");
    }
  } finally {
    await context.close();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 20000);

test("nested cross-origin iframe snapshots keep frame refs and the main baseline isolated", async () => {
  const inner = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<button onclick=\"this.textContent='Inner clicked'\">Inner target</button>", {
        headers: { "content-type": "text/html" },
      }),
  });
  const outer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(
        new URL(request.url).pathname === "/outer"
          ? `<button>Outer target</button><iframe name="inner" src="http://127.0.0.1:${inner.port}/inner"></iframe>`
          : `<button>Main target</button><iframe name="outer" src="/outer"></iframe>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  const profile = await mkdtemp(join(tmpdir(), "steel-iframe-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
    timeout: 5000,
  });
  try {
    const page = context.pages()[0];
    await page.goto(`http://127.0.0.1:${outer.port}/`, { waitUntil: "domcontentloaded" });
    await page
      .frameLocator('iframe[name="outer"]')
      .frameLocator('iframe[name="inner"]')
      .getByRole("button")
      .waitFor();
    const env = EnvSchema.parse({ BROWSER_MODE: "local", SETTLE_TIMEOUT_MS: "0" });
    const mgr = {
      getPage: async () => page,
      resolveTab: () => 991,
      dialogNotice: () => "",
      getTabLastUrl: () => page.url(),
      setTabLastUrl: () => {},
    } as unknown as BrowserManager;
    const specs: ToolSpec[] = [];
    registerExtraction((spec) => specs.push(spec), mgr, env);
    registerInteraction((spec) => specs.push(spec), mgr, env);
    const snapshot = specs.find((spec) => spec.name === "snapshot")!;
    clearSnapshot(991);
    await snapshot.handler({ filter: "all" });
    const baseline = getStoredSnapshot(991);
    expect(baseline).toContain("Main target");
    const index = page
      .frames()
      .slice(1)
      .findIndex((frame) => frame.name() === "inner");
    expect(index).toBeGreaterThanOrEqual(0);
    for (const frame of ["inner", `:${inner.port}/inner`, String(index)]) {
      const result = await snapshot.handler({ frame, filter: "all" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Inner target");
      expect(result.content[0].text).not.toContain('button "Main target"');
      expect(result.content[0].text).not.toContain('button "Outer target"');
      expect(getStoredSnapshot(991)).toBe(baseline);
    }
    const found = await snapshot.handler({ frame: "inner", query: "Inner target" });
    const ref = found.structuredContent.text.match(/@(?:f\d+)?e\d+/)?.[0];
    expect(ref).toBeDefined();
    const click = await specs
      .find((spec) => spec.name === "click")!
      .handler({ frame: "inner", ref });
    expect(click.isError).toBeUndefined();
    expect(await page.frame({ name: "inner" })!.getByRole("button").innerText()).toBe(
      "Inner clicked",
    );
    const wrongFrame = await snapshot.handler({ frame: "missing" });
    expect(wrongFrame.isError).toBe(true);
  } finally {
    clearSnapshot(991);
    await context.close();
    outer.stop(true);
    inner.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 20000);

test("fetch_urls browser mode can overwrite pre-existing shared cookies and localStorage", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const overwrite = new URL(request.url).pathname === "/overwrite";
      return new Response(
        `<script>localStorage.setItem('existing', '${overwrite ? "after" : "before"}')</script><article><h1>Fixture article</h1><p>Synthetic local article content for the shared-context state regression.</p></article>`,
        {
          headers: {
            "content-type": "text/html",
            ...(overwrite ? { "set-cookie": "existing=after; Path=/" } : {}),
          },
        },
      );
    },
  });
  const profile = await mkdtemp(join(tmpdir(), "steel-fetch-state-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    timeout: 5000,
    args: ["--no-sandbox"],
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const primary = context.pages()[0];
    await context.addCookies([{ name: "existing", value: "before", url: origin }]);
    await primary.goto(`${origin}/seed`, { waitUntil: "domcontentloaded" });
    expect(
      (await context.cookies(origin)).find((cookie) => cookie.name === "existing")?.value,
    ).toBe("before");
    expect(await primary.evaluate(() => localStorage.getItem("existing"))).toBe("before");
    const tabs = new Map<number, Page>();
    let nextId = 1;
    const mgr = {
      newTab: async (_url: unknown, _owner: unknown, _profile: unknown, activate: boolean) => {
        expect(activate).toBe(false);
        const page = await context.newPage();
        const tabId = nextId++;
        tabs.set(tabId, page);
        return { tabId, page };
      },
      closeTab: async (tabId: number) => {
        await tabs.get(tabId)!.close();
        tabs.delete(tabId);
      },
    } as unknown as BrowserManager;
    const specs: ToolSpec[] = [];
    registerExtraction(
      (spec) => specs.push(spec),
      mgr,
      EnvSchema.parse({ BROWSER_MODE: "local", GLOBAL_WAIT_SECONDS: "0" }),
    );
    const tool = specs.find((spec) => spec.name === "fetch_urls")!;
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
    const result = await tool.handler({ urls: [`${origin}/overwrite`], mode: "browser" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.results[0].path).toBe("browser");
    expect(result.structuredContent.results[0].text).toContain("Fixture article");
    expect(tabs.size).toBe(0);
    expect(context.pages()).toHaveLength(1);
    expect(primary.url()).toBe(`${origin}/seed`);
    expect(
      (await context.cookies(origin)).find((cookie) => cookie.name === "existing")?.value,
    ).toBe("after");
    expect(await primary.evaluate(() => localStorage.getItem("existing"))).toBe("after");
  } finally {
    await context.close();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 20000);
