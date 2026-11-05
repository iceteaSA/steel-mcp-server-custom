import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";
import { chromiumPath } from "./browser-processes.js";
import { SitePolicy, PolicyError } from "../site-policy.js";

function expectPolicyText(
  result: Awaited<ReturnType<Client["callTool"]>>,
  fields: Record<string, string | number | boolean>,
) {
  expect(result.isError).toBe(true);
  const text = CallToolResultSchema.parse(result)
    .content.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(text).toContain(`${fields.error}:`);
  for (const [key, value] of Object.entries(fields)) {
    const token = `${key}=${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (key !== "error") expect(text).toMatch(new RegExp(`(?:^|\\s)${token}(?=\\s|$)`));
  }
}

for (const kind of ["symlink", "fifo", "directory"] as const)
  test(`shared policy refuses unsafe file quickly: ${kind}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "policy-unsafe-"));
    const file = join(dir, "deny");
    try {
      if (kind === "symlink") {
        await writeFile(join(dir, "empty"), "");
        await symlink(join(dir, "empty"), file);
      } else if (kind === "directory") await mkdir(file);
      else {
        const child = Bun.spawn(["mkfifo", file]);
        expect(await child.exited).toBe(0);
      }
      const script = `import {SitePolicy} from ${JSON.stringify(new URL("../site-policy.ts", import.meta.url).pathname)};import {EnvSchema} from ${JSON.stringify(new URL("../env.ts", import.meta.url).pathname)};try{await new SitePolicy(EnvSchema.parse({BROWSER_MODE:'local',STEEL_SITE_DENY_FILE:${JSON.stringify(file)},STEEL_LANES:'off'})).enabled();console.log('ACCEPTED');}catch(e){console.log(String(e));}`;
      const child = Bun.spawn(["bun", "--eval", script], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 1500);
      try {
        await child.exited;
        expect(timedOut).toBe(false);
        expect(await new Response(child.stdout).text()).toContain("site_policy_invalid");
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("shared policy canonicalizes exact IP literals and Unicode domains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-addresses-"));
  const file = join(dir, "deny");
  try {
    await writeFile(file, "127.0.0.1\n[::1]\n例え.テスト\n");
    const policy = new SitePolicy(
      EnvSchema.parse({ BROWSER_MODE: "local", STEEL_SITE_DENY_FILE: file, STEEL_LANES: "off" }),
    );
    for (const host of [
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "[0:0:0:0:0:0:0:1]",
      "xn--r8jz45g.xn--zckzah",
    ]) {
      let sent = false;
      await expect(
        policy.http(`http://${host}/`, async () => {
          sent = true;
          return { value: "leak", status: 200 };
        }),
      ).rejects.toBeInstanceOf(PolicyError);
      expect(sent).toBe(false);
    }
    expect(
      await policy.http("http://127.0.0.2/", async () => ({ value: "allowed", status: 200 })),
    ).toBe("allowed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("off-mode HTTP redirect budget is disabled unless configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-http-cap-"));
  const file = join(dir, "deny");
  try {
    await writeFile(file, "example.com\n");
    const policy = new SitePolicy(
      EnvSchema.parse({ BROWSER_MODE: "local", STEEL_SITE_DENY_FILE: file, STEEL_LANES: "off" }),
    );
    let calls = 0;
    expect(
      await policy.http("http://allowed.test/", async () => ({
        value: "done",
        status: ++calls <= 20 ? 302 : 200,
        location: "/next",
      })),
    ).toBe("done");
    expect(calls).toBe(21);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual HTTP self-redirect returns redirect_loop within two seconds and at most21 requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-self-loop-"));
  const file = join(dir, "deny");
  let hits = 0;
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      hits++;
      return new Response(null, { status: 302, headers: { location: "/loop" } });
    },
  });
  try {
    await writeFile(file, "example.com\n");
    const script = `import {SitePolicy} from ${JSON.stringify(new URL("../site-policy.ts", import.meta.url).pathname)};import {EnvSchema} from ${JSON.stringify(new URL("../env.ts", import.meta.url).pathname)};import {fetchHttp} from ${JSON.stringify(new URL("../tools/extraction.ts", import.meta.url).pathname)};const policy=new SitePolicy(EnvSchema.parse({BROWSER_MODE:'local',STEEL_LANES:'off',STEEL_SITE_DENY_FILE:${JSON.stringify(file)}}));try{await fetchHttp(${JSON.stringify(site.url.origin + "/loop")},{policy});console.log('UNEXPECTED_SUCCESS');}catch(e){console.log(String(e));}`;
    const started = performance.now();
    const child = Bun.spawn(["bun", "--eval", script], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 1800);
    try {
      await child.exited;
      const elapsed = performance.now() - started;
      const output = await new Response(child.stdout).text();
      expect(hits).toBeLessThanOrEqual(21);
      expect(hits).toBe(21);
      expect(elapsed).toBeLessThan(2000);
      expect(timedOut).toBe(false);
      expect(output).toContain("redirect_loop: more than 20 redirects");
      expect(output).not.toContain("budget_exceeded");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    site.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual HTTP ceiling is distinct and configured lower budgets still apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-hard-cap-"));
  const file = join(dir, "deny");
  try {
    await writeFile(file, "example.com\n");
    for (const limit of [undefined, "3", "100"]) {
      const policy = new SitePolicy(
        EnvSchema.parse({
          BROWSER_MODE: "local",
          STEEL_LANES: "off",
          STEEL_SITE_DENY_FILE: file,
          STEEL_MAX_REDIRECTS: limit,
        }),
      );
      let calls = 0;
      let caught: unknown;
      try {
        await policy.http("http://allowed.test/loop", async () => ({
          value: "no",
          status: ++calls <= 21 ? 302 : 200,
          location: "/loop",
        }));
      } catch (error) {
        caught = error;
      }
      if (limit === "3") {
        expect(caught).toBeInstanceOf(PolicyError);
        expect((caught as PolicyError).detail).toMatchObject({
          error: "budget_exceeded",
          budget: "redirects",
          limit: 3,
          observed: 4,
        });
        expect(calls).toBe(4);
      } else {
        expect(String(caught)).toContain("redirect_loop: more than 20 redirects");
        expect(String(caught)).not.toContain("budget_exceeded");
        expect(calls).toBe(21);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual HTTP wall time bounds a stalled hop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-http-wall-"));
  const file = join(dir, "deny");
  try {
    await writeFile(file, "example.com\n");
    const policy = new SitePolicy(
      EnvSchema.parse({
        BROWSER_MODE: "local",
        STEEL_LANES: "off",
        STEEL_SITE_DENY_FILE: file,
        STEEL_NAVIGATION_TIMEOUT_MS: "50",
      }),
    );
    const started = performance.now();
    let caught: unknown;
    try {
      await policy.http("http://allowed.test/", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { value: "late", status: 200 };
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyError);
    expect((caught as PolicyError).detail).toMatchObject({
      error: "budget_exceeded",
      budget: "navigation_ms",
      limit: 50,
    });
    expect(performance.now() - started).toBeLessThan(200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual HTTP wall time also bounds redirect-response disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-http-dispose-wall-"));
  const file = join(dir, "deny");
  try {
    await writeFile(file, "example.com\n");
    const policy = new SitePolicy(
      EnvSchema.parse({
        BROWSER_MODE: "local",
        STEEL_LANES: "off",
        STEEL_SITE_DENY_FILE: file,
        STEEL_NAVIGATION_TIMEOUT_MS: "50",
      }),
    );
    let calls = 0;
    let disposed = 0;
    let caught: unknown;
    const started = performance.now();
    try {
      await policy.http("http://allowed.test/", async () => {
        calls++;
        return {
          value: "redirect",
          status: 302,
          location: "/next",
          dispose: async () => {
            disposed++;
            await new Promise((resolve) => setTimeout(resolve, 300));
          },
        };
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyError);
    expect((caught as PolicyError).detail).toMatchObject({
      error: "budget_exceeded",
      budget: "navigation_ms",
      limit: 50,
    });
    expect(calls).toBe(1);
    expect(disposed).toBe(1);
    expect(performance.now() - started).toBeLessThan(200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(mode = "on", shared = "", limits: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "site-policy-"));
  await writeFile(join(dir, "deny.txt"), shared);
  const hits: string[] = [];
  const pending = new Set<() => void>();
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response | Promise<Response> {
      const u = new URL(request.url);
      hits.push(u.hostname + u.pathname);
      if (u.pathname === "/self-loop")
        return hits.filter((hit) => hit.endsWith("/self-loop")).length > 21
          ? new Response("regression stop", { status: 500 })
          : new Response(null, { status: 302, headers: { location: "/self-loop" } });
      if (u.pathname === "/redirect")
        return Response.redirect(`http://sub.example.com:${site.port}/blocked`, 302);
      if (u.pathname === "/redirect-ip")
        return Response.redirect(`http://127.0.0.1:${site.port}/blocked-ip`, 302);
      if (u.pathname === "/ip-resources")
        return new Response(
          `<img src="http://127.0.0.1:${site.port}/image"><script>fetch('http://127.0.0.1:${site.port}/fetch').then(()=>document.body.dataset.fetch='allowed',()=>document.body.dataset.fetch='blocked')</script>`,
          { headers: { "content-type": "text/html" } },
        );
      if (u.pathname === "/redirect-dot")
        return Response.redirect(`http://sub.example.com.:${site.port}/blocked`, 302);
      if (u.pathname === "/frame-resources")
        return new Response(
          `<iframe src="/redirect"></iframe><iframe src="http://other.test:${site.port}/redirect"></iframe><img src="/redirect"><script>fetch('/redirect').catch(()=>{});</script>`,
          { headers: { "content-type": "text/html" } },
        );
      if (u.pathname === "/via-blocked")
        return Response.redirect(`http://sub.example.com:${site.port}/bounce`, 302);
      if (u.pathname === "/bounce")
        return Response.redirect(`http://allowed.test:${site.port}/ok`, 302);
      if (u.pathname === "/http-allowed")
        return Response.redirect(`http://127.0.0.1:${site.port}/ok`, 302);
      if (u.pathname.startsWith("/chain/")) {
        const n = Number(u.pathname.split("/").pop());
        if (n > 0) return Response.redirect(`http://allowed.test:${site.port}/chain/${n - 1}`, 302);
      }
      if (u.pathname === "/hang")
        return new Promise<Response>((resolve) => {
          const timer = setTimeout(() => resolve(new Response("released")), 1000);
          pending.add(() => {
            clearTimeout(timer);
            resolve(new Response("released"));
          });
        });
      if (u.pathname === "/resources")
        return new Response(
          `<body><img src="http://sub.example.com:${site.port}/image"><script>fetch('http://sub.example.com:${site.port}/fetch').then(()=>document.body.dataset.fetch='allowed',()=>document.body.dataset.fetch='blocked')</script>`,
          { headers: { "content-type": "text/html" } },
        );
      return new Response("<title>Policy fixture</title><p>ok</p>", {
        headers: { "content-type": "text/html", "access-control-allow-origin": "*" },
      });
    },
  });
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP * 127.0.0.1"],
  });
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: mode,
    STEEL_SITE_DENY_FILE: join(dir, "deny.txt"),
    OUTPUT_DIR: dir,
    RELAY_PORT: "0",
    TAB_IDLE_TIMEOUT_MS: "0",
    SETTLE_TIMEOUT_MS: "0",
    ...limits,
  });
  const root = new BrowserManager(env);
  const operator = await browser.newContext();
  const primary = await operator.newPage();
  Object.assign(root, {
    _connectSteel: async () => {
      Object.assign(root, { browser, browserContext: operator });
      const id = (root as unknown as { allocateTab(page: typeof primary): number }).allocateTab(
        primary,
      );
      Object.assign(root, { currentTabId: id, primaryTabId: id });
    },
  });
  Object.assign(env, { BROWSER_MODE: "steel" });
  const server = new McpServer({ name: "policy-test", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), { manager: root, env });
  for (const register of Object.values(groups))
    register(handle.register, handle.manager ?? root, env);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "policy-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = (caller: string, name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": caller } });
  const url = (host = "allowed.test", path = "/") => `http://${host}:${site.port}${path}`;
  return {
    call,
    client,
    env,
    hits,
    browser,
    url,
    async close() {
      for (const release of pending) release();
      await handle.close?.();
      await root.stop();
      await client.close();
      await server.close();
      await browser.close();
      site.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const mode of ["http", "auto", "download"] as const)
  test(`redirect_loop returns without a browser retry: ${mode}`, async () => {
    const f = await fixture("off", "example.com\n");
    try {
      if (mode === "download") expect((await f.call("a", "new_tab")).isError).not.toBe(true);
      const started = performance.now();
      const url = f.url("127.0.0.1", "/self-loop");
      const result =
        mode === "download"
          ? await f.call("a", "download_file", { url, forceFetch: true })
          : await f.call("a", "fetch_urls", { urls: [url], mode });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.isError).toBe(true);
      expectPolicyText(result, {
        error: "redirect_loop",
      });
      expect(JSON.stringify(result)).toContain("redirect_loop: more than 20 redirects");
      expect(f.hits.filter((hit) => hit.endsWith("/self-loop"))).toHaveLength(21);
    } finally {
      await f.close();
    }
  });

test("IPv6 guards omit inert Network patterns but retain Fetch and route guards", async () => {
  const f = await fixture("off", "[::1]\n127.0.0.1\n");
  const context = await f.browser.newContext();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const attach = spyOn(context, "newCDPSession").mockResolvedValue(session);
  const send = spyOn(session, "send");
  try {
    const policy = new SitePolicy(f.env);
    await policy.attach(context);
    const network = send.mock.calls.find(
      ([method]) => method === "Network.setBlockedURLs",
    )?.[1] as { urlPatterns: { urlPattern: string }[] };
    const fetch = send.mock.calls.find(([method]) => method === "Fetch.enable")?.[1] as {
      patterns: { urlPattern: string }[];
    };
    expect(network.urlPatterns.length).toBeGreaterThan(0);
    for (const pattern of network.urlPatterns) expect(pattern.urlPattern).not.toContain("[");
    expect(fetch.patterns.some((pattern) => pattern.urlPattern.includes("[::1]"))).toBe(true);
    await expect(page.goto("http://[::1]/")).rejects.toThrow();
    expect(policy.takePending()?.detail).toMatchObject({ error: "site_blocked", domain: "[::1]" });
  } finally {
    send.mockRestore();
    attach.mockRestore();
    await context.close();
    await f.close();
  }
});

test("block_site has exact schema and annotations in both modes", async () => {
  for (const mode of ["on", "off"]) {
    const f = await fixture(mode);
    try {
      const tools = (await f.client.listTools()).tools;
      expect(tools.filter((t) => t.name === "block_site")).toHaveLength(1);
      const tool = tools.find((t) => t.name === "block_site")!;
      expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["reason", "site"]);
      expect(tool.inputSchema.required ?? []).toEqual([]);
      expect(tool.annotations).toEqual({
        title: "Block Site",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    } finally {
      await f.close();
    }
  }
});

for (const mode of ["off", "on"])
  test(`disabling media restores the policy page route: ${mode}`, async () => {
    const f = await fixture(mode, "example.com\n");
    try {
      await f.call("a", "new_tab", { url: f.url() });
      await f.call("a", "go_to_url", { url: f.url(), disableMedia: true });
      const page = f.browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url() === f.url())!;
      const routes = spyOn(page, "route");
      try {
        await f.call("a", "go_to_url", { url: f.url(), disableMedia: false });
        expect(routes).toHaveBeenCalled();
      } finally {
        routes.mockRestore();
      }
      await f.call("a", "go_to_url", { url: f.url("allowed.test", "/resources") });
      await page.waitForFunction(() => document.body.dataset.fetch !== undefined);
      expect(f.hits.filter((h) => h.startsWith("sub.example.com/"))).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("browser routes block canonical address aliases and IDNs without denying their DNS neighbors", async () => {
  const f = await fixture("on", "127.0.0.1\n[::1]\n例え.テスト\n");
  try {
    const allowed = await f.call("a", "new_tab", { url: f.url() });
    expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
    for (const host of [
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "[::1]",
      "例え.テスト",
    ]) {
      const result = await f.call("a", "new_tab", { url: f.url(host) });
      expect(result.structuredContent).toMatchObject({ error: "site_blocked", source: "shared" });
    }
    expect(f.hits.some((h) => h.startsWith("127.0.0.1/") || h.startsWith("xn--"))).toBe(false);
    expect(
      (await f.call("b", "new_tab", { url: f.url("allowed.test", "/redirect-ip") }))
        .structuredContent,
    ).toMatchObject({ error: "site_blocked", domain: "127.0.0.1" });
    await f.call("c", "new_tab", { url: f.url("allowed.test", "/ip-resources") });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("ip-resources"))!;
    await page.waitForFunction(() => document.body.dataset.fetch !== undefined);
    expect(await page.getAttribute("body", "data-fetch")).toBe("blocked");
    expect(f.hits.some((h) => h.startsWith("127.0.0.1/"))).toBe(false);
  } finally {
    await f.close();
  }
});

test("native redirect error reports observed hops rather than a fixed count", async () => {
  const f = await fixture("on", "", { STEEL_MAX_REDIRECTS: "100" });
  try {
    await f.call("a", "new_tab");
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .at(-1)!;
    const policy = new SitePolicy(f.env);
    await policy.attach(page.context());
    let caught: unknown;
    try {
      await policy.navigate(page, async () => {
        await page.goto(f.url("allowed.test", "/chain/2"));
        throw new Error("ERR_TOO_MANY_REDIRECTS");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyError);
    expect((caught as PolicyError).detail).toMatchObject({
      budget: "redirects",
      limit: 100,
      observed: 2,
    });
  } finally {
    await f.close();
  }
});

test("Chromium native redirect count matches observed redirect responses", async () => {
  const f = await fixture("on", "", { STEEL_MAX_REDIRECTS: "100" });
  try {
    await f.call("a", "new_tab");
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .at(-1)!;
    let observed = 0;
    page.on("response", (response) => {
      if (response.status() === 302) observed++;
    });
    const result = await f.call("a", "go_to_url", { url: f.url("allowed.test", "/chain/30") });
    expect(observed).toBeGreaterThan(0);
    expect(result.structuredContent).toMatchObject({
      error: "budget_exceeded",
      budget: "redirects",
      observed,
    });
  } finally {
    await f.close();
  }
});

for (const mode of ["on", "off"])
  test(`shared domain blocks navigation, subdomains, not lookalikes: ${mode}`, async () => {
    const f = await fixture(mode, "# Reviewed test list\nexample.com\n");
    try {
      for (const host of ["example.com", "sub.example.com"]) {
        const result = await f.call("a", "new_tab", { url: f.url(host) });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: "site_blocked",
          domain: "example.com",
          source: "shared",
        });
      }
      expect((await f.call("a", "new_tab", { url: f.url("notexample.com") })).isError).not.toBe(
        true,
      );
      expect(
        f.hits.some((h) => h.startsWith("example.com/") || h.startsWith("sub.example.com/")),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

test("block_site is additive, lane-local and dies with the lane", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.call("a", "block_site", {
          site: "https://sub.example.com",
          reason: "Untrusted site",
        })
      ).isError,
    ).not.toBe(true);
    expect((await f.call("a", "block_site")).structuredContent).toMatchObject({
      sites: [{ domain: "example.com", source: "lane", reason: "Untrusted site" }],
    });
    expect((await f.call("b", "block_site")).structuredContent).toEqual({ sites: [] });
    expect(
      (await f.call("a", "new_tab", { url: f.url("example.com") })).structuredContent,
    ).toMatchObject({ error: "site_blocked", source: "lane" });
    expect((await f.call("b", "new_tab", { url: f.url("example.com") })).isError).not.toBe(true);
    await f.call("a", "close_lane");
    expect((await f.call("a", "block_site")).structuredContent).toEqual({ sites: [] });
  } finally {
    await f.close();
  }
});

test("shared policy blocks img and fetch even with interception active", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    const opened = await f.call("a", "new_tab");
    const tabId = Number(JSON.stringify(opened).match(/Opened Tab (\d+)/)![1]);
    await f.call("a", "intercept", { tabId, action: "continue", pattern: "**/*" });
    await f.call("a", "go_to_url", { tabId, url: f.url("allowed.test", "/resources") });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("/resources"))!;
    await page.waitForFunction(() => document.body.dataset.fetch);
    expect(await page.locator("body").getAttribute("data-fetch")).toBe("blocked");
    await page.waitForLoadState("load");
    expect(f.hits.filter((h) => h.startsWith("sub.example.com"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("redirect into blocked domain never reaches server", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    const result = await f.call("a", "new_tab", { url: f.url("allowed.test", "/redirect") });
    expect(result.structuredContent).toMatchObject({
      error: "site_blocked",
      domain: "example.com",
      source: "shared",
    });
    expect(f.hits).not.toContain("sub.example.com/blocked");
  } finally {
    await f.close();
  }
});

test("popup inherits the lane deny list", async () => {
  const f = await fixture();
  try {
    await f.call("a", "block_site", { site: "example.com", reason: "test" });
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === f.url())!;
    const popupEvent = page.context().waitForEvent("page");
    await page.evaluate((url) => {
      window.open(url);
    }, f.url("sub.example.com"));
    const popup = await popupEvent;
    await popup.waitForLoadState("load", { timeout: 1000 }).catch(() => {});
    expect(f.hits.filter((h) => h.startsWith("sub.example.com"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("popup first redirect is contained and denied content never enters read paths", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === f.url())!;
    const event = page.context().waitForEvent("page");
    await page.evaluate(
      (url) => {
        window.open(url);
      },
      f.url("allowed.test", "/redirect"),
    );
    const popup = await event;
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 2000 });
    const notice = await f.call("a", "list_tabs");
    expectPolicyText(notice, { error: "site_blocked", popup: true });
    const tabs = await f.call("a", "list_tabs");
    expect(JSON.stringify(tabs)).not.toContain("sub.example.com");
    const network = await f.call("a", "get_network");
    expect(
      (network.structuredContent as { events: { url: string }[] }).events.some((e) =>
        e.url.includes("sub.example.com/blocked"),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test("allowed direct and redirected popups remain usable", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === f.url())!;
    for (const path of ["/ok", "/chain/1"]) {
      const event = page.context().waitForEvent("page");
      await page.evaluate(
        (url) => {
          window.open(url);
        },
        f.url("allowed.test", path),
      );
      const popup = await event;
      await popup.waitForLoadState("load");
      expect(popup.isClosed()).toBe(false);
      expect(await popup.title()).toBe("Policy fixture");
    }
  } finally {
    await f.close();
  }
});

test("popup cannot hide a denied intermediate redirect behind an allowed final URL", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === f.url())!;
    const event = page.context().waitForEvent("page");
    await page.evaluate(
      (url) => {
        window.open(url);
      },
      f.url("allowed.test", "/via-blocked"),
    );
    const popup = await event;
    await popup.waitForLoadState("load").catch(() => {});
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 1000 });
    expectPolicyText(await f.call("a", "list_tabs"), {
      error: "site_blocked",
      popup: true,
    });
  } finally {
    await f.close();
  }
});

test("request rolling window expires at its exact boundary", async () => {
  const f = await fixture("on", "", { STEEL_MAX_REQUESTS: "2" });
  try {
    let now = 0;
    const policy = new SitePolicy(f.env, () => now);
    const context = await f.browser.newContext();
    await policy.attach(context);
    const page = await context.newPage();
    await policy.navigate(page, () => page.goto(f.url("allowed.test", "/one")));
    await policy.navigate(page, () => page.goto(f.url("allowed.test", "/two")));
    now = 59999;
    await expect(
      policy.navigate(page, () => page.goto(f.url("allowed.test", "/over"))),
    ).rejects.toBeInstanceOf(PolicyError);
    now = 60000;
    await policy.navigate(page, () => page.goto(f.url("allowed.test", "/renewed")));
    expect(f.hits).toContain("allowed.test/renewed");
  } finally {
    await f.close();
  }
});

test("wall budget accepts its exact boundary and rejects the next millisecond", async () => {
  const f = await fixture("on", "", { STEEL_NAVIGATION_TIMEOUT_MS: "300" });
  try {
    let now = 0;
    const policy = new SitePolicy(f.env, () => now);
    const context = await f.browser.newContext();
    await policy.attach(context);
    const page = await context.newPage();
    await policy.navigate(page, async () => {
      const response = await page.goto(f.url());
      now = 300;
      return response;
    });
    await expect(
      policy.navigate(page, async () => {
        const response = await page.goto(f.url());
        now = 601;
        return response;
      }),
    ).rejects.toMatchObject({
      detail: { error: "budget_exceeded", budget: "navigation_ms", limit: 300, observed: 301 },
    });
  } finally {
    await f.close();
  }
});

test("site-initiated navigation also has a wall budget", async () => {
  const f = await fixture("on", "", { STEEL_NAVIGATION_TIMEOUT_MS: "300" });
  try {
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === f.url())!;
    await page.goto(f.url("allowed.test", "/hang")).catch(() => {});
    expectPolicyText(await f.call("a", "list_tabs"), {
      error: "budget_exceeded",
      budget: "navigation_ms",
      limit: 300,
    });
  } finally {
    await f.close();
  }
});

test("redirect budget accepts limit and rejects next hop", async () => {
  for (const [depth, blocked] of [
    [2, false],
    [3, true],
  ] as const) {
    const f = await fixture("on", "", { STEEL_MAX_REDIRECTS: "2" });
    try {
      const r = await f.call("a", "new_tab", { url: f.url("allowed.test", `/chain/${depth}`) });
      if (blocked)
        expect(r.structuredContent).toMatchObject({
          error: "budget_exceeded",
          budget: "redirects",
          limit: 2,
          observed: 3,
        });
      else expect(r.isError).not.toBe(true);
    } finally {
      await f.close();
    }
  }
});

test("request budget accepts limit and rejects next request without stopping another lane", async () => {
  const f = await fixture("on", "", { STEEL_MAX_REQUESTS: "2" });
  try {
    for (let n = 0; n < 2; n++)
      expect(
        (await f.call("a", "new_tab", { url: f.url("allowed.test", `/n${n}`) })).isError,
      ).not.toBe(true);
    expect(
      (await f.call("a", "new_tab", { url: f.url("allowed.test", "/over") })).structuredContent,
    ).toMatchObject({ error: "budget_exceeded", budget: "requests", limit: 2, observed: 3 });
    expect((await f.call("b", "new_tab", { url: f.url() })).isError).not.toBe(true);
  } finally {
    await f.close();
  }
});

test("navigation wall budget stops a hung response but not another lane", async () => {
  const f = await fixture("on", "", { STEEL_NAVIGATION_TIMEOUT_MS: "300" });
  try {
    expect(
      (await f.call("a", "new_tab", { url: f.url("allowed.test", "/hang") })).structuredContent,
    ).toMatchObject({ error: "budget_exceeded", budget: "navigation_ms", limit: 300 });
    expect((await f.call("b", "new_tab", { url: f.url() })).isError).not.toBe(true);
  } finally {
    await f.close();
  }
});

test("off mode empty list leaves browsing unchanged and block_site is process-wide", async () => {
  const f = await fixture("off");
  try {
    expect((await f.call("a", "new_tab", { url: f.url("example.com") })).isError).not.toBe(true);
    await f.call("a", "block_site", { site: "example.com", reason: "test" });
    expect(
      (await f.call("b", "new_tab", { url: f.url("example.com") })).structuredContent,
    ).toMatchObject({ error: "site_blocked", source: "lane" });
  } finally {
    await f.close();
  }
});

for (const tool of ["fetch_urls", "download_file"] as const)
  test(`${tool} checks initial URL and every HTTP redirect`, async () => {
    const f = await fixture("on", "example.com\n");
    try {
      const args = (url: string) =>
        tool === "fetch_urls" ? { urls: [url], mode: "http" } : { url, forceFetch: true };
      for (const url of [f.url("sub.example.com"), f.url("127.0.0.1", "/redirect")]) {
        const result = await f.call("a", tool, args(url));
        expect(result.isError).toBe(true);
        expectPolicyText(result, {
          error: "site_blocked",
          domain: "example.com",
        });
      }
      expect((await f.call("a", tool, args(f.url("127.0.0.1", "/http-allowed")))).isError).not.toBe(
        true,
      );
    } finally {
      await f.close();
    }
  });

for (const invalid of ["malformed", "unreadable"] as const)
  test(`invalid shared policy fails before allocating a lane context: ${invalid}`, async () => {
    const f = await fixture("on", invalid === "malformed" ? "com\n" : "");
    try {
      if (invalid === "unreadable") await rm(f.env.STEEL_SITE_DENY_FILE);
      const before = f.browser.contexts().length;
      const result = await f.call("a", "new_tab");
      expect(f.browser.contexts()).toHaveLength(before);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("site_policy_invalid");
    } finally {
      await f.close();
    }
  });

test("shared policy validates once and subsequent lanes use its cached snapshot", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    await f.call("a", "new_tab");
    await writeFile(f.env.STEEL_SITE_DENY_FILE, "com\n");
    expect(
      (await f.call("b", "new_tab", { url: f.url("example.com") })).structuredContent,
    ).toMatchObject({ error: "site_blocked", domain: "example.com", source: "shared" });
  } finally {
    await f.close();
  }
});

