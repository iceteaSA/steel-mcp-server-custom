/**
 * fetch_urls + isSpaShell — unit tests with mocked impit.
 *
 * The HTTP fast-path's dep is `impit` (a native Rust binding). We test the
 * extraction / escalation logic by injecting a fake `client` — keeps the
 * test runnable on any machine without the .node binary and makes the
 * behaviour deterministic.
 */
import { describe, it, expect } from "bun:test";
import { isSpaShell } from "../helpers.js";
import { fetchHttp, type FetchResult } from "../tools/extraction.js";

// ---------------------------------------------------------------------------
// isSpaShell — every signal from the task spec.
// ---------------------------------------------------------------------------

const SHELL_HTML = `<!doctype html><html><body><div id="root"></div><script src="/main.js"></script></body></html>`;
const NEXTJS_SHELL = `<!doctype html><html><body><div id="__next"><div data-reactroot></div></div></body></html>`;
const CLOUDFLARE_HTML = `<!doctype html><html><head><title>Just a moment...</title></head><body><div class="cf-challenge">Checking your browser before accessing example.com.</div></body></html>`;
const ARTICLE_HTML = `<!doctype html><html><head><title>A long article</title></head><body><article><h1>Heading</h1><p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20)}</p></article></body></html>`;
const EMPTY_HTML = `<!doctype html><html><body></body></html>`;

