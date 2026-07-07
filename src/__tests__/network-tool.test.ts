import { describe, it, expect } from "bun:test";
import { register as registerNetwork } from "../tools/network.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar } from "../tools/shared.js";

const env: Env = {
  MAX_INLINE_BYTES: 1000,
  OUTPUT_DIR: "/tmp",
} as Env;

function makeRegistrar() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const register = ((opts: any) => {
    handlers[opts.name] = opts.handler;
  }) as ToolRegistrar;
  return { register, handlers };
}

function fakeMgr(
  events: any[],
  bodies: Record<number, string> = {},
  resolvedTabId = 1,
): BrowserManager {
  return {
    resolveTab: () => resolvedTabId,
    getNetworkEvents: (filter: any) => {
      let result = events.slice();
      if (filter.tabId !== undefined) {
        result = result.filter((e) => e.tabId === filter.tabId);
      }
      if (filter.owner) {
        // Stub owner filter: owner "A" owns tabId 1, owner "B" owns tabId 2.
        const owned = filter.owner === "A" ? [1] : filter.owner === "B" ? [2] : [];
        result = result.filter((e) => owned.includes(e.tabId));
      }
      if (filter.urlPattern) {
        // Substring only for the stub; regex validation is tested in helpers.
        result = result.filter((e) => e.url.includes(filter.urlPattern));
      }
      if (filter.resourceType) {
        result = result.filter((e) => e.resourceType === filter.resourceType);
      }
      const limit = filter.limit ?? 30;
      if (limit > 0 && result.length > limit) {
        result = result.slice(-limit);
      }
      return result;
    },
    getResponseBody: async (id: number) => {
      if (!(id in bodies)) throw new Error("body no longer available");
      return bodies[id];
    },
    dialogNotice: () => "",
    setTabLastUrl: () => {},
  } as unknown as BrowserManager;
}

describe("get_network tool", () => {
  it("returns isError for an invalid regex urlPattern", async () => {
    const { register, handlers } = makeRegistrar();
    registerNetwork(register, fakeMgr([]), env);
    const result = await handlers.get_network({ urlPattern: "/[" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid regex:/);
  });

  it("returns a clean body for a single matching event", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [{ id: 5, tabId: 1, method: "GET", url: "https://api/x", resourceType: "xhr", status: 200 }],
      { 5: "xhr-body" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({ body: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("xhr-body");
  });

  it("returns isError when body:true matches multiple events", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr([
      { id: 1, tabId: 1, method: "GET", url: "https://a/1", resourceType: "xhr" },
      { id: 2, tabId: 1, method: "GET", url: "https://a/2", resourceType: "xhr" },
    ]);
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({ body: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("2 matches");
  });

  it("denies requestId that is not in the caller's scoped events", async () => {
    const { register, handlers } = makeRegistrar();
    // Owner A only sees tabId 1; event id 99 belongs to tabId 2.
    const mgr = fakeMgr(
      [
        {
          id: 99,
          tabId: 2,
          method: "GET",
          url: "https://other/tab",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 99: "secret" },
      1,
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({ owner: "A", requestId: 99 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requestId 99 not found in your tabs");
  });

  it("allows untabbed events only when no owner/tabId filter is in play", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 7,
          tabId: undefined,
          method: "GET",
          url: "https://untabbed/x",
          resourceType: "fetch",
          status: 200,
        },
      ],
      { 7: "untabbed-body" },
      1,
    );
    registerNetwork(register, mgr, env);
    const allowed = await handlers.get_network({ requestId: 7 });
    expect(allowed.isError).toBeUndefined();
    expect(allowed.content[0].text).toBe("untabbed-body");

    const denied = await handlers.get_network({ owner: "A", requestId: 7 });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("requestId 7 not found in your tabs");
  });
});
