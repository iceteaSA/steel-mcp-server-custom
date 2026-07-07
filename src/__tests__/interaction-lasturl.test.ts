import { describe, it, expect } from "bun:test";
import { register as registerInteraction } from "../tools/interaction.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar } from "../tools/shared.js";

const env: Env = {
  GLOBAL_WAIT_SECONDS: 0,
  SETTLE_TIMEOUT_MS: 0,
} as Env;

function makeRegistrar() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const register = ((opts: any) => {
    handlers[opts.name] = opts.handler;
  }) as ToolRegistrar;
  return { register, handlers };
}

function fakePage(beforeUrl = "https://before.test/", afterUrl = "https://after.test/") {
  let clicked = false;
  return {
    url: () => (clicked ? afterUrl : beforeUrl),
    frames: () => [],
    keyboard: {
      press: async () => {
        clicked = true;
      },
    },
    locator: () => ({
      focus: async () => {},
      click: async () => {
        clicked = true;
      },
      fill: async () => {
        clicked = true;
      },
      press: async () => {
        clicked = true;
      },
      waitFor: async () => {},
      elementHandle: async () => null,
      ariaSnapshot: async () => "text",
    }),
    evaluate: async (fn: any, selectors?: string[]) => {
      // Fake detectFieldsInPage result: every selector exists as a text input.
      if (Array.isArray(selectors)) {
        const map: Record<string, { tag: string; type: string }> = {};
        for (const sel of selectors) {
          map[sel] = { tag: "input", type: "text" };
        }
        return map;
      }
      return undefined;
    },
  } as any;
}

function fakeMgr(page: any, captured: { tabId?: number; url?: string }[] = []): BrowserManager {
  return {
    getPage: async () => page,
    resolveTab: () => 1,
    setTabLastUrl: (tabId: number, url: string) => {
      captured.push({ tabId, url });
    },
    dialogNotice: () => "",
  } as unknown as BrowserManager;
}

describe("interaction tools update tabLastUrl on navigation", () => {
  it("click updates tabLastUrl when the URL changed", async () => {
    const { register, handlers } = makeRegistrar();
    const calls: { tabId?: number; url?: string }[] = [];
    const page = fakePage("https://before.test/", "https://clicked.test/");
    registerInteraction(register, fakeMgr(page, calls), env);
    const result = await handlers.click({ selector: "a[href='/next']" });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ tabId: 1, url: "https://clicked.test/" }]);
  });

  it("fill updates tabLastUrl when the URL changed", async () => {
    const { register, handlers } = makeRegistrar();
    const calls: { tabId?: number; url?: string }[] = [];
    const page = fakePage("https://before.test/", "https://filled.test/");
    registerInteraction(register, fakeMgr(page, calls), env);
    const result = await handlers.fill({ fields: [{ selector: "#q", value: "x" }] });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ tabId: 1, url: "https://filled.test/" }]);
  });

  it("press_key updates tabLastUrl when the URL changed", async () => {
    const { register, handlers } = makeRegistrar();
    const calls: { tabId?: number; url?: string }[] = [];
    const page = fakePage("https://before.test/", "https://pressed.test/");
    registerInteraction(register, fakeMgr(page, calls), env);
    const result = await handlers.press_key({ key: "Enter" });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ tabId: 1, url: "https://pressed.test/" }]);
  });
});
