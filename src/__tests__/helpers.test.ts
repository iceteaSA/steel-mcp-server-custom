import { describe, it, expect, beforeAll } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseHTML } from "linkedom";
import {
  assertInsideRoot,
  checkFingerprintConsistency,
  collapseWhitespace,
  containmentDisabled,
  isBotWall,
  detectErrorPage,
  ErrorTracker,
  ERROR_TRACKER_TTL_MS,
  CAPTCHA_WAIT_TOTAL_MS,
  CAPTCHA_POLL_INTERVAL_MS,
  dedupeLinks,
  pickPrimaryLink,
  findTitle,
  capText,
  isBrowserClosedError,
  isSteelSessionStuck,
  detectFieldKind,
  detectFieldsInPage,
  interpretCheckboxValue,
  isCheckboxTruthy,
  buildRadioSelector,
  matchesCookieHost,
  mimeToExt,
  deriveDownloadFilename,
  cleanErrorMessage,
  extractPageContent,
  validateCookies,
  validateExpression,
  validateUrlPattern,
  type Link,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// checkFingerprintConsistency
// ---------------------------------------------------------------------------
describe("checkFingerprintConsistency", () => {
  const base = {
    webdriver: false,
    languages: ["en-US"],
    pluginsCount: 3,
    timeZone: "America/New_York",
    screen: { width: 1920, height: 1080 },
  };

  it("passes a mac-consistent fingerprint", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
    });
    expect(result.every((r) => r.pass)).toBe(true);
    expect(result.find((r) => r.check === "UA/platform consistency")?.pass).toBe(true);
  });

  it("passes a windows-consistent fingerprint", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "Win32",
    });
    expect(result.find((r) => r.check === "UA/platform consistency")?.pass).toBe(true);
  });

  it("passes a linux-consistent fingerprint", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "Linux x86_64",
    });
    expect(result.find((r) => r.check === "UA/platform consistency")?.pass).toBe(true);
  });

  it("flags UA Windows + platform MacIntel as mismatch", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
    });
    const uaCheck = result.find((r) => r.check === "UA/platform consistency")!;
    expect(uaCheck.pass).toBe(false);
    expect(uaCheck.observed).toContain("platform=MacIntel");
    expect(uaCheck.observed).toContain("Windows NT");
  });

  it("passes webdriver=false", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      webdriver: false,
    });
    expect(result.find((r) => r.check === "webdriver hidden")?.pass).toBe(true);
  });

  it("passes webdriver=undefined", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      webdriver: undefined,
    });
    expect(result.find((r) => r.check === "webdriver hidden")?.pass).toBe(true);
  });

  it("fails when webdriver is true", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      webdriver: true,
    });
    expect(result.find((r) => r.check === "webdriver hidden")?.pass).toBe(false);
  });

  it("passes when userAgentData.platform matches navigator.platform", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      userAgentData: { platform: "macOS" },
    });
    expect(result.find((r) => r.check === "UA/platform consistency")?.pass).toBe(true);
    expect(result.find((r) => r.check === "UA/platform consistency")?.observed).toContain(
      "userAgentData.platform=macOS",
    );
  });

  it("fails when userAgentData.platform mismatches navigator.platform", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      userAgentData: { platform: "Windows" },
    });
    expect(result.find((r) => r.check === "UA/platform consistency")?.pass).toBe(false);
  });

  it("fails when languages is empty", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      languages: [],
    });
    expect(result.find((r) => r.check === "languages non-empty")?.pass).toBe(false);
  });

  it("reports plugins count without failing", () => {
    const result = checkFingerprintConsistency({
      ...base,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      platform: "MacIntel",
      pluginsCount: 0,
    });
    const plugins = result.find((r) => r.check === "plugins count")!;
    expect(plugins.pass).toBe(true);
    expect(plugins.observed).toBe("plugins=0");
  });
});

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

  it("evicts entries older than TTL (fake clock)", () => {
    let now = 1000000;
    const t = new ErrorTracker({ now: () => now });
    t.record("https://example.com/old");
    now += ERROR_TRACKER_TTL_MS + 1;
    // After advancing past TTL, the old entry should be evicted
    expect(t.check("https://example.com/old")).toBeNull();
  });

  it("keeps entries within TTL", () => {
    let now = 1000000;
    const t = new ErrorTracker({ now: () => now, urlThreshold: 1, domainThreshold: 1 });
    t.record("https://example.com/fresh");
    now += 1000; // 1 second later — well within TTL
    expect(t.check("https://example.com/fresh")).toContain("failed 1 time(s)");
  });

  it("enforces 200-entry cap (evicts oldest)", () => {
    let now = 1000000;
    // Default-constructed tracker — real default cap of 200
    const t = new ErrorTracker({ now: () => now });
    // Record the same URL 201 times. The cap evicts the oldest entry,
    // leaving 200. With default urlThreshold=2, check() reports the count.
    for (let i = 0; i < 201; i++) {
      t.record("https://example.com/page");
    }
    // After eviction, 200 entries remain for this URL
    const warn = t.check("https://example.com/page");
    expect(warn).toContain("failed 200 time(s)");
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

  it("walk mode emits `Text []` for an anchor WITHOUT href (regression: c7724f5 byte-identical output)", async () => {
    // Pre-cleanup extractPageContent unconditionally appended ` [${href}]` when
    // includeLinks was true, so an hrefless anchor emitted `Text []`. A drift
    // cleanup introduced a `&& href` guard that broke byte-identical output
    // for hrefless anchors. This test locks the original behavior.
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(
      `<html><body><main><p>Hello <a>Text</a> world</p></main></body></html>`,
    );
    const result = extractPageContent(
      { selector: null, includeLinks: true, mode: "walk" },
      document,
    );
    expect(result.text).toBe("Hello Text [] world");
    expect(result.links).toEqual([]);
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

// ---------------------------------------------------------------------------
// detectFieldsInPage (batched kind-detection)
// ---------------------------------------------------------------------------
describe("detectFieldsInPage", () => {
  it("detects mixed form fields and returns null for missing selectors", () => {
    const html = `<!DOCTYPE html><html><body><form>
      <input type="text" id="name" />
      <select id="country"><option>US</option></select>
      <input type="checkbox" id="agree" />
      <input type="radio" name="size" value="m" id="size-m" />
    </form></body></html>`;
    const { document: doc } = parseHTML(html);
    const origDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = doc;
    try {
      const result = detectFieldsInPage(["#name", "#country", "#agree", "#size-m", "#missing"]);

      // Element info maps
      expect(result["#name"]).toEqual({ tag: "INPUT", type: "text" });
      expect(result["#country"]).toEqual({ tag: "SELECT", type: "" });
      expect(result["#agree"]).toEqual({ tag: "INPUT", type: "checkbox" });
      expect(result["#size-m"]).toEqual({ tag: "INPUT", type: "radio" });
      expect(result["#missing"]).toBeNull();

      // detectFieldKind integration
      expect(detectFieldKind(result["#name"]!.tag, result["#name"]!.type)).toBe("text");
      expect(detectFieldKind(result["#country"]!.tag, result["#country"]!.type)).toBe("select");
      expect(detectFieldKind(result["#agree"]!.tag, result["#agree"]!.type)).toBe("check");
      expect(detectFieldKind(result["#size-m"]!.tag, result["#size-m"]!.type)).toBe("radio");
      expect(detectFieldKind(null, null)).toBe("text");
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
    }
  });

  it("returns all-null for entirely missing selectors", () => {
    const { document: doc } = parseHTML("<div></div>");
    const origDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = doc;
    try {
      const result = detectFieldsInPage(["#x", ".y"]);
      expect(result["#x"]).toBeNull();
      expect(result[".y"]).toBeNull();
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
    }
  });
});

// ---------------------------------------------------------------------------
// withBackgroundTab — temp-tab helper used by download_file and fetch_urls
// ---------------------------------------------------------------------------
import { withBackgroundTab } from "../utils.js";

describe("withBackgroundTab", () => {
  it("closes tab and preserves activeTabId when the inner fn throws", async () => {
    let closedTabId: number | undefined;
    let activeAfter = -1;
    const mockMgr = {
      activeTabId: 1,
      newTab: async (_url?: string, _owner?: string, _profileName?: string, activate?: boolean) => {
        // Background tab — should NOT be activated.
        expect(activate).toBe(false);
        return { tabId: 99, page: {} as any };
      },
      closeTab: async (id: number) => {
        closedTabId = id;
      },
    };

    await withBackgroundTab(mockMgr as any, async () => {
      throw new Error("simulated failure");
    }).catch(() => {
      activeAfter = mockMgr.activeTabId;
    });

    expect(closedTabId).toBe(99);
    expect(activeAfter).toBe(1); // unchanged
  });

  it("closes tab on success and preserves activeTabId", async () => {
    let closedTabId: number | undefined;
    const mockMgr = {
      activeTabId: 5,
      newTab: async (_url?: string, _owner?: string, _profileName?: string, activate?: boolean) => {
        expect(activate).toBe(false);
        return { tabId: 42, page: {} as any };
      },
      closeTab: async (id: number) => {
        closedTabId = id;
      },
    };

    const result = await withBackgroundTab(mockMgr as any, async () => "done");

    expect(result).toBe("done");
    expect(closedTabId).toBe(42);
    expect(mockMgr.activeTabId).toBe(5); // unchanged
  });

  it("does not call closeTab if newTab throws", async () => {
    let closeCalled = false;
    const mockMgr = {
      activeTabId: 1,
      newTab: async () => {
        throw new Error("browser closed");
      },
      closeTab: async () => {
        closeCalled = true;
      },
    };

    await withBackgroundTab(mockMgr as any, async () => "unreachable").catch(() => {});

    expect(closeCalled).toBe(false);
    expect(mockMgr.activeTabId).toBe(1); // unchanged
  });
});

// ---------------------------------------------------------------------------
// validateCookies — cookie set validation (cookies tool)
// ---------------------------------------------------------------------------
describe("validateCookies", () => {
  it("accepts cookies with url", () => {
    expect(validateCookies([{ name: "a", value: "1", url: "https://example.com" }])).toEqual([]);
  });

  it("accepts cookies with domain+path", () => {
    expect(validateCookies([{ name: "a", value: "1", domain: "example.com", path: "/" }])).toEqual(
      [],
    );
  });

  it("rejects cookies missing both url and domain+path", () => {
    const violations = validateCookies([{ name: "bad", value: "1" }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Cookie "bad"');
    expect(violations[0]).toContain("needs url, or domain+path");
  });

  it("rejects cookies with domain but no path", () => {
    const violations = validateCookies([{ name: "partial", value: "1", domain: "example.com" }]);
    expect(violations).toHaveLength(1);
  });

  it("rejects cookies with path but no domain", () => {
    const violations = validateCookies([{ name: "partial", value: "1", path: "/" }]);
    expect(violations).toHaveLength(1);
  });

  it("reports all violations, not just the first", () => {
    const violations = validateCookies([
      { name: "good", value: "1", url: "https://example.com" },
      { name: "bad1", value: "2" },
      { name: "bad2", value: "3" },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('Cookie "bad1"');
    expect(violations[1]).toContain('Cookie "bad2"');
  });

  it("returns empty for empty array", () => {
    expect(validateCookies([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateExpression — evaluate tool syntax precheck
// ---------------------------------------------------------------------------
describe("validateExpression", () => {
  it("accepts valid expressions", () => {
    expect(validateExpression("1 + 1")).toBeNull();
    expect(validateExpression("document.title")).toBeNull();
    expect(validateExpression("(() => { return 42; })()")).toBeNull();
    expect(validateExpression("[1, 2, 3].map(x => x * 2)")).toBeNull();
  });

  it("rejects invalid syntax", () => {
    const err = validateExpression("1 +++ 2");
    expect(err).toContain("not valid JavaScript");
  });

  it("rejects statements (not expressions)", () => {
    const err = validateExpression("let x = 1; x");
    expect(err).toContain("not valid JavaScript");
    expect(err).toContain("single expression");
  });

  it("rejects empty expression", () => {
    const err = validateExpression("");
    expect(err).toContain("not valid JavaScript");
  });
});

// ---------------------------------------------------------------------------
// filterNetworkEvents — pure filter for get_network
// ---------------------------------------------------------------------------
import { filterNetworkEvents, type NetworkEventLike } from "../helpers.js";

function makeEvent(overrides: Partial<NetworkEventLike> = {}): NetworkEventLike {
  return {
    id: 1,
    tabId: 1,
    method: "GET",
    url: "https://example.com/",
    resourceType: "document",
    status: 200,
    at: Date.now(),
    ...overrides,
  };
}

describe("filterNetworkEvents", () => {
  it("returns all events when no filter is given", () => {
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 })];
    expect(filterNetworkEvents(events, {})).toHaveLength(2);
  });

  it("filters by tabId", () => {
    const events = [makeEvent({ id: 1, tabId: 1 }), makeEvent({ id: 2, tabId: 2 })];
    const result = filterNetworkEvents(events, { tabId: 2 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it("filters by resourceType", () => {
    const events = [
      makeEvent({ id: 1, resourceType: "xhr" }),
      makeEvent({ id: 2, resourceType: "fetch" }),
      makeEvent({ id: 3, resourceType: "script" }),
    ];
    const result = filterNetworkEvents(events, { resourceType: "fetch" });
    expect(result.map((e) => e.id)).toEqual([2]);
  });

  it("filters by url substring", () => {
    const events = [
      makeEvent({ id: 1, url: "https://a.com/api/users" }),
      makeEvent({ id: 2, url: "https://a.com/static/main.js" }),
      makeEvent({ id: 3, url: "https://b.com/api" }),
    ];
    const result = filterNetworkEvents(events, { urlPattern: "/api/" });
    expect(result.map((e) => e.id)).toEqual([1, 3]);
  });

  it("filters by /regex/ url pattern", () => {
    const events = [
      makeEvent({ id: 1, url: "https://a.com/api/users" }),
      makeEvent({ id: 2, url: "https://a.com/static/main.js" }),
      makeEvent({ id: 3, url: "https://b.com/API/orders" }),
    ];
    const result = filterNetworkEvents(events, { urlPattern: "/api/i" });
    expect(result.map((e) => e.id)).toEqual([1, 3]);
  });

  it("filters by exact status", () => {
    const events = [
      makeEvent({ id: 1, status: 200 }),
      makeEvent({ id: 2, status: 404 }),
      makeEvent({ id: 3, status: 500 }),
    ];
    expect(filterNetworkEvents(events, { status: "404" }).map((e) => e.id)).toEqual([2]);
  });

  it("filters by 4xx status range", () => {
    const events = [
      makeEvent({ id: 1, status: 200 }),
      makeEvent({ id: 2, status: 400 }),
      makeEvent({ id: 3, status: 404 }),
      makeEvent({ id: 4, status: 500 }),
    ];
    expect(filterNetworkEvents(events, { status: "4xx" }).map((e) => e.id)).toEqual([2, 3]);
  });

  it("filters by 5xx status range", () => {
    const events = [
      makeEvent({ id: 1, status: 200 }),
      makeEvent({ id: 2, status: 404 }),
      makeEvent({ id: 3, status: 500 }),
      makeEvent({ id: 4, status: 502 }),
    ];
    expect(filterNetworkEvents(events, { status: "5xx" }).map((e) => e.id)).toEqual([3, 4]);
  });

  it("ignores failed events when status range does not match", () => {
    const events = [makeEvent({ id: 1, status: 200, failed: true })];
    expect(filterNetworkEvents(events, { status: "4xx" })).toHaveLength(0);
  });

  it("limits results and keeps newest last", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: i + 1, url: `https://x/${i}` }),
    );
    const result = filterNetworkEvents(events, { limit: 3 });
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.id)).toEqual([8, 9, 10]);
  });

  it("combines filters", () => {
    const events = [
      makeEvent({ id: 1, tabId: 1, resourceType: "xhr", status: 200, url: "/api/a" }),
      makeEvent({ id: 2, tabId: 1, resourceType: "xhr", status: 404, url: "/api/b" }),
      makeEvent({ id: 3, tabId: 2, resourceType: "xhr", status: 404, url: "/api/b" }),
      makeEvent({ id: 4, tabId: 1, resourceType: "script", status: 404, url: "/api/b" }),
    ];
    const result = filterNetworkEvents(events, {
      tabId: 1,
      resourceType: "xhr",
      status: "4xx",
      urlPattern: "/api/b",
      limit: 1,
    });
    expect(result.map((e) => e.id)).toEqual([2]);
  });
});

describe("validateUrlPattern", () => {
  it("returns undefined for valid substring patterns", () => {
    expect(validateUrlPattern("/api/")).toBeUndefined();
    expect(validateUrlPattern("example.com")).toBeUndefined();
  });

  it("returns undefined for valid regex patterns", () => {
    expect(validateUrlPattern("/api/i")).toBeUndefined();
    expect(validateUrlPattern("/^https://")).toBeUndefined();
  });

  it("returns an error for invalid regex patterns", () => {
    const err = validateUrlPattern("/[");
    expect(err).toMatch(/^Invalid regex:/);
  });

  it("returns undefined for empty/undefined patterns", () => {
    expect(validateUrlPattern(undefined)).toBeUndefined();
    expect(validateUrlPattern("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path containment — assertInsideRoot / containmentDisabled.
//
// Real-filesystem tests under a tmpdir; create root + a sibling dir, verify
// allow/deny + the escape hatch ("*").
// ---------------------------------------------------------------------------

describe("containmentDisabled", () => {
  it("is true for empty/null/undefined", () => {
    expect(containmentDisabled("")).toBe(true);
    expect(containmentDisabled(null)).toBe(true);
    expect(containmentDisabled(undefined)).toBe(true);
  });
  it("is true for the literal '*'", () => {
    expect(containmentDisabled("*")).toBe(true);
  });
  it("is false for a real path", () => {
    expect(containmentDisabled("/tmp/anything")).toBe(false);
  });
});

describe("assertInsideRoot", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "steel-assert-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, "good.txt"), "ok");
    await fs.writeFile(path.join(outside, "evil.txt"), "x");
  });

  it("returns the path when it lies inside the root", async () => {
    const target = path.join(root, "good.txt");
    const resolved = await assertInsideRoot(target, root, "upload path");
    expect(resolved).toBe(await fs.realpath(target));
  });

  it("rejects a path that escapes via ../", async () => {
    const traversal = path.join(root, "..", "outside", "evil.txt");
    await expect(assertInsideRoot(traversal, root, "upload path")).rejects.toThrow(
      /escapes the configured root/,
    );
  });

  it("rejects a path in a completely separate directory", async () => {
    await expect(
      assertInsideRoot(path.join(outside, "evil.txt"), root, "upload path"),
    ).rejects.toThrow(/escapes the configured root/);
  });

  it("rejects a path that is a sibling with a prefix-matching name", async () => {
    // Create /tmp/.../root-evil — the rootWithSep check must reject this
    // even though the directory name starts with the same prefix.
    const prefixSibling = path.join(path.dirname(root), `${path.basename(root)}-evil`);
    await fs.mkdir(prefixSibling, { recursive: true });
    try {
      await expect(
        assertInsideRoot(path.join(prefixSibling, "x"), root, "upload path"),
      ).rejects.toThrow(/escapes the configured root/);
    } finally {
      await fs.rm(prefixSibling, { recursive: true, force: true });
    }
  });

  it("skips the check when root is '*' (escape hatch)", async () => {
    const target = path.join(outside, "evil.txt");
    // No throw — returns the path verbatim.
    const resolved = await assertInsideRoot(target, "*", "upload path");
    expect(resolved).toBe(target);
  });

  it("accepts a not-yet-existing path under the root (newly-written output)", async () => {
    const newFile = path.join(root, "subdir", "fresh.txt");
    const resolved = await assertInsideRoot(newFile, root, "outputPath");
    // The parent dir exists; we don't create the leaf — the check should
    // resolve against the parent realpath and rejoin the leaf.
    expect(resolved.endsWith(path.join("subdir", "fresh.txt"))).toBe(true);
  });
});
