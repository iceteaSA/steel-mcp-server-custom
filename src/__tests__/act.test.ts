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
    screenshot: mock(() => Promise.resolve(Buffer.from("fake-jpeg-data"))),
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
  OUTPUT_ROOT: "/tmp/steel-mcp",
  UPLOAD_ROOT: "/tmp/steel-mcp",
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

// Per-test deps injected into runAct. Using the DI seam (RunActDeps) instead of
// bun's mock.module() avoids leaking the mocks into other test files that share
// the same process — bun 1.3.14 cannot restore module mocks after the file's
// tests complete.
const mockLlmJson = mock<() => Promise<any>>(() => Promise.resolve({ action: "done", reason: "" }));
const mockCaptureSnapshot = mock<() => Promise<{ text: string; generation: number }>>(() =>
  Promise.resolve({ text: "", generation: 1 }),
);
const mockActionFeedback = mock(() => Promise.resolve(""));

const baseDeps = {
  llmJson: mockLlmJson,
  captureSnapshot: mockCaptureSnapshot,
  actionFeedback: mockActionFeedback,
};

describe("runAct", () => {
  beforeEach(() => {
    mockLlmJson.mockReset();
    mockCaptureSnapshot.mockReset();
    mockActionFeedback.mockReset();
  });

  it("returns a done transcript on a single step", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "done", reason: "Task complete" });

    const text = await runAct(
      { instruction: "do nothing", maxSteps: 3 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

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

    const text = await runAct(
      { instruction: "submit the form", maxSteps: 5 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

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

    const text = await runAct(
      { instruction: "click missing", maxSteps: 5 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(text).toContain("step 1: stuck");
    expect(text).toContain("No matching element");
    expect(mockLlmJson).toHaveBeenCalledTimes(1);
  });

  it("stops at maxSteps without done", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "click", ref: "e1", reason: "keep going" });

    const text = await runAct(
      { instruction: "keep clicking", maxSteps: 2 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

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

    const text = await runAct(
      { instruction: "scroll", maxSteps: 3 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(text).toMatch(/step 1: scroll e5 "down".*see more/);
    expect(text).toMatch(/step 2: done.*enough/);
  });

  it("returns isError-style transcript on LLM failure", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button", generation: 1 });
    mockLlmJson.mockRejectedValue(new Error("LLM timeout"));

    await expect(
      runAct({ instruction: "fail", maxSteps: 3 }, mgr, baseEnv as any, baseDeps),
    ).rejects.toThrow(/LLM timeout/);
  });

  it("includes the transcript so far when an action fails", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "click", ref: "e1", reason: "open form" });

    const fakeLocator = makeFakeLocator();
    fakeLocator.click = mock(() => Promise.reject(new Error("stale ref")));
    (page.locator as any).mockImplementation(() => fakeLocator);

    await expect(
      runAct({ instruction: "one click", maxSteps: 3 }, mgr, baseEnv as any, baseDeps),
    ).rejects.toThrow(/step 1: click e1.*stale ref/s);
  });

  it("stops at the 60s wall cap and does not keep calling llmJson", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    let now = 0;
    const originalDateNow = Date.now;
    Date.now = () => now;

    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockImplementation(async () => {
      now = 60_001; // advance past the cap during the LLM call
      return { action: "click", ref: "e1", reason: "click" };
    });

    try {
      await expect(
        runAct({ instruction: "click", maxSteps: 5 }, mgr, baseEnv as any, baseDeps),
      ).rejects.toThrow(/reached 60s wall cap/);
      expect(mockLlmJson).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  // Regression: small models (gemma-4) sometimes return a valid action WITHOUT
  // a `reason` field, e.g. {"action":"click","ref":"e6"}. The schema must accept
  // this and act must execute the click — not error with "LLM request failed
  // after one repair retry".
  it("executes a click when the model omits reason (gemma-4 case)", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- link [ref=e6]", generation: 1 });
    // exact gemma-4 payload — no reason field at all
    mockLlmJson.mockResolvedValue({ action: "click", ref: "e6" });

    const text = await runAct(
      { instruction: "Click the 'Learn more' link", maxSteps: 1 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    // The click must have been executed (not errored out on schema validation).
    expect(text).not.toMatch(/LLM request failed|schema validation/i);
    expect(text).toContain("step 1: click e6");
    // Transcript must not render "undefined" when reason is missing.
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/click e6\s+—\s*$/m); // no dangling dash for empty reason
    expect(mockLlmJson).toHaveBeenCalledTimes(1);
  });

  it("renders stuck transcript sanely when reason is omitted", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- nothing", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "stuck" });

    const text = await runAct(
      { instruction: "impossible", maxSteps: 3 },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(text).toContain("step 1: stuck");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/stuck\s+—\s*$/m);
  });

  // Vision grounding — useVision injects a screenshot as a multimodal image
  // part; falls back to text-only when the endpoint rejects it.

  it("passes an imageDataUri to llmJson when useVision is true", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "done", reason: "ok" });

    await runAct(
      { instruction: "click", maxSteps: 1, useVision: true },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(mockLlmJson).toHaveBeenCalledTimes(1);
    // Verify the llmJson call options have an imageDataUri.
    const callArgs = mockLlmJson.mock.calls[0] as any[];
    expect(callArgs[1].imageDataUri).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("does NOT pass imageDataUri when useVision is absent", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "done", reason: "ok" });

    await runAct({ instruction: "click", maxSteps: 1 }, mgr, baseEnv as any, baseDeps);

    expect(mockLlmJson).toHaveBeenCalledTimes(1);
    const callArgs = mockLlmJson.mock.calls[0] as any[];
    expect(callArgs[1].imageDataUri).toBeUndefined();
  });

  it("falls back to text-only when vision-enabled llmJson fails, and appends a note", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    // First call (vision) fails, second (text-only) succeeds.
    mockLlmJson
      .mockRejectedValueOnce(new Error("400: model does not support images"))
      .mockResolvedValueOnce({ action: "done", reason: "text-only ok" });

    const text = await runAct(
      { instruction: "click", maxSteps: 1, useVision: true },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(mockLlmJson).toHaveBeenCalledTimes(2);
    expect(text).toContain("step 1: done");
    expect(text).toContain("[vision unavailable, text-only]");
  });

  it("still runs text-only when screenshot capture itself fails", async () => {
    const page = makeFakePage();
    const mgr = makeFakeMgr(page);
    mockCaptureSnapshot.mockResolvedValue({ text: "- button [ref=e1]", generation: 1 });
    mockLlmJson.mockResolvedValue({ action: "done", reason: "ok" });
    // Simulate screenshot failure.
    (page.screenshot as any).mockRejectedValue(new Error("viewport error"));

    const text = await runAct(
      { instruction: "click", maxSteps: 1, useVision: true },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(mockLlmJson).toHaveBeenCalledTimes(1);
    // Still worked text-only.
    expect(text).toContain("step 1: done");
    // No imageDataUri because screenshot failed.
    const callArgs = mockLlmJson.mock.calls[0] as any[];
    expect(callArgs[1].imageDataUri).toBeUndefined();
  });
});
