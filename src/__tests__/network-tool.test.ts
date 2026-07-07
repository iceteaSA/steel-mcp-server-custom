import { describe, it, expect } from "bun:test";
import { register as registerNetwork } from "../tools/network.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar } from "../tools/shared.js";

const env: Env = {
  MAX_INLINE_BYTES: 1000,
  OUTPUT_DIR: "/tmp",
  OUTPUT_ROOT: "/tmp",
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
  ownerMap: Record<number, string> = {},
): BrowserManager {
  return {
    resolveTab: () => resolvedTabId,
    getNetworkEvents: (filter: any) => {
      let result = events.slice();
      if (filter.tabId !== undefined) {
        result = result.filter((e) => e.tabId === filter.tabId);
      }
      if (filter.owner) {
        // Owner filter: invert the ownerMap to find tabIds owned by `filter.owner`.
        const owned = Object.entries(ownerMap)
          .filter(([, o]) => o === filter.owner)
          .map(([id]) => Number(id));
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
    getTabOwner: (tabId: number) => ownerMap[tabId],
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

  // SEC3 — requestId cross-tab body leak: an agent must NEVER be able to
  // read another owner's response body. Rule (see tools/network.ts):
  //   * event.tabId undefined  → untabbed, always readable when it survived
  //                              the list filter (no owning tab to guard)
  //   * event.tabId set, owner matches caller's owner → allowed
  //   * event.tabId set, owner undefined (unowned tab) → allowed
  //   * event.tabId set, owner != caller's owner     → DENIED, even when
  //                                                    caller passes the
  //                                                    correct tabId — only
  //                                                    owner matches; a bare
  //                                                    tabId does not authorize
  //                                                    reading an owned tab's body.
  it("denies requestId body fetch when no scope given AND event belongs to another owner's tab", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 42,
          tabId: 9,
          method: "GET",
          url: "https://other-agent/x",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 42: "AUTH-TOKEN-LEAK" },
      1, // caller's resolved tab (irrelevant — caller passes no tabId/owner)
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({ requestId: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to owner "owner-B"/);
    expect(result.content[0].text).not.toContain("AUTH-TOKEN-LEAK");
  });

  // Residual hole: tabId alone must NOT authorize reading another owner's
  // tab body — attacker reads the unscoped list to learn owner B's tabId,
  // then asks for the body with only that tabId. Body must remain denied.
  it("denies requestId body fetch when caller passes B's tabId but no owner", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 50,
          tabId: 9,
          method: "GET",
          url: "https://other-agent/x",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 50: "owned-body" },
      9,
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({
      requestId: 50,
      tabId: 9,
      // owner intentionally omitted — the attacker only knows the tabId.
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/body fetch requires owner:"owner-B"/);
    expect(result.content[0].text).not.toContain("owned-body");
  });

  // Positive: the owning agent can read its own body with a matching owner.
  it("allows requestId body fetch when owner matches the event's tab owner", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 50,
          tabId: 9,
          method: "GET",
          url: "https://my-agent/x",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 50: "owned-body" },
      9,
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({
      requestId: 50,
      tabId: 9,
      owner: "owner-B",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("owned-body");
  });
});
