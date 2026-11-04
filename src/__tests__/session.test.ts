// Mock-based tests for session tools that do not need a live browser.
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { register } from "../tools/session.js";
import type { ToolSpec } from "../tools/shared.js";
import type { BrowserManager, Env } from "../manager.js";

type HandlerResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    checks: Array<{ check: string; pass: boolean }>;
    headlessDetection: { available: boolean; reason?: string; failures: string[] };
  };
  isError?: boolean;
};

function captureSpecs(): {
  specs: ToolSpec[];
  register: (s: ToolSpec) => void;
  find: (name: string) => ToolSpec | undefined;
} {
  const specs: ToolSpec[] = [];
  return {
    specs,
    register: (s: ToolSpec) => {
      specs.push(s);
    },
    find: (name: string) => specs.find((s) => s.name === name),
  };
}

function makeMockPage(responses: unknown[]) {
  let evalCalls = 0;
  const worlds: Array<boolean | undefined> = [];
  const page: {
    title: () => Promise<string>;
    evaluate: (
      fn: unknown,
      arg?: unknown,
      options?: unknown,
      isolated?: boolean,
    ) => Promise<unknown>;
    worlds: Array<boolean | undefined>;
    goto: () => Promise<void>;
    waitForFunction: () => Promise<void>;
  } = {
    title: async () => "Example Domain",
    worlds,
    evaluate: async (_fn, _arg, _options, isolated) => {
      worlds.push(isolated);
      const value = responses[evalCalls];
      evalCalls += 1;
      return value;
    },
    goto: async () => {},
    waitForFunction: async () => {},
  };
  return page;
}

function makeMockMgr(page: ReturnType<typeof makeMockPage>) {
  return {
    newTab: async () => ({ tabId: 99, page }),
    closeTab: async (_id: number) => {},
  } as unknown as BrowserManager;
}

const dummyEnv = {} as Env;

describe("smoke_test handler (mock page)", () => {
  it.each([true, false])(
    "checks Linux context coverage without a fake GPU (noMac=%s)",
    async (noMac) => {
      const captured = captureSpecs();
      const identity = {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0",
        platform: "Linux x86_64",
        userAgentData: {
          platform: "Linux",
          brands: [{ brand: "Chromium", version: "156" }],
          mobile: false,
        },
        webdriver: false,
        languages: ["en-ZA", "en"],
        pluginsCount: 5,
        timeZone: "Africa/Johannesburg",
        screen: { width: 1920, height: 1080 },
      };
      const page = makeMockPage([
        identity,
        identity,
        "ANGLE SwiftShader",
        "ANGLE SwiftShader",
        { sameWorker: true, sameFrame: true, noMac },
        [],
        true,
        false,
      ]);
      register(captured.register, makeMockMgr(page), dummyEnv);
      const result = await (captured.find("smoke_test")!.handler as () => Promise<HandlerResult>)();
      const checks = result.structuredContent!.checks;
      expect(checks.find((c) => c.check === "Linux WebGL consistency")?.pass).toBe(true);
      expect(checks.find((c) => c.check === "Linux context identity")?.pass).toBe(noMac);
      expect(checks.some((c) => c.check === "WebGL spoofed")).toBe(false);
      expect(checks.find((c) => c.check === "isolated world: WebGL spoofed")?.pass).toBe(false);
    },
  );

  it("reports headless-detection probe unavailable when sannysoft cannot be reached", async () => {
    const captured = captureSpecs();
    const page = makeMockPage([
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        platform: "MacIntel",
        userAgentData: undefined,
        webdriver: false,
        languages: ["en-US"],
        pluginsCount: 0,
        timeZone: "America/New_York",
        screen: { width: 1920, height: 1080 },
      },
      {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/147.0.0.0",
        platform: "Linux x86_64",
        webdriver: false,
        languages: ["en-US"],
        pluginsCount: 0,
        timeZone: "Africa/Johannesburg",
        screen: { width: 800, height: 600 },
      },
      "Intel Iris Xe",
      "SwiftShader",
      true,
      false,
    ]);
    page.goto = async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    };

    const mgr = makeMockMgr(page);
    register(captured.register, mgr, dummyEnv);
    const smokeTest = captured.find("smoke_test")!;
    const result = (await (smokeTest.handler as () => Promise<HandlerResult>)()) as HandlerResult;

    const text = result.content[0].text;
    expect(text).toContain("Headless detection probe unavailable");
    expect(text).not.toContain("No failures reported");
    expect(result.structuredContent).toBeDefined();
    expect(z.object(smokeTest.outputSchema!).safeParse(result.structuredContent).success).toBe(
      true,
    );
    const hd = result.structuredContent!.headlessDetection;
    expect(hd.available).toBe(false);
    expect(hd.reason).toMatch(/ERR_NAME_NOT_RESOLVED/);

    const probeCheck = result.structuredContent!.checks.find(
      (c) => c.check === "Headless detection probe",
    );
    expect(probeCheck?.pass).toBe(false);
    expect(page.worlds).toEqual([false, undefined, false, undefined, false, undefined]);
    expect(result.structuredContent!.checks.find((c) => c.check === "WebGL spoofed")?.pass).toBe(
      true,
    );
    expect(
      result.structuredContent!.checks.find((c) => c.check === "isolated world: WebGL spoofed")
        ?.pass,
    ).toBe(false);
    expect(result.structuredContent!.checks.find((c) => c.check === "Canvas noise")?.pass).toBe(
      true,
    );
    expect(
      result.structuredContent!.checks.find((c) => c.check === "isolated world: Canvas noise")
        ?.pass,
    ).toBe(false);
  });

  it("reports probe ran with zero failures when sannysoft table is empty", async () => {
    const captured = captureSpecs();
    const page = makeMockPage([
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        platform: "MacIntel",
        userAgentData: undefined,
        webdriver: false,
        languages: ["en-US"],
        pluginsCount: 0,
        timeZone: "America/New_York",
        screen: { width: 1920, height: 1080 },
      },
      {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/147.0.0.0",
        platform: "Linux x86_64",
        webdriver: false,
        languages: ["en-US"],
        pluginsCount: 0,
        timeZone: "Africa/Johannesburg",
        screen: { width: 800, height: 600 },
      },
      "Intel Iris Xe",
      "SwiftShader",
      [],
      false,
      false,
    ]);

    const mgr = makeMockMgr(page);
    register(captured.register, mgr, dummyEnv);
    const smokeTest = captured.find("smoke_test")!;
    const result = (await (smokeTest.handler as () => Promise<HandlerResult>)()) as HandlerResult;

    const text = result.content[0].text;
    expect(text).toContain("Probe ran: 0 failures");
    expect(text).not.toContain("No failures reported");
    const hd = result.structuredContent!.headlessDetection;
    expect(hd.available).toBe(true);
    expect(hd.failures).toHaveLength(0);
  });
});
