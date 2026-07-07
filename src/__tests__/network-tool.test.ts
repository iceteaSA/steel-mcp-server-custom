import { describe, it, expect } from "bun:test";
import { register as registerNetwork, authorizeBodyFetch } from "../tools/network.js";
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

  // SEC3 — single owner-auth chokepoint (tools/network.ts:authorizeBodyFetch).
  // Every body fetch — requestId OR body:true single-match — must pass through
  // it before mgr.getResponseBody. The rule (intentionally narrow — a bare
  // tabId is NEVER authorization):
  //   * event.tabId undefined (untabbed)  → readable
  //   * owner undefined for the tab       → readable (unowned tab)
  //   * caller's owner matches the tab    → readable
  //   * otherwise                          → DENIED
  // Both branches of the get_network handler call this immediately before
  // getResponseBody — see tools/network.ts:485. There is exactly one call
  // site for getResponseBody (grep-confirmed).

  // ---- requestId branch ----

  // Regression guard (regression from prior commits): requestId with no
  // owner + owned tab → isError, body never returned.
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
      1,
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({ requestId: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to owner "owner-B"/);
    expect(result.content[0].text).not.toContain("AUTH-TOKEN-LEAK");
  });

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
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to owner "owner-B"/);
    expect(result.content[0].text).toMatch(/pass owner:"owner-B"/);
    expect(result.content[0].text).not.toContain("owned-body");
  });

  // ---- body:true single-match branch ----

  // THE residual: body:true with no requestId narrows to a single event
  // through tabId alone; the previous handler selected events[0] and
  // called getResponseBody without the owner check.
  it("denies body:true single-match when tabId points to an owned tab and no owner is given", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 60,
          tabId: 9,
          method: "GET",
          url: "https://other-agent/x",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 60: "AUTH-TOKEN-LEAK-2" },
      9,
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({
      body: true,
      tabId: 9,
      // owner intentionally omitted — bare tabId is NOT authorization.
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to owner "owner-B"/);
    expect(result.content[0].text).not.toContain("AUTH-TOKEN-LEAK-2");
  });

  // Same residual via urlPattern narrowing: the attacker writes a
  // sufficiently unique urlPattern that exactly one owned-tab event
  // survives the list filter, then asks for its body.
  it("denies body:true single-match when urlPattern narrows to one owned-tab event and no owner is given", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 70,
          tabId: 9,
          method: "GET",
          url: "https://other-agent/super-unique-path",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 70: "AUTH-TOKEN-LEAK-3" },
      1, // caller's resolved tab (irrelevant — caller passes no tabId/owner)
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({
      body: true,
      urlPattern: "super-unique-path",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/belongs to owner "owner-B"/);
    expect(result.content[0].text).not.toContain("AUTH-TOKEN-LEAK-3");
  });

  // Positive: body:true with matching owner — allowed.
  it("allows body:true single-match when owner matches the event's tab owner", async () => {
    const { register, handlers } = makeRegistrar();
    const mgr = fakeMgr(
      [
        {
          id: 80,
          tabId: 9,
          method: "GET",
          url: "https://my-agent/x",
          resourceType: "xhr",
          status: 200,
        },
      ],
      { 80: "owned-body" },
      9,
      { 9: "owner-B" },
    );
    registerNetwork(register, mgr, env);
    const result = await handlers.get_network({
      body: true,
      tabId: 9,
      owner: "owner-B",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("owned-body");
  });

  // Untabbed event body:true → always allowed (no owning tab to guard).
  it("allows body:true for an untabbed event regardless of owner arg", async () => {
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
    const result = await handlers.get_network({ body: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("untabbed-body");
  });
});

// ---------------------------------------------------------------------------
// authorizeBodyFetch — pure function unit tests. Locks the contract: untabbed
// events readable, unowned tabs readable, owner match readable, anything else
// denied. These tests guard the chokepoint from future drift.
// ---------------------------------------------------------------------------

describe("authorizeBodyFetch (single owner-auth chokepoint)", () => {
  const fakeGetOwner = (map: Record<number, string>) => (tabId: number) => map[tabId];

  it("untabbed event (tabId undefined) is always readable", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: undefined }, undefined, {
      getTabOwner: fakeGetOwner({}),
    });
    expect(r.ok).toBe(true);
  });

  it("untabbed event readable even when caller passes a stray owner", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: undefined }, "owner-A", {
      getTabOwner: fakeGetOwner({}),
    });
    expect(r.ok).toBe(true);
  });

  it("owned tab + matching owner → readable", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: 9 }, "owner-B", {
      getTabOwner: fakeGetOwner({ 9: "owner-B" }),
    });
    expect(r.ok).toBe(true);
  });

  it("owned tab + no owner → DENIED", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: 9 }, undefined, {
      getTabOwner: fakeGetOwner({ 9: "owner-B" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/belongs to owner "owner-B"/);
  });

  it("owned tab + wrong owner → DENIED", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: 9 }, "owner-A", {
      getTabOwner: fakeGetOwner({ 9: "owner-B" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pass owner:"owner-B"/);
  });

  it("unowned tab (no owner registered) → readable regardless of caller owner", () => {
    const r = authorizeBodyFetch({ id: 1, tabId: 9 }, "owner-A", {
      getTabOwner: fakeGetOwner({}),
    });
    expect(r.ok).toBe(true);
  });
});
