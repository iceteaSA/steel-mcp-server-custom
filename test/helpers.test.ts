import { describe, it, expect } from "vitest";
import {
  capText,
  collapseWhitespace,
  dedupeLinks,
  findTitle,
  isBotWall,
  isBrowserClosedError,
  isSteelSessionStuck,
  pickPrimaryLink,
  type Link,
} from "../src/helpers";

describe("collapseWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(collapseWhitespace("  hello   world  \n\t")).toBe("hello world");
  });
  it("handles null/undefined", () => {
    expect(collapseWhitespace(null)).toBe("");
    expect(collapseWhitespace(undefined)).toBe("");
  });
  it("is idempotent", () => {
    const clean = "hello world";
    expect(collapseWhitespace(clean)).toBe(clean);
  });
  it("strips newlines and tabs inside string", () => {
    expect(collapseWhitespace("LIVE\n\n  32m ago\n\n  Headline")).toBe(
      "LIVE 32m ago Headline"
    );
  });
});

describe("capText", () => {
  it("returns string unchanged when under cap", () => {
    expect(capText("hello", 10)).toBe("hello");
  });
  it("truncates and appends ellipsis when over cap", () => {
    expect(capText("hello world", 5)).toBe("hello…");
  });
  it("maxChars <= 0 disables truncation", () => {
    const s = "a".repeat(1000);
    expect(capText(s, 0)).toBe(s);
    expect(capText(s, -1)).toBe(s);
  });
  it("equals cap is not truncated", () => {
    expect(capText("hello", 5)).toBe("hello");
  });
});

describe("isBotWall", () => {
  it.each([
    ["Just a moment...", "https://example.com", true],
    ["ATTENTION REQUIRED | Cloudflare", "https://example.com", true],
    ["Access denied - Error 1020", "https://example.com", true],
    ["Verify you are human", "https://example.com", true],
    ["News headlines", "https://example.com/cdn-cgi/challenge-platform/...", true],
    ["Normal page title", "https://example.com/article", false],
    ["", "https://example.com/article", false],
    ["", "", false],
  ])("title=%s url=%s => %s", (title, url, expected) => {
    expect(isBotWall(title, url)).toBe(expected);
  });
});

describe("dedupeLinks", () => {
  it("dedupes by href, first non-empty text wins", () => {
    const input: Link[] = [
      { text: "", href: "https://ex.com/a" },
      { text: "Headline", href: "https://ex.com/a" },
      { text: "Excerpt paragraph text", href: "https://ex.com/a" },
    ];
    const out = dedupeLinks(input);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Headline");
  });
  it("strips fragments in dedup key", () => {
    const input: Link[] = [
      { text: "Article", href: "https://ex.com/a" },
      { text: "24 comments", href: "https://ex.com/a#comments" },
    ];
    const out = dedupeLinks(input);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Article");
  });
  it("upgrades empty placeholder to first non-empty variant", () => {
    const input: Link[] = [
      { text: "", href: "https://ex.com/a" },
      { text: "", href: "https://ex.com/a" },
      { text: "Finally text", href: "https://ex.com/a" },
    ];
    const out = dedupeLinks(input);
    expect(out[0].text).toBe("Finally text");
  });
  it("keeps distinct hrefs", () => {
    const input: Link[] = [
      { text: "A", href: "https://ex.com/a" },
      { text: "B", href: "https://ex.com/b" },
    ];
    expect(dedupeLinks(input)).toHaveLength(2);
  });
  it("preserves href from first occurrence (keeps fragment variant)", () => {
    const input: Link[] = [
      { text: "Article", href: "https://ex.com/a" },
      { text: "", href: "https://ex.com/a#section" },
    ];
    const out = dedupeLinks(input);
    expect(out[0].href).toBe("https://ex.com/a");
  });
});

