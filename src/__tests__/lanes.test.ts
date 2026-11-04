import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "patchright";
import { z } from "zod";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(mode = "on") {
  const browser = await chromium.launch({
    executablePath: "/home/icetea/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  let now = 1000;
  let starts = 0;
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: mode,
    LANE_IDLE_MS: "100",
    TAB_IDLE_TIMEOUT_MS: "0",
    SETTLE_TIMEOUT_MS: "0",
    RELAY_PORT: "0",
  });
  const root = new BrowserManager(env);
  const operator = await browser.newContext();
  const primary = await operator.newPage();
  const startGate = barrier();
  startGate.release();
  Object.assign(root, {
    _connectSteel: async () => {
      starts++;
      await startGate.promise;
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
    operator,
    primary,
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
    expect((await f.call("a", "list_tabs")).structuredContent?.tabs).toMatchObject([
      { tabId: a, active: true },
    ]);
    expect(
      (await f.call("a", "evaluate", { tabId: a, owner: "different", expression: "1" })).isError,
    ).not.toBe(true);
    expect(f.primary.isClosed()).toBe(false);
  } finally {
    await f.close();
  }
});

test("popups remain in their context lane and the operator context is never adopted", async () => {
  const f = await fixture();
  try {
    await f.call("a", "new_tab");
    await f.call("b", "new_tab");
    await f.call("a", "evaluate", { expression: "window.open('about:blank'); 'opened'" });
    const a = (await f.call("a", "list_tabs")).structuredContent?.tabs as unknown[];
    const b = (await f.call("b", "list_tabs")).structuredContent?.tabs as unknown[];
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
    expect(lanes.structuredContent?.lanes).toHaveLength(2);
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
    expect((await f.call("a", "list_tabs")).structuredContent?.tabs).toHaveLength(2);
    expect((await f.call("b", "list_tabs")).structuredContent?.tabs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("idle clock closes whole lane, stale tabs stay closed, and explicit new_tab reopens", async () => {
  const f = await fixture();
  try {
    const a = tab(await f.call("a", "new_tab"));
    await f.call("a", "new_tab");
    f.advance(101);
    const fresh = await f.call("a", "list_tabs");
    expect(text(fresh)).toContain("Previous lane closed (idle)");
    expect(text(fresh)).toContain("cookies, tabs and buffers were reset.");
    expect(fresh.isError).not.toBe(true);
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
    expect((await f.call(undefined, "list_tabs")).structuredContent?.tabs).toHaveLength(2);
  } finally {
    await f.close();
  }
});
