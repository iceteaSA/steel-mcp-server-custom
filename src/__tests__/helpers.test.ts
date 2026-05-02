import { describe, it, expect } from "vitest";
import {
  collapseWhitespace,
  isBotWall,
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
    const links: Link[] = [
      { text: "Title", href: "https://a.com/post#top" },
    ];
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
    expect(isBrowserClosedError(new Error("Target page, context or browser has been closed"))).toBe(true);
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
    expect(isSteelSessionStuck(new Error("500 Failed after 3 attempts. Last error: Browser process error (page_refresh): Failed to refresh primary page when reusing browser"))).toBe(true);
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
    expect(buildRadioSelector("input[name=size]", "medium")).toBe('input[name=size][value="medium"]');
  });
  it("escapes quotes in value", () => {
    expect(buildRadioSelector("input[name=x]", 'a"b')).toBe('input[name=x][value="a\\"b"]');
  });
  it("returns unchanged if value attribute already present", () => {
    expect(buildRadioSelector("input[name=size][value=xl]", "xl")).toBe("input[name=size][value=xl]");
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
// cleanErrorMessage
// ---------------------------------------------------------------------------
describe("cleanErrorMessage", () => {
  it("strips ANSI escape codes", () => {
    expect(cleanErrorMessage("Call log:\n\u001b[2m  - waiting\u001b[22m")).toBe("Call log:\n  - waiting");
  });
  it("strips Playwright internal frames", () => {
    const msg = "Error: failed\n    at UtilityScript.evaluate (:1:1)\n    at myFunction (file.js:10:5)";
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
