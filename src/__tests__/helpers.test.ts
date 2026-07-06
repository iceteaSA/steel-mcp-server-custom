import { describe, it, expect } from "bun:test";
import {
  collapseWhitespace,
  isBotWall,
  detectErrorPage,
  ErrorTracker,
  CAPTCHA_WAIT_TOTAL_MS,
  CAPTCHA_POLL_INTERVAL_MS,
  dedupeLinks,
  pickPrimaryLink,
  findTitle,
  capText,
  isBrowserClosedError,
  isSteelSessionStuck,
  detectFieldKind,
  interpretCheckboxValue,
  isCheckboxTruthy,
  buildRadioSelector,
  matchesCookieHost,
  mimeToExt,
  deriveDownloadFilename,
  cleanErrorMessage,
  extractPageContent,
  type Link,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// collapseWhitespace
// ---------------------------------------------------------------------------
describe("collapseWhitespace", () => {
  it("collapses spaces and tabs", () => {
    expect(collapseWhitespace("hello   world\t\ttab")).toBe("hello world tab");
  });
  it("collapses newlines", () => {
    expect(collapseWhitespace("a\n\n\nb")).toBe("a b");
  });
  it("trims edges", () => {
    expect(collapseWhitespace("  padded  ")).toBe("padded");
  });
  it("handles null/undefined/empty", () => {
    expect(collapseWhitespace(null)).toBe("");
    expect(collapseWhitespace(undefined)).toBe("");
    expect(collapseWhitespace("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isBotWall
// ---------------------------------------------------------------------------
describe("isBotWall", () => {
  it("detects Cloudflare 'Just a moment'", () => {
    expect(isBotWall("Just a moment...", "https://example.com")).toBe(true);
  });
  it("detects 'Attention Required'", () => {
    expect(isBotWall("Attention Required!", "https://example.com")).toBe(true);
  });
  it("detects 'Access Denied'", () => {
    expect(isBotWall("Access Denied", "https://example.com")).toBe(true);
  });
  it("detects 'Verify you are human'", () => {
    expect(isBotWall("Verify you are human", "https://example.com")).toBe(true);
  });
  it("detects challenge-platform URL", () => {
    expect(isBotWall("OK", "https://example.com/cdn-cgi/challenge-platform/check")).toBe(true);
  });
  it("passes normal pages", () => {
    expect(isBotWall("Google Search", "https://www.google.com/search?q=test")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(isBotWall("JUST A MOMENT", "https://example.com")).toBe(true);
  });

  // New patterns added for expanded detection
  it("detects Google /sorry page by URL", () => {
    expect(isBotWall("", "https://www.google.com/sorry/index?continue=...")).toBe(true);
  });
  it("detects Google sorry redirect", () => {
    expect(isBotWall("", "https://google.com/sorry/index")).toBe(true);
  });
  it("detects 'unusual traffic' title", () => {
    expect(isBotWall("Our systems have detected unusual traffic", "https://example.com")).toBe(
      true,
    );
  });
  it("detects 'are you a robot' title", () => {
    expect(isBotWall("Are you a robot?", "https://example.com")).toBe(true);
  });
  it("detects 'captcha' in title", () => {
    expect(isBotWall("Please complete the CAPTCHA", "https://example.com")).toBe(true);
  });
  it("detects 'human verification' title", () => {
    expect(isBotWall("Human Verification Required", "https://example.com")).toBe(true);
  });
  it("detects reCAPTCHA URL", () => {
    expect(isBotWall("", "https://www.google.com/recaptcha/api/siteverify")).toBe(true);
  });
  it("detects hCaptcha URL", () => {
    expect(isBotWall("", "https://hcaptcha.com/captcha/v1/abc123")).toBe(true);
  });
  it("detects Cloudflare challenges URL", () => {
    expect(isBotWall("", "https://challenges.cloudflare.com/turnstile/v0/abc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectErrorPage
// ---------------------------------------------------------------------------
describe("detectErrorPage", () => {
  it("detects GitHub 404", () => {
    expect(detectErrorPage("Page not found · GitHub · GitHub")).toBe("404");
  });
  it("detects generic 'Page not found'", () => {
    expect(detectErrorPage("Page not found")).toBe("404");
  });
  it("detects '404' in title", () => {
    expect(detectErrorPage("404 - Not Found")).toBe("404");
  });
  it("detects '404 Not Found'", () => {
    expect(detectErrorPage("404 Not Found")).toBe("404");
  });
  it("detects '403 Forbidden'", () => {
    expect(detectErrorPage("403 Forbidden")).toBe("403");
  });
  it("detects '500 Internal Server Error'", () => {
    expect(detectErrorPage("500 Internal Server Error")).toBe("500");
  });
  it("detects '502 Bad Gateway'", () => {
    expect(detectErrorPage("502 Bad Gateway")).toBe("502");
  });
  it("returns null for normal page titles", () => {
    expect(detectErrorPage("Google Search")).toBeNull();
    expect(detectErrorPage("GitHub - microsoft/playwright")).toBeNull();
    expect(detectErrorPage("My Cool Website")).toBeNull();
  });
  it("is case-insensitive", () => {
    expect(detectErrorPage("PAGE NOT FOUND")).toBe("404");
    expect(detectErrorPage("Not Found")).toBe("404");
  });
  it("returns null for empty title", () => {
    expect(detectErrorPage("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CAPTCHA wait constants
// ---------------------------------------------------------------------------
describe("CAPTCHA wait constants", () => {
  it("has reasonable wait total (10-30s)", () => {
    expect(CAPTCHA_WAIT_TOTAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(CAPTCHA_WAIT_TOTAL_MS).toBeLessThanOrEqual(30_000);
  });
  it("has reasonable poll interval (1-5s)", () => {
    expect(CAPTCHA_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(CAPTCHA_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
  });
  it("allows multiple polls within total wait", () => {
    expect(CAPTCHA_WAIT_TOTAL_MS / CAPTCHA_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// ErrorTracker
// ---------------------------------------------------------------------------
describe("ErrorTracker", () => {
  it("returns null for fresh URLs", () => {
    const t = new ErrorTracker();
    expect(t.check("https://github.com/org/repo")).toBeNull();
  });

  it("warns after exact URL repeated (default threshold 2)", () => {
    const t = new ErrorTracker();
    t.record("https://github.com/org/repo");
    t.record("https://github.com/org/repo");
    const warn = t.check("https://github.com/org/repo");
    expect(warn).toContain("failed 2 time(s)");
  });

  it("warns after same domain repeated (default threshold 5)", () => {
    const t = new ErrorTracker();
    t.record("https://github.com/a/1");
    t.record("https://github.com/a/2");
    t.record("https://github.com/a/3");
    t.record("https://github.com/a/4");
    t.record("https://github.com/a/5");
    const warn = t.check("https://github.com/a/6");
    expect(warn).toContain("5 recent errors on github.com");
  });

  it("normalises URLs — strips query and fragment", () => {
    const t = new ErrorTracker();
    t.record("https://example.com/page?q=1#top");
    t.record("https://example.com/page?q=2#bottom");
    const warn = t.check("https://example.com/page?q=3");
    expect(warn).toContain("failed 2 time(s)");
  });

  it("respects custom thresholds", () => {
    const t = new ErrorTracker({ urlThreshold: 1, domainThreshold: 2 });
    t.record("https://example.com/a");
    expect(t.check("https://example.com/a")).toContain("failed 1 time(s)");
    expect(t.check("https://example.com/b")).toBeNull(); // only 1 domain hit
    t.record("https://example.com/b");
    expect(t.check("https://example.com/c")).toContain("2 recent errors");
  });

  it("ring buffer evicts old entries", () => {
    const t = new ErrorTracker({ maxEntries: 3, urlThreshold: 3 });
    t.record("https://a.com/1");
    t.record("https://a.com/1");
    t.record("https://b.com/x"); // pushes oldest a.com/1 out
    // Now only 1 a.com/1 entry remains + 1 b.com
    expect(t.check("https://a.com/1")).toBeNull(); // below threshold of 3
  });

  it("clear() resets state", () => {
    const t = new ErrorTracker();
    t.record("https://example.com/x");
    t.record("https://example.com/x");
    t.clear();
    expect(t.check("https://example.com/x")).toBeNull();
  });

  it("handles malformed URLs gracefully", () => {
    const t = new ErrorTracker();
    t.record("not-a-url");
    t.record("not-a-url");
    expect(t.check("not-a-url")).toContain("failed 2 time(s)");
  });
});

// ---------------------------------------------------------------------------
// dedupeLinks
// ---------------------------------------------------------------------------
describe("dedupeLinks", () => {
  it("deduplicates by href (fragment stripped)", () => {
    const links: Link[] = [
      { text: "First", href: "https://a.com/article#top" },
      { text: "Second", href: "https://a.com/article#bottom" },
    ];
    const result = dedupeLinks(links);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("First"); // first non-empty wins
  });

  it("upgrades empty text to first non-empty", () => {
    const links: Link[] = [
      { text: "", href: "https://a.com/x" },
      { text: "Real Title", href: "https://a.com/x" },
    ];
    const result = dedupeLinks(links);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Real Title");
  });

  it("preserves distinct URLs", () => {
    const links: Link[] = [
      { text: "A", href: "https://a.com/1" },
      { text: "B", href: "https://a.com/2" },
    ];
    expect(dedupeLinks(links)).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(dedupeLinks([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pickPrimaryLink
// ---------------------------------------------------------------------------
describe("pickPrimaryLink", () => {
  it("picks first link with path depth >= 2", () => {
    const links: Link[] = [
      { text: "Category", href: "https://news.com/world/" },
      { text: "Article", href: "https://news.com/world/headline-slug-123" },
      { text: "Another", href: "https://news.com/tech/other-456" },
    ];
    expect(pickPrimaryLink(links)).toBe("https://news.com/world/headline-slug-123");
  });

  it("falls back to first link when none qualify", () => {
    const links: Link[] = [
      { text: "Home", href: "https://news.com/" },
      { text: "World", href: "https://news.com/world/" },
    ];
    // /world/ has 1 segment — doesn't qualify. Falls back to first.
    expect(pickPrimaryLink(links)).toBe("https://news.com/");
  });

  it("returns undefined for empty list", () => {
    expect(pickPrimaryLink([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findTitle
// ---------------------------------------------------------------------------
describe("findTitle", () => {
  it("finds title by matching primary link href", () => {
    const links: Link[] = [
      { text: "Nav", href: "https://a.com/nav" },
      { text: "The Headline", href: "https://a.com/article-123" },
    ];
    expect(findTitle("https://a.com/article-123", links)).toBe("The Headline");
  });

  it("ignores fragments when matching", () => {
    const links: Link[] = [{ text: "Title", href: "https://a.com/post#top" }];
    expect(findTitle("https://a.com/post#bottom", links)).toBe("Title");
  });

  it("returns undefined when no match", () => {
    expect(findTitle("https://a.com/nope", [])).toBeUndefined();
  });

  it("returns undefined for undefined primaryLink", () => {
    expect(findTitle(undefined, [{ text: "X", href: "https://a.com" }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// capText
// ---------------------------------------------------------------------------
describe("capText", () => {
  it("truncates and appends ellipsis", () => {
    expect(capText("Hello World", 5)).toBe("Hello…");
  });

  it("returns full string when within limit", () => {
    expect(capText("Short", 100)).toBe("Short");
  });

  it("returns full string when exactly at limit", () => {
    expect(capText("12345", 5)).toBe("12345");
  });

  it("disables truncation for maxChars <= 0", () => {
    expect(capText("Long text", 0)).toBe("Long text");
    expect(capText("Long text", -1)).toBe("Long text");
  });
});

// ---------------------------------------------------------------------------
// isBrowserClosedError
// ---------------------------------------------------------------------------
describe("isBrowserClosedError", () => {
  it("detects 'Target page, context or browser has been closed'", () => {
    expect(isBrowserClosedError(new Error("Target page, context or browser has been closed"))).toBe(
      true,
    );
  });
  it("detects 'Browser has been closed'", () => {
    expect(isBrowserClosedError(new Error("Browser has been closed"))).toBe(true);
  });
  it("detects ECONNREFUSED", () => {
    expect(isBrowserClosedError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe(true);
  });
  it("detects WebSocket closed", () => {
    expect(isBrowserClosedError(new Error("WebSocket closed unexpectedly"))).toBe(true);
  });
  it("passes normal errors", () => {
    expect(isBrowserClosedError(new Error("Element not found"))).toBe(false);
  });
  it("handles null/undefined", () => {
    expect(isBrowserClosedError(null)).toBe(false);
    expect(isBrowserClosedError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSteelSessionStuck
// ---------------------------------------------------------------------------
describe("isSteelSessionStuck", () => {
  it("detects page_refresh failure", () => {
    expect(
      isSteelSessionStuck(
        new Error(
          "500 Failed after 3 attempts. Last error: Browser process error (page_refresh): Failed to refresh primary page when reusing browser",
        ),
      ),
    ).toBe(true);
  });
  it("passes normal errors", () => {
    expect(isSteelSessionStuck(new Error("Timeout 10000ms exceeded"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectFieldKind
// ---------------------------------------------------------------------------
describe("detectFieldKind", () => {
  it("detects SELECT", () => {
    expect(detectFieldKind("SELECT", null)).toBe("select");
    expect(detectFieldKind("select", null)).toBe("select");
  });
  it("detects INPUT checkbox", () => {
    expect(detectFieldKind("INPUT", "checkbox")).toBe("check");
  });
  it("detects INPUT radio", () => {
    expect(detectFieldKind("INPUT", "radio")).toBe("radio");
  });
  it("defaults to text for INPUT text/email/password", () => {
    expect(detectFieldKind("INPUT", "text")).toBe("text");
    expect(detectFieldKind("INPUT", "email")).toBe("text");
    expect(detectFieldKind("INPUT", "password")).toBe("text");
  });
  it("defaults to text for TEXTAREA", () => {
    expect(detectFieldKind("TEXTAREA", null)).toBe("text");
  });
  it("handles null/undefined", () => {
    expect(detectFieldKind(null, null)).toBe("text");
    expect(detectFieldKind(undefined, undefined)).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// interpretCheckboxValue / isCheckboxTruthy
// ---------------------------------------------------------------------------
describe("interpretCheckboxValue", () => {
  it.each(["true", "1", "on", "yes", "checked", "y"])("'%s' → check", (v) => {
    expect(interpretCheckboxValue(v)).toBe("check");
  });
  it.each(["false", "0", "off", "no", "unchecked", "n", ""])("'%s' → uncheck", (v) => {
    expect(interpretCheckboxValue(v)).toBe("uncheck");
  });
  it("arbitrary value → selectByValue", () => {
    expect(interpretCheckboxValue("cheese")).toBe("selectByValue");
    expect(interpretCheckboxValue("bacon")).toBe("selectByValue");
  });
  it("is case-insensitive", () => {
    expect(interpretCheckboxValue("TRUE")).toBe("check");
    expect(interpretCheckboxValue("False")).toBe("uncheck");
  });
});

describe("isCheckboxTruthy (back-compat)", () => {
  it("returns true for truthy tokens", () => {
    expect(isCheckboxTruthy("yes")).toBe(true);
  });
  it("returns false for falsy tokens", () => {
    expect(isCheckboxTruthy("no")).toBe(false);
  });
  it("returns false for arbitrary values", () => {
    expect(isCheckboxTruthy("cheese")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRadioSelector
// ---------------------------------------------------------------------------
describe("buildRadioSelector", () => {
  it("appends [value=...] to selector", () => {
    expect(buildRadioSelector("input[name=size]", "medium")).toBe(
      'input[name=size][value="medium"]',
    );
  });
  it("escapes quotes in value", () => {
    expect(buildRadioSelector("input[name=x]", 'a"b')).toBe('input[name=x][value="a\\"b"]');
  });
  it("returns unchanged if value attribute already present", () => {
    expect(buildRadioSelector("input[name=size][value=xl]", "xl")).toBe(
      "input[name=size][value=xl]",
    );
  });
});

// ---------------------------------------------------------------------------
// matchesCookieHost
// ---------------------------------------------------------------------------
describe("matchesCookieHost", () => {
  it("exact match", () => {
    expect(matchesCookieHost("example.com", "example.com")).toBe(true);
  });
  it("leading dot domain matches host", () => {
    expect(matchesCookieHost(".example.com", "example.com")).toBe(true);
  });
  it("subdomain matches parent cookie", () => {
    expect(matchesCookieHost(".example.com", "www.example.com")).toBe(true);
  });
  it("subdomain cookie matches parent host (lenient for cookie filtering)", () => {
    // Implementation is intentionally lenient — www.example.com cookie matches
    // example.com host, which handles cases where Set-Cookie came from a subdomain
    // redirect chain but the user filters by bare domain.
    expect(matchesCookieHost("www.example.com", "example.com")).toBe(true);
  });
  it("unrelated domains don't match", () => {
    expect(matchesCookieHost("other.com", "example.com")).toBe(false);
  });
  it("handles null/undefined", () => {
    expect(matchesCookieHost(null, "example.com")).toBe(false);
    expect(matchesCookieHost("example.com", null)).toBe(false);
  });
  it("case-insensitive", () => {
    expect(matchesCookieHost("Example.COM", "example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mimeToExt
// ---------------------------------------------------------------------------
describe("mimeToExt", () => {
  it("maps common MIME types", () => {
    expect(mimeToExt("application/pdf")).toBe(".pdf");
    expect(mimeToExt("text/csv")).toBe(".csv");
    expect(mimeToExt("image/png")).toBe(".png");
    expect(mimeToExt("image/webp")).toBe(".webp");
  });
  it("strips parameters", () => {
    expect(mimeToExt("text/html; charset=utf-8")).toBe(".html");
  });
  it("returns empty for unknown MIME", () => {
    expect(mimeToExt("application/x-custom")).toBe("");
  });
  it("handles null/undefined", () => {
    expect(mimeToExt(null)).toBe("");
    expect(mimeToExt(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deriveDownloadFilename
// ---------------------------------------------------------------------------
describe("deriveDownloadFilename", () => {
  it("extracts last path segment", () => {
    expect(deriveDownloadFilename("https://example.com/files/report.pdf")).toBe("report.pdf");
  });
  it("handles trailing slash", () => {
    // No filename after slash → falls through to timestamp
    const result = deriveDownloadFilename("https://example.com/files/");
    expect(result).toBe("files");
  });
  it("falls back for root URL", () => {
    const result = deriveDownloadFilename("https://example.com/");
    expect(result).toMatch(/^download_\d+$/);
  });
  it("falls back for malformed URL", () => {
    const result = deriveDownloadFilename("not a url");
    expect(result).toMatch(/^download_\d+$/);
  });
});

// ---------------------------------------------------------------------------
// contentAreaExtract — golden test for shared content-area helper
// ---------------------------------------------------------------------------
describe("contentAreaExtract", () => {
  // Build a fixture HTML that exercises the full extraction logic:
  // content-area detection (main > article > [role=main] > body fallback),
  // block-tag wrapping, anchor [href] appending, whitespace collapse.
  const fixtureHTML = `<!DOCTYPE html>
<html><body>
<nav>Nav links here</nav>
<main>
  <h1>Main Title</h1>
  <p>First paragraph with <a href="https://example.com/link1">a link</a> inside.</p>
  <article>
    <h2>Article Heading</h2>
    <p>Article body text with <a href="https://example.com/link2">another link</a> and more content.</p>
    <footer>Article footer</footer>
  </article>
  <script>var x = 1;</script>
  <div>Extra div content</div>
</main>
<footer>Site footer</footer>
</body></html>`;

  // Golden values derived from the pre-refactor extraction code
  // (git show 536a0e1:src/tools/extraction.ts lines 299-369) run against
  // the fixture above via linkedom. Locks exact output so the refactored
  // helper must produce identical results.
  const goldenWalkOutput =
    "Main Title\n\n \nFirst paragraph with a link [https://example.com/link1] inside.\n\n \n\n \nArticle Heading\n\n \nArticle body text with another link [https://example.com/link2] and more content.\n\n \nArticle footer\n\n \n\n var x = 1;\n \nExtra div content";
  const goldenInnerTextOutput =
    "Main Title \nFirst paragraph with a link inside. \n \nArticle Heading \nArticle body text with another link and more content. \nArticle footer var x = 1; \nExtra div content";

  it("walk mode matches pre-refactor includeLinks output", async () => {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(fixtureHTML);
    const result = extractPageContent(
      { selector: null, includeLinks: true, mode: "walk" },
      document,
    );
    expect(result.text).toBe(goldenWalkOutput);
  });

  it("innerText mode matches pre-refactor no-link output", async () => {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(fixtureHTML);
    const result = extractPageContent(
      { selector: null, includeLinks: false, mode: "innerText" },
      document,
    );
    expect(result.text).toBe(goldenInnerTextOutput);
  });

  it("__noMatch when selector has no match", async () => {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(fixtureHTML);
    const result = extractPageContent(
      { selector: "#nonexistent", includeLinks: false, mode: "innerText" },
      document,
    );
    expect(result.__noMatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanErrorMessage
// ---------------------------------------------------------------------------
describe("cleanErrorMessage", () => {
  it("strips ANSI escape codes", () => {
    expect(cleanErrorMessage("Call log:\n\u001b[2m  - waiting\u001b[22m")).toBe(
      "Call log:\n  - waiting",
    );
  });
  it("strips Playwright internal frames", () => {
    const msg =
      "Error: failed\n    at UtilityScript.evaluate (:1:1)\n    at myFunction (file.js:10:5)";
    const result = cleanErrorMessage(msg);
    expect(result).toContain("Error: failed");
    expect(result).toContain("myFunction");
    expect(result).not.toContain("UtilityScript");
  });
  it("handles Error objects", () => {
    expect(cleanErrorMessage(new Error("test error"))).toBe("test error");
  });
  it("handles null/undefined", () => {
    expect(cleanErrorMessage(null)).toBe("");
    expect(cleanErrorMessage(undefined)).toBe("");
  });
});
