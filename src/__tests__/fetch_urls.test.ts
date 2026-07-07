/**
 * fetch_urls + isSpaShell — unit tests with mocked impit.
 *
 * The HTTP fast-path's dep is `impit` (a native Rust binding). We test the
 * extraction / escalation logic by injecting a fake `client` — keeps the
 * test runnable on any machine without the .node binary and makes the
 * behaviour deterministic.
 */
import { describe, it, expect, mock } from "bun:test";
import { isSpaShell } from "../helpers.js";
import { fetchHttp } from "../tools/extraction.js";

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
// Runtime mode-routing — drive the real handler with impit + BrowserManager
// mocked so we can assert which path actually ran without a real browser.
// We use mock.module to swap the impit client, and we drive the handler
// directly by capturing it through a fake registrar passed to register().
// ---------------------------------------------------------------------------

/** Stub the impit module — every fetch call goes through `fetchImpl`. The
 *  handler imports `Impit` and does `new Impit({ browser, timeout })`.
 *  Returns a re-import of extraction.ts so the new mock is what the handler
 *  sees when its top-level `import { Impit } from "impit"` is evaluated. */
function stubImpitAndReimport(fetchImpl: (_url: string) => Promise<any>): Promise<any> {
  mock.module("impit", () => ({
    Impit: class {
      opts: any;
      constructor(opts: any) {
        this.opts = opts;
      }
      fetch(url: string) {
        return fetchImpl(url);
      }
    },
  }));
  // Force bun to re-evaluate extraction.ts so it picks up the new mock.
  return import(`../tools/extraction.js?bust=${Date.now()}-${Math.random()}`).then((m: any) => m);
}

/** Capture the fetch_urls handler by running register() with a fake registrar. */
function captureFetchUrlsHandler(mod: any, mgr: any, env: any) {
  let captured: any = null;
  const fakeReg = (spec: any) => {
    if (spec.name === "fetch_urls") captured = spec;
  };
  mod.register(fakeReg as any, mgr, env);
  if (!captured) throw new Error("fetch_urls handler not captured");
  return captured.handler;
}

const ARTICLE_HTML_FN = (body: string) =>
  `<!doctype html><html><head><title>Article</title></head><body><article><h1>Hello</h1><p>${body}</p></article></body></html>`;

