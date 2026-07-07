import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { llmConfigured, llmJson } from "../llm.js";
import type { Env } from "../manager.js";

const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    BROWSER_MODE: "local",
    OUTPUT_DIR: "/tmp/steel-mcp",
    MAX_INLINE_BYTES: 512000,
    DEFAULT_SCREENSHOT_QUALITY: 80,
    DEFAULT_VIEWPORT_WIDTH: 1280,
    DEFAULT_VIEWPORT_HEIGHT: 720,
    GLOBAL_WAIT_SECONDS: 0,
    SETTLE_TIMEOUT_MS: 5000,
    SESSION_TIMEOUT_MS: 300000,
    OPTIMIZE_BANDWIDTH: false,
    TAB_IDLE_TIMEOUT_MS: 300000,
    TAB_IDLE_SWEEP_INTERVAL_MS: 60000,
    PROFILES_DIR: "/tmp/steel-mcp/profiles",
    CREDENTIALS_FILE: "/tmp/steel-mcp/credentials.json",
    RELAY_PORT: 0,
    RELAY_BIND_ADDR: "127.0.0.1",
    NETWORK_BUFFER_SIZE: 500,
    ...overrides,
  }) as Env;

describe("llmConfigured", () => {
  it("returns true when base URL and model are both set", () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    expect(llmConfigured(env)).toBe(true);
  });

  it("returns false when base URL is missing", () => {
    const env = baseEnv({ ACT_LLM_MODEL: "gemma" });
    expect(llmConfigured(env)).toBe(false);
  });

  it("returns false when model is missing", () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1" });
    expect(llmConfigured(env)).toBe(false);
  });

  it("returns false when both are missing", () => {
    expect(llmConfigured(baseEnv())).toBe(false);
  });
});

describe("llmJson", () => {
  let originalFetch: typeof fetch;
  let fetches: Request[];
  let responses: Response[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetches = [];
    responses = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(res: Response) {
    responses.push(res);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches.push(new Request(input, init));
      return responses.shift()!;
    }) as unknown as typeof fetch;
  }

  it("POSTs to the configured base URL with /chat/completions and no /v1 rewrite", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), {
        status: 200,
      }),
    );

    const result = await llmJson(env, {
      system: "sys",
      user: "usr",
      schema: z.object({ x: z.number() }),
    });

    expect(result).toEqual({ x: 1 });
    expect(fetches.length).toBe(1);
    const req = fetches[0];
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  it("strips a trailing slash from the base URL", async () => {
    const env = baseEnv({
      ACT_LLM_BASE_URL: "http://localhost:11434/v1/",
      ACT_LLM_MODEL: "gemma",
    });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), {
        status: 200,
      }),
    );

    await llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }) });

    expect(fetches[0].url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("omits Authorization header when API key is not set", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), {
        status: 200,
      }),
    );

    await llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }) });

    expect(fetches[0].headers.get("authorization")).toBeNull();
  });

  it("includes Authorization header when API key is set", async () => {
    const env = baseEnv({
      ACT_LLM_BASE_URL: "http://localhost:11434/v1",
      ACT_LLM_MODEL: "gemma",
      ACT_LLM_API_KEY: "sk-test",
    });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":1}' } }] }), {
        status: 200,
      }),
    );

    await llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }) });

    expect(fetches[0].headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("sends correct body shape", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":2}' } }] }), {
        status: 200,
      }),
    );

    await llmJson(env, {
      system: "sys",
      user: "usr",
      schema: z.object({ x: z.number() }),
      maxTokens: 128,
    });

    const body = await fetches[0].json();
    expect(body).toEqual({
      model: "gemma",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      temperature: 0,
      max_tokens: 128,
      response_format: { type: "json_object" },
    });
  });

  it("repairs once on malformed JSON and succeeds the second time", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), {
        status: 200,
      }),
    );
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":3}' } }] }), {
        status: 200,
      }),
    );

    const result = await llmJson(env, {
      system: "s",
      user: "u",
      schema: z.object({ x: z.number() }),
    });

    expect(result).toEqual({ x: 3 });
    expect(fetches.length).toBe(2);
    const secondBody = await fetches[1].json();
    const lastUser = secondBody.messages[secondBody.messages.length - 1].content;
    expect(lastUser).toContain("Return ONLY valid JSON");
    expect(lastUser).toContain("not-json");
  });

  it("repairs once on schema validation failure and succeeds the second time", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":"abc"}' } }] }), {
        status: 200,
      }),
    );
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"x":4}' } }] }), {
        status: 200,
      }),
    );

    const result = await llmJson(env, {
      system: "s",
      user: "u",
      schema: z.object({ x: z.number() }),
    });

    expect(result).toEqual({ x: 4 });
    expect(fetches.length).toBe(2);
    const secondBody = await fetches[1].json();
    const lastUser = secondBody.messages[secondBody.messages.length - 1].content;
    expect(lastUser).toContain("Return ONLY valid JSON");
  });

  it("throws after two consecutive failures", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "bad" } }] }), { status: 200 }),
    );
    mockFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "still-bad" } }] }), {
        status: 200,
      }),
    );

    await expect(
      llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }) }),
    ).rejects.toThrow(/bad.*still-bad/s);
  });

  it("throws on non-200 HTTP status with body snippet", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    mockFetch(new Response('{"error":"model not found"}', { status: 404 }));

    await expect(
      llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }) }),
    ).rejects.toThrow(/404.*model not found/);
  });

  it("throws on timeout via AbortController", async () => {
    const env = baseEnv({ ACT_LLM_BASE_URL: "http://localhost:11434/v1", ACT_LLM_MODEL: "gemma" });
    globalThis.fetch = (async () => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("The operation was aborted")), 100);
      }) as Promise<Response>;
    }) as unknown as typeof fetch;

    await expect(
      llmJson(env, { system: "s", user: "u", schema: z.object({ x: z.number() }), timeoutMs: 10 }),
    ).rejects.toThrow(/aborted|timeout/i);
  });
});
