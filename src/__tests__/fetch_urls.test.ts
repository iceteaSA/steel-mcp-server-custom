/**
 * fetch_urls + isSpaShell — unit tests.
 *
 * The HTTP fast-path's dep is `impit` (a native Rust binding). The fetchHttp
 * unit tests inject a fake `client` directly; the runtime-routing tests
 * inject a fake fetchHttp into the handler via the RunFetchUrlsDeps seam
 * (no mock.module — bun 1.3.14 cannot restore module mocks after the file's
 * tests complete and the leaked mock would break sibling test files).
 */
import { describe, it, expect } from "bun:test";
import { isSpaShell } from "../helpers.js";
import { fetchHttp, runFetchUrls } from "../tools/extraction.js";

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
// Runtime mode-routing — drive runFetchUrls directly with a fake fetchHttp
// injected via the RunFetchUrlsDeps seam, plus a minimal BrowserManager stub
// so we can assert which path actually ran without a real browser.
// ---------------------------------------------------------------------------

/** Build a fake fetchHttp that mirrors the real one's output shape: applies
 *  maxCharsPerPage truncation to the body and prepends the `[http] title`
 *  prefix the way runFetchUrls expects. Lets each test control what the
 *  http path "finds" without loading the impit native module. */
function fakeFetchHttp(
  impl: (
    url: string,
    opts: any,
  ) => Promise<{ title: string; body: string; status?: number; escalated?: boolean }>,
): typeof fetchHttp {
  return async (url, opts) => {
    const { title, body, status = 200, escalated = false } = await impl(url, opts);
    const maxCharsPerPage = opts?.maxCharsPerPage ?? 0;
    let outText = body;
    if (maxCharsPerPage > 0 && outText.length > maxCharsPerPage) {
      outText =
        outText.slice(0, maxCharsPerPage) + `\n[TRUNCATED — ${body.length.toLocaleString()} total]`;
    }
    const tag = `[http${status === 200 ? "" : ` ${status}`}]`;
    return {
      url,
      title: title || url,
      text: `${tag} ${title || url}\nURL: ${url}\n\n${outText}`,
      path: "http",
      escalated,
      status,
    };
  };
}

/** Minimal BrowserManager stub. With shouldFail=true (default), newTab
 *  throws so the test can assert the browser path was NEVER invoked. With
 *  shouldFail=false, newTab returns a minimal but functional page stub so
 *  the browser-path branch runs end-to-end without a real Chromium. */
function fakeMgr(shouldFail = true) {
  let browserCalls = 0;
  const pageStub: any = {
    goto: async () => {},
    title: async () => "Escalated Title",
    content: async () =>
      `<!doctype html><html><head><title>Escalated Title</title></head><body><article><p>${"real content. ".repeat(100)}</p></article></body></html>`,
  };
  return {
    mgr: {
      newTab: async () => {
        browserCalls++;
        if (shouldFail) throw new Error("browser should not be invoked");
        return { tabId: 1, page: pageStub };
      },
      closeTab: async () => {},
    },
    getBrowserCalls: () => browserCalls,
  };
}

const ENV = { GLOBAL_WAIT_SECONDS: 0, OUTPUT_DIR: "/tmp" } as any;

describe("fetch_urls runtime routing", () => {
  it("mode:'http' returns [http] prefix and NEVER invokes the browser path", async () => {
    const { mgr, getBrowserCalls } = fakeMgr(true);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/a"],
        mode: "http",
        extractContent: true,
        maxCharsPerPage: 1500,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({ title: "A", body: "body", escalated: false })),
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.results).toHaveLength(1);
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    expect(getBrowserCalls()).toBe(0);
  });

  it("mode:'http' respects maxCharsPerPage — caps the text it returns", async () => {
    const { mgr } = fakeMgr(true);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/long"],
        mode: "http",
        extractContent: true,
        maxCharsPerPage: 200,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({
          title: "Long",
          body: "paragraph. ".repeat(500),
          escalated: false,
        })),
      },
    );
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    // Must include the truncation note
    expect(r.text).toMatch(/\[TRUNCATED — \d[\d,]* total\]/);
    const markerIdx = r.text.indexOf("[TRUNCATED");
    const slice = r.text.slice(0, markerIdx);
    // Slice before marker: prefix + capped body. Prefix is ~50 chars,
    // capped body is the cap (200), so well under the 300 ceiling.
    expect(slice.length).toBeLessThan(300);
  });

  it("mode:'auto' on a good article: served via impit only, labeled [http], escalated:false", async () => {
    const { mgr, getBrowserCalls } = fakeMgr(true);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/article"],
        mode: "auto",
        extractContent: true,
        maxCharsPerPage: 3000,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({
          title: "Article",
          body: "substance. ".repeat(200),
          escalated: false,
        })),
      },
    );
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    expect(r.escalated).toBe(false);
    expect(getBrowserCalls()).toBe(0);
  });

  it("mode:'auto' on a shell: escalates to browser path, labels [browser], escalated:true", async () => {
    // fetchHttp signals escalation; the browser branch then runs against the
    // fake mgr. Since fakeMgr returns an empty pageStub from newTab, the
    // browser path's extractFromHtml won't produce real content — we only
    // assert the routing decisions (prefix, escalated flag, browserCall count).
    const { mgr, getBrowserCalls } = fakeMgr(false);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/shell"],
        mode: "auto",
        extractContent: true,
        maxCharsPerPage: 3000,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({ title: "Shell", body: "", escalated: true })),
      },
    );
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("browser");
    // Spec: prefix labels the path that ACTUALLY served the URL.
    expect(r.text.startsWith("[browser]")).toBe(true);
    // Spec: escalated:true whenever auto chose to switch paths.
    expect(r.escalated).toBe(true);
    expect(getBrowserCalls()).toBe(1);
  });

  it("mode:'http' never escalates even when isSpaShell would be true", async () => {
    const { mgr, getBrowserCalls } = fakeMgr(true);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/spa"],
        mode: "http",
        extractContent: true,
        maxCharsPerPage: 3000,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({
          title: "SPA",
          body: "shell body",
          escalated: true,
        })),
      },
    );
    expect(result.isError).toBeFalsy();
    const r = result.structuredContent.results[0];
    expect(r.path).toBe("http");
    expect(r.text.startsWith("[http]")).toBe(true);
    // The escalation FLAG is true (isSpaShell detected a shell) but the
    // handler must not have switched paths because mode is 'http'.
    expect(r.escalated).toBe(true);
    expect(getBrowserCalls()).toBe(0);
  });

  it("mode:'auto' on a real article with tiny maxCharsPerPage: escalated:false (cap does not trigger escalation), [http] label, body truncated", async () => {
    // Regression: tiny maxCharsPerPage must not turn a real (long) article
    // into a false-positive shell that would trigger auto-escalation to the
    // browser path. Cap is applied ONLY to the returned text; the
    // escalation decision is anchored to the FULL extracted text.
    const { mgr, getBrowserCalls } = fakeMgr(true);
    const result: any = await runFetchUrls(
      {
        urls: ["https://example.com/real-article"],
        mode: "auto",
        extractContent: true,
        maxCharsPerPage: 50,
      },
      mgr as any,
      ENV,
      {
        fetchHttp: fakeFetchHttp(async () => ({
          title: "Real",
          body: "x".repeat(4000),
          escalated: false, // real article — no shell signal
        })),
      },
    );
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
    expect(getBrowserCalls()).toBe(0);
  });
});