describe("pickPrimaryLink", () => {
  it("picks article-deep path over nav-shallow path", () => {
    const links: Link[] = [
      { text: "World", href: "https://news.ex.com/world" },
      {
        text: "Headline",
        href: "https://news.ex.com/world/article-slug-12345",
      },
    ];
    expect(pickPrimaryLink(links)).toBe(
      "https://news.ex.com/world/article-slug-12345"
    );
  });
  it("falls back to first link when none have depth ≥ 2", () => {
    const links: Link[] = [
      { text: "Home", href: "https://ex.com/" },
      { text: "World", href: "https://ex.com/world" },
    ];
    // Both fall back; first wins.
    expect(pickPrimaryLink(links)).toBe("https://ex.com/");
  });
  it("returns undefined on empty list", () => {
    expect(pickPrimaryLink([])).toBeUndefined();
  });
  it("ignores invalid URLs gracefully", () => {
    const links: Link[] = [
      { text: "Bad", href: "not-a-url" },
      { text: "Good", href: "https://ex.com/a/b" },
    ];
    expect(pickPrimaryLink(links)).toBe("https://ex.com/a/b");
  });
  it("correctly counts path segments (trailing slash)", () => {
    const links: Link[] = [
      { text: "Category", href: "https://ex.com/news/" },
      { text: "Article", href: "https://ex.com/news/slug-id" },
    ];
    expect(pickPrimaryLink(links)).toBe("https://ex.com/news/slug-id");
  });
});

describe("findTitle", () => {
  it("returns text of link matching primaryLink", () => {
    const links: Link[] = [
      { text: "Category", href: "https://ex.com/cat" },
      { text: "Headline", href: "https://ex.com/cat/article" },
    ];
    expect(findTitle("https://ex.com/cat/article", links)).toBe("Headline");
  });
  it("matches ignoring fragment", () => {
    const links: Link[] = [
      { text: "Headline", href: "https://ex.com/article" },
    ];
    expect(findTitle("https://ex.com/article#comments", links)).toBe(
      "Headline"
    );
  });
  it("returns undefined when no match", () => {
    const links: Link[] = [
      { text: "Other", href: "https://ex.com/other" },
    ];
    expect(findTitle("https://ex.com/missing", links)).toBeUndefined();
  });
  it("returns undefined when primaryLink missing", () => {
    expect(findTitle(undefined, [])).toBeUndefined();
  });
  it("skips empty-text anchors", () => {
    const links: Link[] = [
      { text: "", href: "https://ex.com/a" },
      { text: "Headline", href: "https://ex.com/a" },
    ];
    expect(findTitle("https://ex.com/a", links)).toBe("Headline");
  });
});

describe("isSteelSessionStuck", () => {
  it.each([
    ["500 Failed after 3 attempts. Last error: Browser process error (page_refresh): Failed to refresh primary page when reusing browser", true],
    ["Failed to refresh primary page", true],
    ["page_refresh failure", true],
    ["Failed after 5 attempts. Browser process error: timeout", true],
    ["Some unrelated error", false],
    ["Target closed", false],
    ["Failed after 3 attempts: upstream timeout", false],
    ["", false],
  ])("msg=%s => %s", (msg, expected) => {
    expect(isSteelSessionStuck(new Error(msg))).toBe(expected);
  });
  it("handles null/undefined", () => {
    expect(isSteelSessionStuck(null)).toBe(false);
    expect(isSteelSessionStuck(undefined)).toBe(false);
  });
});

describe("isBrowserClosedError", () => {
  it.each([
    ["browserContext.newPage: Target page, context or browser has been closed", true],
    ["Target page, context or browser has been closed", true],
    ["Target closed", true],
    ["Browser has been closed", true],
    ["Browser has disconnected unexpectedly", true],
    ["Error: browserContext.newPage: call failed", true],
    ["connect ECONNREFUSED 127.0.0.1:9222", true],
    ["WebSocket closed before response", true],
    ["CDP session closed", true],
    ["Some unrelated error", false],
    ["Timeout 30000ms exceeded", false],
    ["", false],
  ])("msg=%s => %s", (msg, expected) => {
    expect(isBrowserClosedError(new Error(msg))).toBe(expected);
  });
  it("handles string inputs (not just Error)", () => {
    expect(isBrowserClosedError("Target closed")).toBe(true);
    expect(isBrowserClosedError("nope")).toBe(false);
  });
  it("handles null/undefined/empty", () => {
    expect(isBrowserClosedError(null)).toBe(false);
    expect(isBrowserClosedError(undefined)).toBe(false);
    expect(isBrowserClosedError(new Error(""))).toBe(false);
  });
});
