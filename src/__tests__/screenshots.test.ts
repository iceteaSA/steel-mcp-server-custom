/**
 * Unit tests for screenshot annotate feature (set-of-marks overlay).
 *
 * Tests the marks-overlay logic without requiring a real browser.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs/promises";
import { register as registerScreenshots } from "../tools/screenshots.js";
import type { BrowserManager, Env } from "../manager.js";
import type { ToolRegistrar } from "../tools/shared.js";

// Clean output dir before and after.
const TEST_OUTPUT = "/tmp/steel-mcp-annotate-test";

const env = {
  BROWSER_MODE: "local",
  OUTPUT_DIR: TEST_OUTPUT,
  OUTPUT_ROOT: TEST_OUTPUT,
  UPLOAD_ROOT: TEST_OUTPUT,
  MAX_INLINE_BYTES: 100, // force file mode
  DEFAULT_SCREENSHOT_QUALITY: 80,
  DEFAULT_VIEWPORT_WIDTH: 1280,
  DEFAULT_VIEWPORT_HEIGHT: 720,
  GLOBAL_WAIT_SECONDS: 0,
  SETTLE_TIMEOUT_MS: 0,
  SESSION_TIMEOUT_MS: 300000,
  OPTIMIZE_BANDWIDTH: false,
  TAB_IDLE_TIMEOUT_MS: 300000,
  TAB_IDLE_SWEEP_INTERVAL_MS: 60000,
  PROFILES_DIR: "/tmp/steel-mcp/profiles",
  CREDENTIALS_FILE: "/tmp/steel-mcp/credentials.json",
  RELAY_PORT: 0,
  RELAY_BIND_ADDR: "127.0.0.1",
  NETWORK_BUFFER_SIZE: 500,
} as Env;

function makeRegistrar() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const register = ((opts: any) => {
    handlers[opts.name] = opts.handler;
  }) as ToolRegistrar;
  return { register, handlers };
}

/**
 * Build a fake page with:
 * - ariaSnapshot returning a tree with interactive elements
 * - boundingBox returning boxes for aria-ref locators
 * - evaluate tracking calls (for overlay inject/remove)
 * - screenshot returning a tiny png buffer
 * - newCDPSession returning a CDP-style screenshot
 */
function fakeAnnotatePage(opts?: { noBoxes?: boolean }) {
  const evalCalls: string[] = [];
  const page = {
    url: () => "https://annotate.test/",
    evaluate: async (fn: any, _arg?: any) => {
      if (typeof fn === "function") {
        // Distinguish overlay inject vs remove by fn source.
        // Inject has the full overlay creation code; remove is a one-liner getElementById.
        const src = fn.toString();
        if (src.includes("z-index:2147483647")) {
          evalCalls.push("inject");
        } else if (src.includes("__mcp_marks")) {
          evalCalls.push("remove");
        }
      }
      return undefined;
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
    setViewportSize: async () => {},
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ data: Buffer.from("fake-webp").toString("base64") }),
        detach: async () => {},
      }),
    }),
    locator: (sel: string) => {
      // aria-ref locators: return boundingBox unless opted out.
      if (sel.startsWith("aria-ref=") && !opts?.noBoxes) {
        const n = parseInt(sel.slice(9), 10) || 1;
        return {
          boundingBox: async () => ({
            x: n * 50,
            y: n * 30,
            width: 40,
            height: 20,
          }),
        };
      }
      return {
        boundingBox: async () => null,
        count: async () => 0,
        first: () => ({
          count: async () => 0,
          boundingBox: async () => null,
        }),
      };
    },
    ariaSnapshot: undefined, // set below
  };

  // ariaSnapshot is on locator("body"), not directly on page.
  const bodyLocator = {
    ariaSnapshot: async () =>
      '- button "Submit" [ref=e1]\n- link "About" [ref=e2]\n- textbox "Search" [ref=e3]\n- heading "Title"',
  };
  // The tool calls page.locator(sel).ariaSnapshot — locator("body") returns bodyLocator.
  // But our locator above handles aria-ref= selectors. We need to handle "body" too.
  const origLocator = page.locator;
  page.locator = (sel: string) => {
    if (sel === "body") return bodyLocator as any;
    return (origLocator as Function)(sel);
  };

  return { page: page as any, evalCalls };
}

function fakeMgr(page: any): BrowserManager {
  return {
    getPage: async () => page,
    resolveTab: () => 1,
  } as unknown as BrowserManager;
}

describe("get_screenshot annotate", () => {
  beforeAll(async () => {
    await fs.mkdir(TEST_OUTPUT, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_OUTPUT, { recursive: true, force: true }).catch(() => {});
  });

  it("without annotate, structuredContent is not returned", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, evalCalls } = fakeAnnotatePage();
    registerScreenshots(register, fakeMgr(page), env);

    const result = await handlers.get_screenshot({ outputMode: "file" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(evalCalls).toHaveLength(0);
  });

  it("with annotate=true, injects overlay, captures, removes it, and returns marks", async () => {
    const { register, handlers } = makeRegistrar();
    const { page, evalCalls } = fakeAnnotatePage();
    registerScreenshots(register, fakeMgr(page), env);

    const result = await handlers.get_screenshot({
      outputMode: "file",
      annotate: true,
    });

    expect(result.isError).toBeUndefined();
    // Overlay injected then removed.
    expect(evalCalls).toContain("inject");
    expect(evalCalls).toContain("remove");
    // structuredContent contains marks array.
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent.marks).toBeInstanceOf(Array);
    const { marks } = result.structuredContent;
    expect(marks.length).toBe(3); // e1, e2, e3 are interactive; heading is not
    // First mark should be the first interactive element.
    expect(marks[0].n).toBe(1);
    expect(marks[0].ref).toBe("e1");
    // Centre coords: x + w/2, y + h/2 → 50 + 20 = 70, 30 + 10 = 40
    expect(marks[0].x).toBe(70);
    expect(marks[0].y).toBe(40);
  });

  it("with annotate=true and no interactive elements, returns no marks", async () => {
    const { register, handlers } = makeRegistrar();
    const { page } = fakeAnnotatePage({ noBoxes: true });
    registerScreenshots(register, fakeMgr(page), env);

    // Override ariaSnapshot to return only non-interactive elements.
    const bodyLocator = {
      ariaSnapshot: async () => '- heading "Title"\n- paragraph "No interactives here"',
    };
    page.locator = (sel: string) => {
      if (sel === "body") return bodyLocator as any;
      return {
        boundingBox: async () => null,
        count: async () => 0,
        first: () => ({ count: async () => 0, boundingBox: async () => null }),
      } as any;
    };

    const result = await handlers.get_screenshot({
      outputMode: "file",
      annotate: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.marks).toBeUndefined();
  });
});