describe("fetch_urls runtime routing (impit mocked)", () => {
  it("mode:'http' returns [http] prefix and NEVER invokes the browser path", async () => {
    let browserCalls = 0;
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => ARTICLE_HTML_FN("x".repeat(500)),
    }));

    const mgr = {
      newTab: async () => {
        browserCalls++;
        throw new Error("browser should not be invoked under mode:http");
      },
      closeTab: async () => {},
    };

    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/a"],
      mode: "http",
      extractContent: true,
      maxCharsPerPage: 1500,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.results).toHaveLength(1);
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    expect(browserCalls).toBe(0);
  });

  it("mode:'http' respects maxCharsPerPage — caps the text it returns", async () => {
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => ARTICLE_HTML_FN("paragraph. ".repeat(500)),
    }));

    const mgr = {
      newTab: async () => {
        throw new Error("browser should not be invoked under mode:http");
      },
      closeTab: async () => {},
    };
    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/long"],
      mode: "http",
      extractContent: true,
      maxCharsPerPage: 200,
    });
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    // Must include the truncation note
    expect(r.text).toMatch(/\[TRUNCATED — \d[\d,]* total\]/);
    const bodyStart = r.text.indexOf("# Article");
    const body = r.text.slice(bodyStart);
    // body should be <= cap + the truncation marker (~30 chars)
    expect(body.length).toBeLessThanOrEqual(250);
  });

  it("mode:'auto' on a good article: served via impit only, labeled [http], escalated:false", async () => {
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => ARTICLE_HTML_FN("substance. ".repeat(200)),
    }));

    let browserCalls = 0;
    const mgr = {
      newTab: async () => {
        browserCalls++;
        throw new Error("browser should not run when http path succeeds");
      },
      closeTab: async () => {},
    };

    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/article"],
      mode: "auto",
      extractContent: true,
      maxCharsPerPage: 3000,
    });
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    expect(r.escalated).toBe(false);
    expect(browserCalls).toBe(0);
  });

  it("mode:'auto' on a shell: escalates to browser path, labels [browser], escalated:true", async () => {
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      // Empty body triggers isSpaShell (text < 200 chars AND html < 2000 chars)
      text: async () => "<!doctype html><html><body><div id='root'></div></body></html>",
    }));

    // Build a minimal page stub that the withBackgroundTab helper will use
    // when the handler escalates. The fake manager's newTab must return a
    // page shape the browser branch can call .goto + .title + .content on.
    const mgr = {
      newTab: async () => {
        const pageStub: any = {
          goto: async () => {},
          title: async () => "Escalated Title",
          content: async () =>
            ARTICLE_HTML_FN("Real content after browser escalation. ".repeat(20)),
        };
        return { tabId: 1, page: pageStub };
      },
      closeTab: async () => {},
    };

    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/shell"],
      mode: "auto",
      extractContent: true,
      maxCharsPerPage: 3000,
    });
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("browser");
    // Spec: prefix labels the path that ACTUALLY served the URL.
    expect(r.text.startsWith("[browser]")).toBe(true);
    // Spec: escalated:true whenever auto chose to switch paths.
    expect(r.escalated).toBe(true);
    // The browser-served article body should be present
    expect(r.text).toContain("Real content after browser escalation");
  });

  it("mode:'http' never escalates even when isSpaShell would be true", async () => {
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => SHELL_HTML,
    }));

    let browserCalls = 0;
    const mgr = {
      newTab: async () => {
        browserCalls++;
        throw new Error("mode:http must never open a browser tab");
      },
      closeTab: async () => {},
    };

    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/spa"],
      mode: "http",
      extractContent: true,
      maxCharsPerPage: 3000,
    });
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    // The escalation FLAG is true (isSpaShell detected a shell) but the
    // handler must not have switched paths because mode is 'http'.
    expect(r.escalated).toBe(true);
    expect(browserCalls).toBe(0);
  });

  it("mode:'auto' on a real article with tiny maxCharsPerPage: escalated:false (cap does not trigger escalation), [http] label, body truncated", async () => {
    // Regression: tiny maxCharsPerPage must not turn a real (long) article
    // into a false-positive shell that would trigger auto-escalation to the
    // browser path. Cap is applied ONLY to the returned text; the
    // escalation decision is anchored to the FULL extracted text.
    const longBody = "real article body. ".repeat(200); // ~4000 chars
    const mod = await stubImpitAndReimport(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "text/html" },
      text: async () => ARTICLE_HTML_FN(longBody),
    }));

    let browserCalls = 0;
    const mgr = {
      newTab: async () => {
        browserCalls++;
        throw new Error("auto must NOT escalate a real article just because maxCharsPerPage=50");
      },
      closeTab: async () => {},
    };

    const env = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" };
    const handler = captureFetchUrlsHandler(mod, mgr, env);
    const result: any = await handler({
      urls: ["https://example.com/real-article"],
      mode: "auto",
      extractContent: true,
      maxCharsPerPage: 50,
    });
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    // The escalation decision is anchored to the FULL text, not the
    // truncated slice — a 4 KB real article must NOT be flagged as a shell.
    expect(r.escalated).toBe(false);
    // The returned body is capped with the truncation marker.
    expect(r.text).toMatch(/\[TRUNCATED — \d[\d,]* total\]/);
    // …and the slice before the marker is bounded by the cap.
    const markerIdx = r.text.indexOf("[TRUNCATED");
    const body = r.text.slice(0, markerIdx);
    // First char of body is somewhere after the "[http] title\nURL: url\n\n"
    // prefix; we only assert the prefix + slice combined stay small.
    expect(body.length).toBeLessThan(150);
    expect(browserCalls).toBe(0);
  });
});