test("domain bypass corpus matches canonical domains without substring false matches", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    for (const host of [
      "example.com",
      "EXAMPLE.com",
      "sub.example.com",
      "sub.example.com.",
      "%65xample.com",
    ]) {
      expect((await f.call("a", "new_tab", { url: f.url(host) })).structuredContent).toMatchObject({
        error: "site_blocked",
        domain: "example.com",
      });
    }
    for (const host of ["notexample.com", "example.com.evil.test", "sub.notexample.com"]) {
      expect((await f.call("a", "new_tab", { url: f.url(host) })).isError).not.toBe(true);
    }
    expect(
      (
        await f.call("a", "new_tab", {
          url: f.url("allowed.test", "/?next=http://sub.example.com/"),
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (await f.call("a", "new_tab", { url: f.url("allowed.test", "/redirect-dot") }))
        .structuredContent,
    ).toMatchObject({ error: "site_blocked", domain: "example.com" });
    expect(f.hits.some((h) => h.startsWith("sub.example.com."))).toBe(false);
  } finally {
    await f.close();
  }
});

test("same-origin and cross-origin iframes and subresources cannot redirect into a denied host", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    await f.call("a", "new_tab", { url: f.url("allowed.test", "/frame-resources") });
    const page = f.browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("/frame-resources"))!;
    await page.waitForLoadState("load");
    expect(f.hits.filter((h) => h.startsWith("sub.example.com/"))).toEqual([]);
    expect(f.hits).toContain("other.test/redirect");
  } finally {
    await f.close();
  }
});

