import { expect, test, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "patchright";
import { z } from "zod";
import { link, mkdir, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumPath, retainedBrowserCount, bun13 } from "./browser-processes.js";
import { barrier, pageValue } from "./helpers.js";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";

async function fixture(mode = "on", overrides: Record<string, string> = {}) {
  const launchOptions = {
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  };
  const launch = async () => {
    const retainedBefore = retainedBrowserCount();
    const browser = await chromium.launch(launchOptions);
    if (bun13()) expect(retainedBrowserCount()).toBe(retainedBefore + 1);
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

for (const mode of ["on", "off"] as const) {
  for (const vector of [
    "evaluate-profile",
    "evaluate-credentials",
    "evaluate-new",
    "screenshot",
    "upload-credentials",
    "upload-profile",
    "upload-topic",
    "upload-aliases",
    "upload-directory",
    "download-credentials",
    "download-traversal",
  ] as const) {
    test(`reserved store tools: ${mode} ${vector}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "reserved-tool-"));
      const separate = vector === "download-traversal";
      const output = separate ? join(root, "out") : root;
      const profiles = join(root, "profiles");
      const credentials = join(root, "credentials.json");
      const topic = join(root, "notify.topic");
      const f = await fixture(mode, {
        OUTPUT_DIR: output,
        ...(separate ? { PROFILES_DIR: profiles, CREDENTIALS_FILE: credentials } : {}),
        STEEL_NTFY_TOPIC_FILE: topic,
      });
      const profile = join(profiles, "x.json");
      const site = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          if (new URL(request.url).pathname === "/download")
            return new Response("download-body", {
              headers: {
                "Content-Disposition": `attachment; filename="${separate ? "../profiles/x.json" : "credentials.json"}"`,
                "Content-Type": "application/octet-stream",
              },
            });
          return new Response(
            '<input id="file" type="file"><input id="folder" type="file" webkitdirectory>',
            { headers: { "Content-Type": "text/html" } },
          );
        },
      });
      try {
        await mkdir(output, { recursive: true });
        await mkdir(profiles, { recursive: true });
        for (const file of [profile, credentials, topic])
          await writeFile(file, "SERVER_ONLY_CANARY");
        const id = tab(await f.call("a", "new_tab", { url: site.url.origin }));
        let result: Awaited<ReturnType<typeof f.call>>;
        if (vector.startsWith("evaluate")) {
          const target =
            vector === "evaluate-profile"
              ? profile
              : vector === "evaluate-credentials"
                ? credentials
                : join(profiles, "new", "x.json");
          result = await f.call("a", "evaluate", {
            tabId: id,
            expression: "({cookies: []})",
            outputMode: "file",
            outputPath: target,
          });
        } else if (vector === "screenshot") {
          result = await f.call("a", "get_screenshot", {
            tabId: id,
            outputMode: "file",
            outputPath: join(profiles, "image.png"),
          });
        } else if (vector.startsWith("upload")) {
          let paths = [
            vector === "upload-profile" ? profile : vector === "upload-topic" ? topic : credentials,
          ];
          if (vector === "upload-aliases") {
            await symlink(credentials, join(output, "alias.json"));
            await link(profile, join(output, "linked.json"));
            paths = [join(output, "alias.json"), join(output, "linked.json")];
          }
          if (vector === "upload-directory") paths = [root];
          result = await f.call("a", "upload_file", {
            tabId: id,
            selector: vector === "upload-directory" ? "#folder" : "#file",
            files: paths,
          });
        } else {
          if (separate)
            for (const context of f.contexts())
              context.on("page", (page) =>
                page.on("download", (download) => {
                  spyOn(download, "suggestedFilename").mockReturnValue("../profiles/x.json");
                }),
              );
          result = await f.call("a", "download_file", { url: `${site.url.origin}/download` });
        }
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("reserved_store");
        expect(text(result)).not.toContain("SERVER_ONLY_CANARY");
        for (const file of [profile, credentials, topic])
          expect(await readFile(file, "utf8")).toBe("SERVER_ONLY_CANARY");
        expect(await Bun.file(join(profiles, "new", "x.json")).exists()).toBe(false);
        expect(await Bun.file(join(profiles, "image.png")).exists()).toBe(false);
        if (vector.startsWith("upload"))
          expect(
            text(
              await f.call("a", "evaluate", {
                tabId: id,
                expression: "document.querySelector('input').files.length",
              }),
            ),
          ).toContain('"result":0');
      } finally {
        site.stop(true);
        await f.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("one bound profile per lane refuses X1 alias mixing and never passes alpha state to beta", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-profile-bound-"));
  const f = await fixture("on", { PROFILES_DIR: directory });
  const beta = JSON.stringify({
    cookies: [{ name: "beta_token", value: "BETA_SECRET", domain: "example.test", path: "/" }],
  });
  try {
    await writeFile(join(directory, "beta.json"), beta);
    expect((await f.call("a", "new_tab", { profile: "alpha" })).isError).not.toBe(true);
    await f.call("a", "cookies", {
      setCookies: [
        { name: "alpha_token", value: "ALPHA_SECRET", domain: "example.test", path: "/" },
      ],
    });
    for (const [name, args] of [
      ["new_tab", { profile: "beta" }],
      ["create_profile", { name: "beta" }],
      ["save_profile", { name: "beta" }],
      ["delete_profile", { name: "beta", removeSaved: true }],
    ] as const) {
      const result = await f.call("a", name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("lane_profile_conflict");
      expect(text(result)).toContain("alpha");
      expect(text(result)).not.toContain("beta");
      expect(text(result)).toContain("close_lane");
      expect(text(result)).toContain("another lane");
    }
    expect(await readFile(join(directory, "beta.json"), "utf8")).toBe(beta);
    expect((await f.call("a", "new_tab", { profile: "alpha" })).isError).not.toBe(true);
    expect((await f.call("a", "create_profile", { name: "alpha" })).isError).not.toBe(true);
    expect(await f.handle.applyProfileUpdated("beta")).toBe(false);
    expect(text(await f.call("a", "cookies"))).not.toContain("BETA_SECRET");
    expect((await f.call("a", "save_profile", { name: "alpha" })).isError).not.toBe(true);
    expect(await readFile(join(directory, "alpha.json"), "utf8")).not.toContain("BETA_SECRET");
    await f.call("a", "close_lane");
    expect((await f.call("b", "new_tab", { profile: "beta" })).isError).not.toBe(true);
    const seen = text(await f.call("b", "cookies"));
    expect(seen).toContain("BETA_SECRET");
    expect(seen).not.toContain("ALPHA_SECRET");
    expect((await f.call("b", "save_profile", { name: "beta" })).isError).not.toBe(true);
    expect(await readFile(join(directory, "beta.json"), "utf8")).not.toContain("ALPHA_SECRET");
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile leases exclude another lane and release on close, idle, and browser loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lease-"));
  const f = await fixture("on", { PROFILES_DIR: directory, LANE_IDLE_MS: "10000" });
  try {
    expect((await f.call("secret-session-a", "use_profile", { name: "shared" })).isError).not.toBe(true);
    const busy = text(await f.call("b", "new_tab", { profile: "shared" }));
    expect(busy).toContain("profile_busy");
    expect(busy).toContain("ageSeconds");
    expect(busy).not.toContain("secret-session-a");
    expect(text(await f.call("b", "use_profile", { name: "shared", wait: 0.01 }))).toContain("profile_busy");
    const waiting = f.call("b", "use_profile", { name: "shared", wait: 2 });
    await f.call("secret-session-a", "close_lane");
    expect((await waiting).isError).not.toBe(true);
    await f.call("b", "close_lane");
    expect((await f.call("c", "use_profile", { name: "shared" })).isError).not.toBe(true);
    f.advance(10001);
    expect((await f.call("d", "use_profile", { name: "shared" })).isError).not.toBe(true);
    await f.endSession();
    expect((await f.call("e", "use_profile", { name: "shared" })).isError).not.toBe(true);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile autosave is opt-in and save requires a lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lease-save-"));
  const f = await fixture("on", { PROFILES_DIR: directory });
  try {
    expect(text(await f.call("a", "save_profile", { name: "shared" }))).toContain("profile_lease_required");
    for (const autosave of [false, true]) {
      expect((await f.call("a", "use_profile", { name: "shared", autosave })).isError).not.toBe(true);
      await f.call("a", "cookies", { setCookies: [{ name: "token", value: "CANARY", domain: "example.test", path: "/" }] });
      await f.call("a", "close_lane");
      const file = Bun.file(join(directory, "shared.json"));
      expect(await file.exists()).toBe(autosave);
      if (autosave) expect(await file.text()).toContain("CANARY");
    }
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a deleted profile stays bound to its live lane context and concurrent profile opens cannot mix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-profile-sticky-"));
  const f = await fixture("on", { PROFILES_DIR: directory });
  try {
    const results = await Promise.all([
      f.call("a", "new_tab", { profile: "alpha" }),
      f.call("a", "new_tab", { profile: "beta" }),
    ]);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    const held = results[0].isError ? "beta" : "alpha";
    const other = held === "alpha" ? "beta" : "alpha";
    expect((await f.call("a", "delete_profile", { name: held })).isError).not.toBe(true);
    expect(text(await f.call("a", "new_tab", { profile: other }))).toContain(
      "lane_profile_conflict",
    );
    await f.call("a", "close_lane");
    expect((await f.call("a", "new_tab", { profile: other })).isError).not.toBe(true);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a lane during a profile wait cancels acquisition without leaking a lease", async () => {
  const f = await fixture("on", { LANE_DRAIN_MS: "10" });
  try {
    expect((await f.call("a", "use_profile", { name: "contended" })).isError).not.toBe(true);
    await f.call("b", "new_tab");
    const waiting = f.call("b", "use_profile", { name: "contended", wait: 2 });
    await f.call("b", "close_lane");
    expect(text(await waiting)).toContain("lane_closed");
    await f.call("a", "close_lane");
    expect((await f.call("c", "use_profile", { name: "contended" })).isError).not.toBe(true);
  } finally { await f.close(); }
});

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
    const cookies = structured(await f.call("a", "cookies"))?.cookies as Array<{ value: unknown }>;
    expect(cookies).toHaveLength(1);
    expect(JSON.stringify(pageValue(cookies[0].value, "cookies"))).toBe('"a"');
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
    const profiles = structured(await f.call("a", "list_profiles"))?.profiles as Array<
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
    expect(pageValue(structured(body)?.body, "get_network")).toBe("lane-response");
    const har = await f.call("a", "export_har");
    expect(har.isError).not.toBe(true);
    expect(await readFile(join(directory, "network.har"), "utf8")).toContain("/lane-body");
  } finally {
    server.stop(true);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real Chromium: a looping evaluate is interrupted by bounded lane closure", async () => {
  const f = await fixture("on", { LANE_DRAIN_MS: "30", LANE_IDLE_MS: "100000" });
  const entered = barrier();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      entered.release();
      return new Response("ready");
    },
  });
  let running: ReturnType<typeof f.call> | undefined;
  let closing: ReturnType<typeof f.call> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const a = tab(await f.call("a", "new_tab"));
    const b = tab(await f.call("b", "new_tab"));
    running = f.call("a", "evaluate", {
      tabId: a,
      expression: `(() => { fetch("http://127.0.0.1:${server.port}/entered"); while (true) {} })()`,
    });
    await Promise.race([
      entered.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("looping page did not enter the handler")), 1800);
      }),
    ]);
    clearTimeout(timer);
    closing = f.call("a", "close_lane");
    const result = await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("looping page prevented lane closure")), 1800);
      }),
    ]);
    expect(result.isError).not.toBe(true);
    expect((await running).isError).toBe(true);
    expect(f.primary.isClosed()).toBe(false);
    expect((await f.call("b", "evaluate", { tabId: b, expression: "2" })).isError).not.toBe(true);
    expect(tab(await f.call("a", "new_tab"))).not.toBe(a);
  } finally {
    clearTimeout(timer);
    await f.endSession();
    await Promise.allSettled([running, closing].filter((p) => p !== undefined));
    server.stop(true);
    await f.close();
  }
}, 20000);

test("list_profiles reports only the caller's active profile usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steel-r1-profile-"));
  const f = await fixture("on", { PROFILES_DIR: directory });
  try {
    await f.call("a", "create_profile", { name: "shared" });
    await f.call("a", "save_profile", { name: "shared" });
    const own = structured(await f.call("a", "list_profiles"))?.profiles as Array<{
      name: string;
      active: boolean;
      tabCount: number;
    }>;
    expect(own.find((p) => p.name === "shared")).toMatchObject({ active: true, tabCount: 1 });
    for (const caller of ["b", undefined]) {
      const other = structured(await f.call(caller, "list_profiles"))?.profiles as Array<{
        name: string;
        active: boolean;
        tabCount: number;
      }>;
      expect(other.find((p) => p.name === "shared")).toMatchObject({ active: false, tabCount: 0 });
      expect(JSON.stringify(other)).not.toContain("holder");
    }
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential mutations require identity and audit only operation and caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steel-r1-credentials-"));
  const f = await fixture("on", { CREDENTIALS_FILE: join(directory, "credentials.json") });
  const audit = spyOn(console, "error").mockImplementation(() => {});
  const canary = "R1-CANARY-NAME";
  const value = "R1-CANARY-VALUE";
  const write = {
    name: canary,
    username: "R1-CANARY-USER",
    password: value,
    url: "https://canary.invalid",
  };
  try {
    expect(text(await f.call(undefined, "credentials", write))).toContain("no_caller");
    expect(structured(await f.call(undefined, "credentials"))?.credentials).toEqual([]);
    expect((await f.call("actor-a", "credentials", write)).isError).not.toBe(true);
    expect(text(await f.call(undefined, "credentials", { name: canary, remove: true }))).toContain(
      "no_caller",
    );
    expect(structured(await f.call(undefined, "credentials"))?.credentials).toHaveLength(1);
    expect(
      (await f.call("actor-a", "credentials", { name: canary, remove: true })).isError,
    ).not.toBe(true);
    const lines = audit.mock.calls
      .map((args) => args.join(" "))
      .filter((line) => line.includes("credentials."));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ caller: "actor-a" });
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(["caller", "event"]);
      expect(line).not.toContain(canary);
      expect(line).not.toContain(value);
      expect(line).not.toContain("canary.invalid");
      expect(line).not.toContain("R1-CANARY-USER");
    }
    expect(f.starts()).toBe(0);
  } finally {
    audit.mockRestore();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("another lane's request/response reference cannot fetch its body", async () => {
  const f = await fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("A-RESPONSE-CANARY"),
  });
  try {
    await f.call("a", "new_tab", { url: `http://127.0.0.1:${server.port}/a-only` });
    await f.call("b", "new_tab");
    const response = structured(
      await f.call("a", "get_network", { urlPattern: "/a-only", body: true }),
    );
    expect(pageValue(response?.body, "get_network")).toBe("A-RESPONSE-CANARY");
    expect(typeof response?.requestId).toBe("number");
    const foreign = await f.call("b", "get_network", { requestId: response?.requestId });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).not.toContain("A-RESPONSE-CANARY");
  } finally {
    server.stop(true);
    await f.close();
  }
});
