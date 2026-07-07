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

// ---------------------------------------------------------------------------
// Mouse primitives — coordinate-level tools for vision fallback.
// ---------------------------------------------------------------------------

describe("mouse primitives", () => {
  function mousePage() {
    const calls: Array<{ method: string; args: any[] }> = [];
    const makeSpy =
      (method: string) =>
      (...args: any[]) => {
        calls.push({ method, args });
        return Promise.resolve();
      };
    const page = {
      url: () => "https://static.test/",
      evaluate: async () => {},
      frames: () => [],
      mouse: {
        click: makeSpy("click"),
        move: makeSpy("move"),
        down: makeSpy("down"),
        up: makeSpy("up"),
      },
    } as any;
    return { page, calls };
  }

  function fakeMgr(page: any): BrowserManager {
    return {
      getPage: async () => page,
      resolveTab: () => 1,
      setTabLastUrl: () => {},
      dialogNotice: () => "",
    } as unknown as BrowserManager;
  }

  it("click_at calls page.mouse.click with coordinates and defaults", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, calls } = mousePage();
    registerInteraction(register, fakeMgr(page), env);
    const result = await handlers.click_at({ x: 100, y: 200 });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("click");
    expect(calls[0].args[0]).toBe(100);
    expect(calls[0].args[1]).toBe(200);
    expect(calls[0].args[2]).toEqual({ button: "left", clickCount: 1 });
    expect(result.content[0].text).toContain("Clicked at (100, 200)");
  });

  it("click_at passes custom button and clickCount", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, calls } = mousePage();
    registerInteraction(register, fakeMgr(page), env);
    await handlers.click_at({ x: 50, y: 60, button: "right", clickCount: 2 });
    expect(calls[0].args[2]).toEqual({ button: "right", clickCount: 2 });
  });

  it("mouse_move calls page.mouse.move", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, calls } = mousePage();
    registerInteraction(register, fakeMgr(page), env);
    const result = await handlers.mouse_move({ x: 300, y: 400 });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("move");
    expect(calls[0].args[0]).toBe(300);
    expect(calls[0].args[1]).toBe(400);
    expect(result.content[0].text).toContain("Mouse moved to (300, 400)");
  });

  it("mouse_down calls page.mouse.down", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, calls } = mousePage();
    registerInteraction(register, fakeMgr(page), env);
    const result = await handlers.mouse_down({ button: "right" });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("down");
    expect(calls[0].args[0]).toEqual({ button: "right" });
  });

  it("mouse_up calls page.mouse.up", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, calls } = mousePage();
    registerInteraction(register, fakeMgr(page), env);
    const result = await handlers.mouse_up({});
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("up");
    expect(calls[0].args[0]).toEqual({ button: "left" });
  });
});
