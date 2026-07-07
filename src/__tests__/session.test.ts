// Mock-based tests for session tools that do not need a live browser.
import { describe, it, expect } from "bun:test";
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
  const page: {
    title: () => Promise<string>;
    evaluate: () => Promise<unknown>;
    goto: () => Promise<void>;
    waitForFunction: () => Promise<void>;
  } = {
    title: async () => "Example Domain",
    evaluate: async () => {
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
      "Intel Iris Xe",
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
    const hd = result.structuredContent!.headlessDetection;
    expect(hd.available).toBe(false);
    expect(hd.reason).toMatch(/ERR_NAME_NOT_RESOLVED/);

    const probeCheck = result.structuredContent!.checks.find(
      (c) => c.check === "Headless detection probe",
    );
    expect(probeCheck?.pass).toBe(false);
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
      "Intel Iris Xe",
      [],
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
