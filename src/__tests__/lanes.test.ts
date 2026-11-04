import { afterAll, expect, test, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "patchright";
import { z } from "zod";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess, { type ChildProcess } from "node:child_process";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";

// Bun #34785 double-closes extra stdio fds after child GC.
// Keep closed child references for this test process. Remove at Bun ≥ 1.4.0.
const chromiumPath = "/home/icetea/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const retainedChildren: Array<{ child: ChildProcess; stdio: ChildProcess["stdio"] }> = [];
const nativeSpawn = childProcess.spawn;
const retainedSpawn = new Proxy(nativeSpawn, {
  apply(target, receiver, args) {
    const child: ChildProcess = Reflect.apply(target, receiver, args);
    const options = args[2] ?? args[1];
    if (
      args[0] === chromiumPath &&
      options &&
      Array.isArray(options.stdio) &&
      options.stdio.length > 3
    ) {
      retainedChildren.push({ child, stdio: child.stdio });
    }
    return child;
  },
});
if (Bun.version.startsWith("1.3.")) childProcess.spawn = retainedSpawn;
afterAll(() => {
  if (childProcess.spawn === retainedSpawn) childProcess.spawn = nativeSpawn;
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(mode = "on", overrides: Record<string, string> = {}) {
  const launchOptions = {
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  };
  const launch = async () => {
    const retainedBefore = retainedChildren.length;
    const browser = await chromium.launch(launchOptions);
    if (Bun.version.startsWith("1.3.")) expect(retainedChildren.length).toBe(retainedBefore + 1);
    return browser;
  };
  let browser = await launch();
  let now = 1000;
  let starts = 0;
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: mode,
    LANE_IDLE_MS: "100",
    TAB_IDLE_TIMEOUT_MS: "0",
    SETTLE_TIMEOUT_MS: "0",
    RELAY_PORT: "0",
    ...overrides,
  });
  const root = new BrowserManager(env);
  let operator = await browser.newContext();
  let primary = await operator.newPage();
  const startGate = barrier();
  startGate.release();
  Object.assign(root, {
    _connectSteel: async () => {
      starts++;
      await startGate.promise;
      if (!browser.isConnected()) {
        browser = await launch();
        operator = await browser.newContext();
        primary = await operator.newPage();
      }
      Object.assign(root, { browser, browserContext: operator });
      const id = (root as unknown as { allocateTab(page: typeof primary): number }).allocateTab(
        primary,
      );
      Object.assign(root, { currentTabId: id, primaryTabId: id });
    },
  });
  // Use the actual initialization path with only the remote Steel connection replaced.
  Object.assign(env, { BROWSER_MODE: "steel" });
  const server = new McpServer({ name: "lanes-test", version: "1" });
  const handle = makeRegistrar(server, new Set(ALL_TOOLSETS), {
    manager: root,
    env,
    now: () => now,
  });
  const mgr = handle.manager ?? root;
  for (const register of Object.values(groups)) register(handle.register, mgr, env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lanes-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (caller: string | undefined, name: string, args: Record<string, unknown> = {}) =>
    client.callTool({
      name,
      arguments: args,
      ...(caller ? { _meta: { "ai.opencode/sessionID": caller } } : {}),
    });
  return {
    call,
    mgr,
    root,
    handle,
    get operator() {
      return operator;
    },
    get primary() {
      return primary;
    },
    env,
    contexts: () => browser.contexts(),
    endSession: () => browser.close(),
    starts: () => starts,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await handle.close?.();
      await client.close();
      await server.close();
      await operator.close();
      await browser.close();
    },
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.stringify(result);
}
function tab(result: Awaited<ReturnType<Client["callTool"]>>) {
  const match = text(result).match(/Opened Tab (\d+)/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as Record<string, unknown> | undefined;
}

test("lane requests require SDK request metadata, while profile listing is stateless", async () => {
  const f = await fixture();
  try {
    expect(text(await f.call(undefined, "list_tabs"))).toContain("no_caller");
    expect((await f.call(undefined, "list_profiles")).isError).not.toBe(true);
    expect(f.starts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("two callers isolate cookies, current tabs, labels, and foreign tab access", async () => {
  const f = await fixture();
  try {
    const a = tab(await f.call("a", "new_tab", { owner: "same" }));
    const b = tab(await f.call("b", "new_tab", { owner: "same" }));
    expect(a).not.toBe(b);
    await f.call("a", "cookies", {
      setCookies: [{ name: "lane", value: "a", domain: "example.test", path: "/" }],
    });
    expect(text(await f.call("a", "cookies"))).toContain('"a"');
    expect((await f.call("b", "cookies")).structuredContent).toEqual({ cookies: [] });
    expect(
      text(await f.call("b", "evaluate", { tabId: a, force: true, expression: "1" })),
    ).toContain("not_in_lane");
    expect(text(await f.call("b", "close_tabs", { tabId: a }))).toContain("not_in_lane");
    expect(text(await f.call("b", "list_tabs", { tabId: a }))).toContain("not_in_lane");
    expect(text(await f.call("a", "list_tabs"))).not.toContain(`Tab ${b}`);
    expect(structured(await f.call("a", "list_tabs"))?.tabs).toMatchObject([
      { tabId: a, active: true },
    ]);
    expect(
      (await f.call("a", "evaluate", { tabId: a, owner: "different", expression: "1" })).isError,
    ).not.toBe(true);
    expect(f.primary.isClosed()).toBe(false);
    expect(
      text(await f.call("a", "evaluate", { tabId: f.root.activeTabId, expression: "1" })),
    ).toContain("not_in_lane");
  } finally {
    await f.close();
  }
});

test("popups remain in their context lane and the operator context is never adopted", async () => {
  const f = await fixture();
  try {
    await f.call("a", "new_tab");
    await f.call("b", "new_tab");
    expect(
      (
        await f.call("a", "evaluate", {
          expression: "(() => { window.open('about:blank'); return 'opened'; })()",
        })
      ).isError,
    ).not.toBe(true);
    const a = structured(await f.call("a", "list_tabs"))?.tabs as unknown[];
    const b = structured(await f.call("b", "list_tabs"))?.tabs as unknown[];
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(f.operator.pages()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("stop_browser cannot stop another lane even with force, and list_lanes hides URLs", async () => {
  const f = await fixture();
  try {
    await f.call("a", "new_tab", { url: "data:text/html,secret-a" });
    await f.call("b", "new_tab", { url: "data:text/html,secret-b" });
    const stopped = await f.call("a", "stop_browser", { force: true });
    expect(stopped.isError).toBe(true);
    expect(text(stopped)).toContain("another lane");
    expect(text(stopped)).toContain("NOTE");
    const lanes = await f.call("a", "list_lanes");
    expect(text(lanes)).not.toContain("secret-");
    expect(structured(lanes)?.lanes).toHaveLength(2);
    await f.call("b", "close_lane");
    expect((await f.call("a", "stop_browser")).isError).not.toBe(true);
    expect(f.primary.isClosed()).toBe(false);
  } finally {
    await f.close();
  }
});

test("same-tab calls queue in order, different tabs and lanes pass a held barrier", async () => {
  const f = await fixture();
  try {
    const a = tab(await f.call("a", "new_tab"));
    const a2 = tab(await f.call("a", "new_tab"));
    const b = tab(await f.call("b", "new_tab"));
    const entered = barrier();
    const release = barrier();
    const order: string[] = [];
    f.handle.register({
      name: "queue_probe",
      title: "Queue Probe",
      description: "Test queue order",
      toolset: "core",
      inputSchema: { tabId: z.number(), label: z.string(), hold: z.boolean().optional() },
      annotations: {},
      handler: async ({ tabId, label, hold }) => {
        await f.mgr.getPage(tabId);
        order.push(label);
        if (hold) {
          entered.release();
          await release.promise;
        }
        return { content: [{ type: "text", text: label }] };
      },
    });
    const first = f.call("a", "queue_probe", { tabId: a, label: "first", hold: true });
    await entered.promise;
    const second = f.call("a", "queue_probe", { tabId: a, label: "second" });
    try {
      await f.call("a", "queue_probe", { tabId: a2, label: "other-tab" });
      await f.call("b", "queue_probe", { tabId: b, label: "other-lane" });
      expect(order).toEqual(["first", "other-tab", "other-lane"]);
    } finally {
      release.release();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["first", "other-tab", "other-lane", "second"]);
  } finally {
    await f.close();
  }
});

test("concurrent first callers create one Steel session and one context per caller", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.call("a", "new_tab"), f.call("b", "new_tab"), f.call("a", "new_tab")]);
    expect(f.starts()).toBe(1);
    expect(structured(await f.call("a", "list_tabs"))?.tabs).toHaveLength(2);
    expect(structured(await f.call("b", "list_tabs"))?.tabs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("idle clock closes whole lane, stale tabs stay closed, and explicit new_tab reopens", async () => {
  const f = await fixture();
  try {
    const a = tab(await f.call("a", "new_tab"));
    await f.call("a", "new_tab");
    const previousContext = f.contexts().find((context) => context !== f.operator)!;
    expect(previousContext.pages()).toHaveLength(2);
    f.advance(101);
    const fresh = await f.call("a", "list_tabs");
    expect(text(fresh)).toContain("Previous lane closed (idle)");
    expect(text(fresh)).toContain("cookies, tabs and buffers were reset.");
    expect(fresh.isError).not.toBe(true);
    expect(previousContext.pages()).toHaveLength(0);
    await expect(previousContext.newPage()).rejects.toThrow();
    expect(text(await f.call("a", "evaluate", { tabId: a, expression: "1" }))).toContain(
      "lane_closed",
    );
    const reopened = tab(await f.call("a", "new_tab"));
    expect(reopened).not.toBe(a);
    expect(text(await f.call("a", "evaluate", { tabId: a, expression: "1" }))).toContain(
      "lane_closed",
    );
    expect(f.primary.isClosed()).toBe(false);
  } finally {
    await f.close();
  }
});

test("unknown numeric tab after MCP restart returns lane_closed instead of recovering it", async () => {
  const f = await fixture();
  try {
    expect(text(await f.call("a", "evaluate", { tabId: 99999, expression: "1" }))).toContain(
      "lane_closed",
    );
    expect(f.operator.pages()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("STEEL_LANES off preserves caller-free shared tabs and legacy owner guards", async () => {
  const f = await fixture("off");
  try {
    const id = tab(await f.call(undefined, "new_tab", { owner: "old" }));
    const denied = await f.call("b", "evaluate", { tabId: id, expression: "1" });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("owner");
    expect(
      (await f.call("b", "evaluate", { tabId: id, force: true, expression: "1" })).isError,
    ).not.toBe(true);
    expect(structured(await f.call(undefined, "list_tabs"))?.tabs).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("queued implicit targeting stays on the admitted tab when new_tab changes current", async () => {
  const f = await fixture();
  const entered = barrier();
  const release = barrier();
  try {
    const a = tab(await f.call("a", "new_tab"));
    f.handle.register({
      name: "implicit_probe",
      title: "Implicit Probe",
      description: "Check admitted target",
      toolset: "core",
      inputSchema: { hold: z.boolean().optional() },
      annotations: {},
      handler: async ({ hold }) => {
        if (hold) {
          entered.release();
          await release.promise;
        }
        await f.mgr.getPage({});
        return { content: [{ type: "text", text: String(f.mgr.resolveTab({})) }] };
      },
    });
    const first = f.call("a", "implicit_probe", { hold: true });
    await entered.promise;
    const second = f.call("a", "implicit_probe");
    await f.call("a", "new_tab");
    release.release();
    expect(text(await second)).toContain(String(a));
    expect(text(await first)).toContain(String(a));
  } finally {
    release.release();
    await f.close();
  }
});

test("console read and clear affect only the caller lane", async () => {
  const f = await fixture();
  try {
    f.handle.register({
      name: "console_probe",
      title: "Console Probe",
      description: "Inject a console event",
      toolset: "core",
      inputSchema: { message: z.string() },
      annotations: {},
      handler: async ({ message }) => {
        const page = await f.mgr.getPage();
        (page as unknown as { emit(event: string, data: unknown): void }).emit("console", {
          type: () => "log",
          text: () => message,
          location: () => ({ url: "", lineNumber: 0, columnNumber: 0 }),
        });
        return { content: [] };
      },
    });
    await f.call("a", "console_probe", { message: "only-a" });
    await f.call("b", "console_probe", { message: "only-b" });
    const a = await f.call("a", "get_console", { clear: true });
    expect(text(a)).toContain("only-a");
    expect(text(a)).not.toContain("only-b");
    expect(text(await f.call("a", "get_console"))).not.toContain("only-a");
    expect(text(await f.call("b", "get_console"))).toContain("only-b");
  } finally {
    await f.close();
  }
});

test("network requests and response bodies stay within the caller lane", async () => {
  const f = await fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(new URL(request.url).pathname, { headers: { "content-type": "text/html" } }),
  });
  try {
    await f.call("a", "new_tab", { url: `http://127.0.0.1:${server.port}/only-a` });
    await f.call("b", "new_tab", { url: `http://127.0.0.1:${server.port}/only-b` });
    const a = await f.call("a", "get_network");
    const b = await f.call("b", "get_network");
    expect(text(a)).toContain("only-a");
    expect(text(a)).not.toContain("only-b");
    expect(text(b)).toContain("only-b");
    expect(text(b)).not.toContain("only-a");
    expect(
      text(await f.call("b", "get_network", { body: true, urlPattern: "only-a" })),
    ).not.toContain('"body"');
  } finally {
    server.stop(true);
    await f.close();
  }
});

test("close_lane drains admitted calls and does not admit new work into its closing context", async () => {
  const f = await fixture();
  const entered = barrier();
  const release = barrier();
  try {
    const a = tab(await f.call("a", "new_tab"));
    f.handle.register({
      name: "closing_probe",
      title: "Closing Probe",
      description: "Hold a lane operation",
      toolset: "core",
      inputSchema: { tabId: z.number() },
      annotations: {},
      handler: async () => {
        entered.release();
        await release.promise;
        const page = await f.mgr.getPage(a);
        return { content: [{ type: "text", text: String(page.isClosed()) }] };
      },
    });
    const pending = f.call("a", "closing_probe", { tabId: a });
    await entered.promise;
    const closing = f.call("a", "close_lane");
    const rejected = await f.call("a", "evaluate", { tabId: a, expression: "1" });
    expect(text(rejected)).toContain("lane_closed");
    release.release();
    expect(text(await pending)).toContain("false");
    expect((await closing).isError).not.toBe(true);
    const fresh = await f.call("a", "new_tab");
    expect(text(fresh)).toContain("Previous lane closed (close_lane)");
  } finally {
    release.release();
    await f.close();
  }
});

test("new_tab holds its new page queue until navigation and tool completion", async () => {
  const f = await fixture();
  const entered = barrier();
  const release = barrier();
  const order: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      entered.release();
      await release.promise;
      return new Response("<title>Ready</title>");
    },
  });
  try {
    f.handle.register({
      name: "creation_probe",
      title: "Creation Probe",
      description: "Check new page queue",
      toolset: "core",
      inputSchema: { tabId: z.number().optional(), label: z.string() },
      annotations: {},
      handler: async ({ label }) => {
        order.push(label);
        return { content: [] };
      },
    });
    const creating = f.call("a", "new_tab", { url: `http://127.0.0.1:${server.port}/` });
    await entered.promise;
    const rows = structured(await f.call("a", "list_tabs"))?.tabs as Array<{ tabId: number }>;
    const probe = f.call("a", "creation_probe", { tabId: rows[0]!.tabId, label: "new-page" });
    await f.call("b", "creation_probe", { label: "other-lane" });
    try {
      expect(order).toEqual(["other-lane"]);
    } finally {
      release.release();
      await Promise.all([creating, probe]);
    }
    expect(order).toEqual(["other-lane", "new-page"]);
  } finally {
    release.release();
    server.stop(true);
    await f.close();
  }
});

test("saved profile restoration targets the lane context without adding a profile context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steel-lane-profile-"));
  const f = await fixture("on", { PROFILES_DIR: directory });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<title>Profile</title>"),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await writeFile(
      join(directory, "saved.json"),
      JSON.stringify({
        cookies: [{ name: "profile-cookie", value: "saved-value", domain: "127.0.0.1", path: "/" }],
        localStorage: { [origin]: { restored: "saved-local" } },
        savedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const ordinary = tab(await f.call("a", "new_tab"));
    await f.call("b", "new_tab");
    const before = f.contexts().length;
    const profileTab = tab(await f.call("a", "new_tab", { profile: "saved", url: origin }));
    expect(f.contexts()).toHaveLength(before);
    expect(text(await f.call("a", "cookies"))).toContain("saved-value");
    expect(
      text(
        await f.call("a", "evaluate", {
          tabId: profileTab,
          expression: "localStorage.getItem('restored')",
        }),
      ),
    ).toContain("saved-local");
    expect(structured(await f.call("b", "cookies"))).toEqual({ cookies: [] });
    const profiles = structured(await f.call(undefined, "list_profiles"))?.profiles as Array<
      Record<string, unknown>
    >;
    expect(profiles).toContainEqual({
      name: "saved",
      active: true,
      tabCount: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await f.call("a", "delete_profile", { name: "saved" })).isError).not.toBe(true);
    expect(f.contexts()).toHaveLength(before);
    expect((await f.call("a", "evaluate", { tabId: ordinary, expression: "1" })).isError).not.toBe(
      true,
    );
  } finally {
    server.stop(true);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CAPTCHA extension waits and solve_captcha inspect only the caller's page", async () => {
  const f = await fixture();
  try {
    const html =
      '<div class="g-recaptcha" data-sitekey="lane-a-public"></div><textarea name="g-recaptcha-response"></textarea><button id="capsolver-solver-tip-button" data-state="solving"></button>';
    const a = tab(
      await f.call("a", "new_tab", { url: `data:text/html,${encodeURIComponent(html)}` }),
    );
    const b = tab(await f.call("b", "new_tab"));
    const pageA = f
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("lane-a-public"))!;
    const solving = f.call("a", "solve_captcha", { tabId: a, timeoutMs: 3000 });
    await pageA.waitForFunction(() => Boolean(window.__steelCaptchaSignal), undefined, {
      timeout: 2000,
    });
    const other = await f.call("b", "solve_captcha", { tabId: b, timeoutMs: 500 });
    expect(text(other)).toContain("none detected");
    await pageA.evaluate(
      () => {
        (document.querySelector("textarea") as HTMLTextAreaElement).value =
          "synthetic-private-token";
      },
      undefined,
      undefined,
      false,
    );
    const solved = await solving;
    expect(solved.isError).not.toBe(true);
    expect(text(solved)).toContain("lane-a-public");
    expect(text(solved)).toContain("solved");
    expect(text(solved)).not.toContain("synthetic-private-token");
    expect(text(await f.call("b", "solve_captcha", { tabId: a, timeoutMs: 500 }))).toContain(
      "not_in_lane",
    );
  } finally {
    await f.close();
  }
});

test("lane defaults validate the rollback switch and the idle lease", () => {
  expect(EnvSchema.parse({ BROWSER_MODE: "local" }).STEEL_LANES).toBe("on");
  expect(EnvSchema.parse({ BROWSER_MODE: "local" }).LANE_IDLE_MS).toBe(900000);
  expect(() => EnvSchema.parse({ BROWSER_MODE: "local", STEEL_LANES: "invalid" })).toThrow();
  expect(() => EnvSchema.parse({ BROWSER_MODE: "local", LANE_IDLE_MS: "0" })).toThrow();
});

test("queued close_tabs without a target closes the admitted current tab, not a newer tab", async () => {
  const f = await fixture();
  const entered = barrier();
  const release = barrier();
  try {
    const a = tab(await f.call("a", "new_tab"));
    f.handle.register({
      name: "close_target_probe",
      title: "Close Target Probe",
      description: "Hold the current tab",
      toolset: "core",
      inputSchema: {},
      annotations: {},
      handler: async () => {
        entered.release();
        await release.promise;
        return { content: [] };
      },
    });
    const held = f.call("a", "close_target_probe");
    await entered.promise;
    const closing = f.call("a", "close_tabs");
    const b = tab(await f.call("a", "new_tab"));
    release.release();
    await Promise.all([held, closing]);
    const rows = structured(await f.call("a", "list_tabs"))?.tabs as Array<{ tabId: number }>;
    expect(rows.map((row) => row.tabId)).toEqual([b]);
    expect(text(await f.call("a", "evaluate", { tabId: a, expression: "1" }))).toContain(
      "lane_closed",
    );
  } finally {
    release.release();
    await f.close();
  }
});

test("browser disconnect closes every lane and single-flights a fresh session with session-ended notices", async () => {
  const f = await fixture();
  try {
    const a = tab(await f.call("a", "new_tab"));
    const b = tab(await f.call("b", "new_tab"));
    await f.endSession();
    expect(text(await f.call("a", "evaluate", { tabId: a, expression: "1" }))).toContain(
      "lane_closed",
    );
    expect(text(await f.call("b", "evaluate", { tabId: b, expression: "1" }))).toContain(
      "lane_closed",
    );
    const [reopenedA, reopenedB] = await Promise.all([
      f.call("a", "new_tab"),
      f.call("b", "new_tab"),
    ]);
    expect(text(reopenedA)).toContain("Previous lane closed (session-ended)");
    expect(text(reopenedB)).toContain("Previous lane closed (session-ended)");
    expect(tab(reopenedA)).toBeGreaterThan(a);
    expect(tab(reopenedB)).toBeGreaterThan(b);
    expect(f.starts()).toBe(2);
    expect(f.primary.isClosed()).toBe(false);
    expect(f.contexts()).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 20000);

test("a new MCP registry cannot alias an old tab ID even when wall-clock time is unchanged", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1800000000000);
  let first: Awaited<ReturnType<typeof fixture>> | undefined;
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    first = await fixture();
    const previous = tab(await first.call("a", "new_tab"));
    await first.close();
    first = undefined;
    second = await fixture();
    const current = tab(await second.call("a", "new_tab"));
    expect(current).toBeGreaterThan(previous);
    expect(
      text(await second.call("a", "evaluate", { tabId: previous, expression: "1" })),
    ).toContain("lane_closed");
  } finally {
    await first?.close();
    await second?.close();
    clock.mockRestore();
  }
}, 20000);

test("owner labels do not restrict own-lane interception, response bodies, or HAR export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steel-lane-har-"));
  const f = await fixture("on", { OUTPUT_DIR: directory });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("lane-response"),
  });
  try {
    const id = tab(
      await f.call("a", "new_tab", {
        url: `http://127.0.0.1:${server.port}/lane-body`,
        owner: "label-only",
      }),
    );
    expect((await f.call("a", "intercept", { tabId: id, action: "list" })).isError).not.toBe(true);
    const body = await f.call("a", "get_network", { urlPattern: "/lane-body", body: true });
    expect(body.isError).not.toBe(true);
    expect(structured(body)?.body).toBe("lane-response");
    const har = await f.call("a", "export_har");
    expect(har.isError).not.toBe(true);
    expect(await readFile(join(directory, "network.har"), "utf8")).toContain("/lane-body");
  } finally {
    server.stop(true);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