test("policy calls leave a lane fresh for its first profile binding", async () => {
  const f = await fixture();
  try {
    await f.call("a", "block_site", { site: "example.com", reason: "test" });
    expect(
      (await f.call("a", "new_tab", { profile: "policy-fresh", url: f.url() })).isError,
    ).not.toBe(true);
  } finally {
    await f.close();
  }
});

for (const tool of ["fetch_urls", "download_file"] as const)
  test(`${tool} shares request and redirect budgets with its lane`, async () => {
    const f = await fixture("on", "", { STEEL_MAX_REQUESTS: "2", STEEL_MAX_REDIRECTS: "1" });
    try {
      const args = (url: string) =>
        tool === "fetch_urls" ? { urls: [url], mode: "http" } : { url, forceFetch: true };
      expect((await f.call("a", tool, args(f.url("127.0.0.1", "/http-allowed")))).isError).not.toBe(
        true,
      );
      expectPolicyText(await f.call("a", tool, args(f.url("127.0.0.1"))), {
        error: "budget_exceeded",
        budget: "requests",
        limit: 2,
        observed: 3,
      });
      expect((await f.call("b", tool, args(f.url("127.0.0.1")))).isError).not.toBe(true);
    } finally {
      await f.close();
    }
  });

test("SDK carries complete policy diagnostics for fetch_urls and list_tabs without schema changes", async () => {
  const f = await fixture("on", "example.com\n");
  try {
    const before = (await f.client.listTools()).tools;
    const fetched = await f.call("a", "fetch_urls", {
      urls: [f.url("sub.example.com")],
      mode: "http",
    });
    expectPolicyText(fetched, { error: "site_blocked", domain: "example.com", source: "shared" });
    expect(fetched.structuredContent).toBeUndefined();
    await f.call("a", "new_tab", { url: f.url() });
    const page = f.browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === f.url())!;
    const event = page.context().waitForEvent("page");
    await page.evaluate(
      (url) => {
        window.open(url);
      },
      f.url("allowed.test", "/redirect"),
    );
    const popup = await event;
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 2000 });
    const listed = await f.call("a", "list_tabs");
    expectPolicyText(listed, {
      error: "site_blocked",
      domain: "example.com",
      source: "shared",
      popup: true,
    });
    expect(listed.structuredContent).toBeUndefined();
    expect((await f.client.listTools()).tools).toEqual(before);
  } finally {
    await f.close();
  }
});
