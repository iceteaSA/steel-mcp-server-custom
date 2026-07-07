import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Page } from "patchright";
import type { BrowserManager } from "../manager.js";
import { runAct } from "../tools/act.js";

function makeFakeLocator() {
  return {
    click: mock(() => Promise.resolve()),
    fill: mock(() => Promise.resolve()),
    press: mock(() => Promise.resolve()),
    selectOption: mock(() => Promise.resolve()),
    check: mock(() => Promise.resolve()),
    uncheck: mock(() => Promise.resolve()),
    focus: mock(() => Promise.resolve()),
    elementHandle: mock(() =>
      Promise.resolve({
        evaluate: mock(() => Promise.resolve({ tag: "input", type: "text" })),
        dispose: mock(() => Promise.resolve()),
      }),
    ),
    waitFor: mock(() => Promise.resolve()),
    evaluate: mock(() =>
      Promise.resolve({ before: 0, after: 500, pageHeight: 2000, viewportHeight: 800 }),
    ),
    ariaSnapshot: mock(() => Promise.resolve('- button "Submit" [ref=e1]')),
  };
}

function makeFakePage(): Page {
  const loc = makeFakeLocator();
  const page = {
    url: mock(() => "http://example.com"),
    evaluate: mock(() => Promise.resolve({})),
    keyboard: { press: mock(() => Promise.resolve()) },
    locator: mock(() => loc),
    frames: mock(() => []),
    isClosed: mock(() => false),
    waitForFunction: mock(() => Promise.resolve()),
    setViewportSize: mock(() => Promise.resolve()),
    title: mock(() => Promise.resolve("Example")),
  };
  return page as unknown as Page;
}

function makeFakeMgr(page: Page): BrowserManager {
  return {
    getPage: mock(() => Promise.resolve(page)),
    resolveTab: mock(() => 1),
    setTabLastUrl: mock(),
    dialogNotice: mock(() => ""),
  } as unknown as BrowserManager;
}

const baseEnv = {
  BROWSER_MODE: "local",
  OUTPUT_DIR: "/tmp/steel-mcp",
  MAX_INLINE_BYTES: 512000,
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
  ACT_LLM_BASE_URL: "http://localhost:11434/v1",
  ACT_LLM_MODEL: "gemma",
};

// Mock heavy deps so tests stay unit-level.
const mockLlmJson = mock<() => Promise<any>>(() => Promise.resolve({ action: "done", reason: "" }));
const mockCaptureSnapshot = mock<() => Promise<{ text: string; generation: number }>>(() =>
  Promise.resolve({ text: "", generation: 1 }),
);
const mockAfterAction = mock(() => Promise.resolve());
const mockActionFeedback = mock(() => Promise.resolve(""));

mock.module("../llm.js", () => ({
  llmConfigured: () => true,
  llmJson: mockLlmJson,
}));

mock.module("../snapshot.js", () => ({
  captureSnapshot: mockCaptureSnapshot,
  storeSnapshot: mock(() => {}),
  getStoredSnapshot: mock(() => undefined),
  diffSnapshots: mock(() => "(no visible change)"),
}));

mock.module("../utils.js", () => ({
  afterAction: mockAfterAction,
  actionFeedback: mockActionFeedback,
  writeToFile: mock((data: string) => Promise.resolve(`/tmp/out/${data.length}`)),
}));

describe("runAct", () => {
  beforeEach(() => {
    mockLlmJson.mockReset();
    mockCaptureSnapshot.mockReset();
    mockAfterAction.mockReset();
    mockActionFeedback.mockReset();
  });

  it("returns a done transcript on a single step", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "done", reason: "Task complete" });

    const text = await runAct({ instruction: "do nothing", maxSteps: 3 }, mgr, baseEnv as any);

    expect(text).toContain("step 1: done");
    expect(text).toContain("Task complete");
    expect(mockLlmJson).toHaveBeenCalledTimes(1);
    expect(mockCaptureSnapshot).toHaveBeenCalledTimes(1);
  });

  it("executes a multi-step action sequence then done", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- form [ref=e2]", generation: 1 });
    mockLlmJson
      .mockResolvedValueOnce({ action: "click", ref: "e1", reason: "open form" })
      .mockResolvedValueOnce({ action: "fill", ref: "e2", value: "hello", reason: "enter text" })
      .mockResolvedValueOnce({ action: "press_key", ref: "e3", value: "Enter", reason: "submit" })
      .mockResolvedValueOnce({ action: "done", reason: "submitted" });

    const text = await runAct({ instruction: "submit the form", maxSteps: 5 }, mgr, baseEnv as any);

    expect(text).toMatch(/step 1: click e1.*open form/);
    expect(text).toMatch(/step 2: fill e2 "hello".*enter text/);
    expect(text).toMatch(/step 3: press_key e3 "Enter".*submit/);
    expect(text).toMatch(/step 4: done.*submitted/);
    expect(mockLlmJson).toHaveBeenCalledTimes(4);
  });

  it("breaks early on stuck", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- nothing", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "stuck", reason: "No matching element" });

    const text = await runAct({ instruction: "click missing", maxSteps: 5 }, mgr, baseEnv as any);

    expect(text).toContain("step 1: stuck");
    expect(text).toContain("No matching element");
    expect(mockLlmJson).toHaveBeenCalledTimes(1);
  });

  it("stops at maxSteps without done", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "click", ref: "e1", reason: "keep going" });

    const text = await runAct({ instruction: "keep clicking", maxSteps: 2 }, mgr, baseEnv as any);

    expect(text).toContain("step 1: click e1");
    expect(text).toContain("step 2: click e1");
    expect(text).toContain("reached maxSteps (2) without completing");
    expect(mockLlmJson).toHaveBeenCalledTimes(2);
  });

  it("transcript includes scroll actions", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- region [ref=e5]", generation: 1 });
    mockLlmJson
      .mockResolvedValueOnce({ action: "scroll", ref: "e5", value: "down", reason: "see more" })
      .mockResolvedValueOnce({ action: "done", reason: "enough" });

    const text = await runAct({ instruction: "scroll", maxSteps: 3 }, mgr, baseEnv as any);

    expect(text).toMatch(/step 1: scroll e5 "down".*see more/);
    expect(text).toMatch(/step 2: done.*enough/);
  });

  it("returns isError-style transcript on LLM failure", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button", generation: 1 });
    mockLlmJson.mockRejectedValue(new Error("LLM timeout"));

    await expect(runAct({ instruction: "fail", maxSteps: 3 }, mgr, baseEnv as any)).rejects.toThrow(
      /LLM timeout/,
    );
  });
});
