import { describe, it, expect, mock, beforeEach } from "bun:test";
import { z } from "zod";
import type { BrowserManager } from "../manager.js";
import { jsonSchemaToZod, runExtractAi } from "../tools/act.js";

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

// Per-test deps injected into runExtractAi. Using the DI seam (RunExtractAiDeps)
// instead of bun's mock.module() avoids leaking the mocks into other test files
// that share the same process — bun 1.3.14 cannot restore module mocks after
// the file's tests complete.
const mockLlmJson = mock<(env: any, opts: any) => Promise<any>>(() =>
  Promise.resolve({ name: "Alice" }),
);
const mockWriteToFile = mock<() => Promise<string>>(() => Promise.resolve("/tmp/out/result.json"));

const baseDeps = {
  llmJson: mockLlmJson,
  writeToFile: mockWriteToFile,
};

function makeFakeMgr(html: string): BrowserManager {
  return {
    getPage: mock(() =>
      Promise.resolve({
        url: () => "http://example.com",
        evaluate: mock((fn: any, opts?: any) => {
          if (typeof fn === "function") {
            // When extractPageContent is passed, opts includes mode.
            if (opts?.mode === "innerText") {
              return Promise.resolve({ text: "Hello world" });
            }
            // HTML mode: return the trimmed outerHTML.
            return Promise.resolve(html);
          }
          return Promise.resolve({});
        }),
      }),
    ),
    resolveTab: mock(() => 1),
  } as unknown as BrowserManager;
}

describe("jsonSchemaToZod", () => {
  it("converts a simple object schema", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(() => zod.parse({})).toThrow();
  });

  it("converts nested object + array", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ items: [{ title: "A" }] })).toEqual({ items: [{ title: "A" }] });
  });

  it("converts primitives", () => {
    const schema = {
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        b: { type: "boolean" },
      },
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ s: "x", n: 1, b: true })).toEqual({ s: "x", n: 1, b: true });
  });

  it("converts nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
      },
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ name: null })).toEqual({ name: null });
    expect(zod.parse({ name: "Alice" })).toEqual({ name: "Alice" });
  });

  it("rejects unsupported keywords", () => {
    expect(() => jsonSchemaToZod({ type: "object", pattern: "^a$" })).toThrow(
      /unsupported.*pattern/i,
    );
  });
});

describe("runExtractAi", () => {
  beforeEach(() => {
    mockLlmJson.mockClear();
    mockWriteToFile.mockClear();
  });

  it("extracts text content and validates against schema", async () => {
    const mgr = makeFakeMgr("<p>Hello</p>");
    const schema = JSON.stringify({ type: "object", properties: { greeting: { type: "string" } } });

    const result = await runExtractAi(
      { instruction: "get greeting", schema, format: "text" },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(result.text).toBe(JSON.stringify({ name: "Alice" }, null, 2));
    const callArgs = mockLlmJson.mock.calls[0][1];
    expect(callArgs.system).toContain("Extract structured data");
    expect(callArgs.user).toContain("get greeting");
    expect(callArgs.user).toContain("Hello world");
  });

  it("uses record schema when no schema is provided", async () => {
    const mgr = makeFakeMgr("<p>Hello</p>");

    const result = await runExtractAi(
      { instruction: "extract", format: "text" },
      mgr,
      baseEnv as any,
      baseDeps,
    );

    expect(result.text).toBe(JSON.stringify({ name: "Alice" }, null, 2));
    const callArgs = mockLlmJson.mock.calls[0][1];
    expect(callArgs.schema).toBeInstanceOf(z.ZodType);
  });

  it("truncates long content at 20k chars", async () => {
    const longText = "x".repeat(25_000);
    const mgr = makeFakeMgr(`<p>${longText}</p>`);

    await runExtractAi({ instruction: "extract", format: "html" }, mgr, baseEnv as any, baseDeps);

    const callArgs = mockLlmJson.mock.calls[0][1];
    expect(callArgs.user.length).toBeLessThanOrEqual(20_000 + 100);
  });

  it("writes to file when output exceeds maxInlineBytes", async () => {
    const mgr = makeFakeMgr("<p>Hi</p>");
    mockLlmJson.mockImplementation(async () => {
      const big: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) big[`key${i}`] = "y".repeat(100);
      return big;
    });

    const result = await runExtractAi(
      { instruction: "extract", format: "text" },
      mgr,
      { ...baseEnv, MAX_INLINE_BYTES: 100 } as any,
      baseDeps,
    );

    expect(result.filePath).toBe("/tmp/out/result.json");
    expect(mockWriteToFile).toHaveBeenCalled();
  });
});