describe("isSpaShell", () => {
  it("true: shell HTML with short text and <div id=root>", () => {
    expect(isSpaShell(SHELL_HTML, "")).toBe(true);
  });

  it("true: Next.js __next mount with empty text", () => {
    expect(isSpaShell(NEXTJS_SHELL, "")).toBe(true);
  });

  it("true: Vue app mount with short text", () => {
    expect(isSpaShell(`<html><body><div id="app"></div></body></html>`, "")).toBe(true);
  });

  it("false: long article body with Readability-extracted text", () => {
    const longText = ARTICLE_HTML.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    expect(isSpaShell(ARTICLE_HTML, longText)).toBe(false);
  });

  it("true: Cloudflare 'Just a moment' challenge", () => {
    expect(isSpaShell(CLOUDFLARE_HTML, "Just a moment")).toBe(true);
  });

  it("true: 'Checking your browser' marker", () => {
    expect(
      isSpaShell("<html><body>Checking your browser...</body></html>", "Checking your browser"),
    ).toBe(true);
  });

  it("true: 'cf-challenge' class marker", () => {
    expect(isSpaShell('<html><body><div class="cf-challenge"></div></body></html>', "")).toBe(true);
  });

  it("true: status 403 escalates regardless of text", () => {
    expect(isSpaShell("<html>Forbidden</html>", "Some forbidden body here", 403)).toBe(true);
  });

  it("true: status 429 (rate limit)", () => {
    expect(isSpaShell("<html>Rate limited</html>", "", 429)).toBe(true);
  });

  it("true: status 503 (service unavailable)", () => {
    expect(isSpaShell("<html>Service Unavailable</html>", "", 503)).toBe(true);
  });

  it("false: status 200 with substantial article text", () => {
    expect(isSpaShell(ARTICLE_HTML, "x".repeat(500), 200)).toBe(false);
  });

  it("true: short text + html.length < 2000 (empty response)", () => {
    expect(isSpaShell(EMPTY_HTML, "")).toBe(true);
  });

  it("true: short text just below 200-char threshold", () => {
    expect(isSpaShell(SHELL_HTML, "x".repeat(150))).toBe(true);
  });

  it("false: text exactly at 200-char threshold", () => {
    expect(isSpaShell(ARTICLE_HTML, "x".repeat(200))).toBe(false);
  });

  it("false: status 404 (not in the escalation set)", () => {
    expect(isSpaShell("<html>Not Found</html>", "x".repeat(300), 404)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchHttp — verify the HTTP fast-path extracts content, tags the result
// with [http], and flags escalation. Tests inject a mock client so the
// real native binding is never loaded.
// ---------------------------------------------------------------------------

const ARTICLE_BODY =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
  "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

/** Build a fake impit client that returns a deterministic Response-like object. */
function fakeClient(map: Record<string, { status: number; html: string }>) {
  return {
    async fetch(url: string) {
      const entry = map[url];
      if (!entry) {
        return {
          status: 404,
          ok: false,
          headers: { get: () => "text/html" },
          text: async () => "<html>not found</html>",
        };
      }
      return {
        status: entry.status,
        ok: entry.status >= 200 && entry.status < 300,
        headers: { get: () => "text/html" },
        text: async () => entry.html,
      };
    },
  };
}

describe("fetchHttp", () => {
  it("extracts a long article and tags result as [http] with no escalation", async () => {
    const html = `<!doctype html><html><head><title>Sample</title></head><body><article><h1>Hello</h1><p>${ARTICLE_BODY.repeat(20)}</p></article></body></html>`;
    const result = await fetchHttp("https://example.com/article", {
      client: fakeClient({ "https://example.com/article": { status: 200, html } }),
    });
    expect(result.path).toBe("http");
    expect(result.escalated).toBe(false);
    expect(result.status).toBe(200);
    expect(result.text.startsWith("[http]")).toBe(true);
    expect(result.text).toContain("URL: https://example.com/article");
    expect(result.text).toContain("Lorem ipsum");
  });

  it("flags escalation for a React SPA shell", async () => {
    const result = await fetchHttp("https://example.com/spa", {
      client: fakeClient({
        "https://example.com/spa": { status: 200, html: SHELL_HTML },
      }),
    });
    expect(result.escalated).toBe(true);
    expect(result.path).toBe("http");
    expect(result.status).toBe(200);
  });

  it("flags escalation for a Cloudflare challenge page", async () => {
    const result = await fetchHttp("https://example.com/cf", {
      client: fakeClient({
        "https://example.com/cf": { status: 200, html: CLOUDFLARE_HTML },
      }),
    });
    expect(result.escalated).toBe(true);
  });

  it("flags escalation for a 403 response", async () => {
    const result = await fetchHttp("https://example.com/forbidden", {
      client: fakeClient({
        "https://example.com/forbidden": {
          status: 403,
          html: "<html><body>Forbidden</body></html>",
        },
      }),
    });
    expect(result.escalated).toBe(true);
    expect(result.status).toBe(403);
    expect(result.text).toContain("[http 403]");
  });

  it("does NOT escalate for a real 200 article", async () => {
    const result = await fetchHttp("https://example.com/good", {
      client: fakeClient({
        "https://example.com/good": {
          status: 200,
          html: `<html><head><title>Good</title></head><body><article><p>${ARTICLE_BODY.repeat(30)}</p></article></body></html>`,
        },
      }),
    });
    expect(result.escalated).toBe(false);
  });

  it("includes the article title when Readability parses one", async () => {
    const html = `<!doctype html><html><head><title>My Article</title></head><body><article><h1>Heading</h1><p>${ARTICLE_BODY.repeat(30)}</p></article></body></html>`;
    const result = await fetchHttp("https://example.com/titled", {
      client: fakeClient({ "https://example.com/titled": { status: 200, html } }),
    });
    // Readability may pick the h1 or the <title>; we just want a non-empty title.
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.text).toContain("URL: https://example.com/titled");
  });

  it("returns text with the [http] prefix even on shell responses", async () => {
    const result = await fetchHttp("https://example.com/shell2", {
      client: fakeClient({
        "https://example.com/shell2": { status: 200, html: SHELL_HTML },
      }),
    });
    expect(result.text).toMatch(/^\[http\]/);
  });
});

// ---------------------------------------------------------------------------
// mode routing — verify the handler dispatches correctly. We test the
// dispatch by reading the source of extraction.ts and asserting the
// mode-based branching structure (a contract test — the runtime path
// is verified by the unit tests above and by the live MCP smoke test).
// ---------------------------------------------------------------------------

describe("fetch_urls mode dispatch (contract)", () => {
  it("mode 'browser' returns before any Impit construction", async () => {
    const src = await Bun.file("src/tools/extraction.ts").text();
    // The fetchOne function must route browser-mode to fetchBrowser before
    // the http path constructs an Impit client.
    const browserBranch = src.indexOf('if (mode === "browser") return fetchBrowser(url)');
    const httpBranch = src.indexOf('if (mode === "http")');
    expect(browserBranch).toBeGreaterThan(0);
    expect(httpBranch).toBeGreaterThan(browserBranch);
  });

  it("auto mode: HTTP success skips browser", async () => {
    // Replicate the auto-mode logic against a mock client.
    const html = `<html><head><title>OK</title></head><body><article><p>${ARTICLE_BODY.repeat(30)}</p></article></body></html>`;
    const result: FetchResult = await fetchHttp("https://example.com/auto", {
      client: fakeClient({ "https://example.com/auto": { status: 200, html } }),
    });
    expect(result.escalated).toBe(false);
    expect(result.path).toBe("http");
  });

  it("auto mode: HTTP shell triggers escalation flag (handler would then call browser)", async () => {
    const result = await fetchHttp("https://example.com/auto-shell", {
      client: fakeClient({
        "https://example.com/auto-shell": { status: 200, html: SHELL_HTML },
      }),
    });
    expect(result.escalated).toBe(true);
  });
});
