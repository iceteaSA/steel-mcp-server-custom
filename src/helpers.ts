// Pure helpers shared by multiple tool handlers. Node-side — safe to unit test
// without a browser.

import path from "path";

import mime from "mime-types";

export interface Link {
  text: string;
  href: string;
}

/**
 * Collapse all runs of whitespace (including newlines and tabs) to a single
 * space, then trim ends. Idempotent.
 */
export function collapseWhitespace(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Detects whether the page is sitting on a CAPTCHA / anti-bot wall based
 * on title text and URL patterns. Covers Cloudflare, Google sorry/CAPTCHA,
 * hCaptcha, AWS WAF, DataDome, and generic challenge pages.
 *
 * When CapSolver is loaded, these challenges may auto-solve within seconds.
 * Callers should wait + re-check (see CAPTCHA_WAIT_* constants) before
 * returning isError to the agent.
 */
const BOT_WALL_TITLE_RE =
  /just a moment|attention required|access denied|verify you are human|unusual traffic|are you a robot|captcha|human verification/i;
const BOT_WALL_URL_RE =
  /\/cdn-cgi\/challenge-platform\/|\/sorry\/index|google\.com\/sorry|recaptcha\/api|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/i;

/** How long to wait for CapSolver to auto-solve a detected CAPTCHA (ms). */
export const CAPTCHA_WAIT_TOTAL_MS = 15_000;
/** Polling interval while waiting for CAPTCHA solve (ms). */
export const CAPTCHA_POLL_INTERVAL_MS = 2_000;

export function isBotWall(title: string, url: string): boolean {
  return BOT_WALL_TITLE_RE.test(title) || BOT_WALL_URL_RE.test(url);
}

/**
 * Detects common HTTP error pages (404, 5xx) by title heuristics.
 * Returns the detected status string (e.g. "404") or null if not an error page.
 */
const ERROR_PAGE_RE =
  /^(page not found|404|not found|403 forbidden|500 internal|502 bad gateway|503 service|error \d{3})/i;
const GITHUB_404_RE = /page not found.*github/i;

export function detectErrorPage(title: string): string | null {
  if (GITHUB_404_RE.test(title)) return "404";
  const m = title.match(ERROR_PAGE_RE);
  if (m) {
    // Try to extract status code from match
    const code = m[0].match(/\d{3}/);
    return code ? code[0] : "404";
  }
  return null;
}

/** TTL for ErrorTracker entries — entries older than this are evicted. */
export const ERROR_TRACKER_TTL_MS = 30 * 60 * 1000;

/** Hard cap on ErrorTracker entries (evict oldest when exceeded). */
export const ERROR_TRACKER_MAX_ENTRIES = 200;

/**
 * Tracks recent navigation errors (404s, bot walls) to detect agents stuck in
 * retry loops. Ring buffer keyed by URL origin+pathname (strips query/fragment).
 *
 * When the same domain or exact URL has been seen N times recently, returns a
 * warning message the agent can use to break the loop. The tracker is
 * intentionally generous — it warns, it doesn't block.
 */
export class ErrorTracker {
  private entries: Array<{ key: string; domain: string; ts: number }> = [];
  private readonly maxEntries: number;
  private readonly domainThreshold: number;
  private readonly urlThreshold: number;
  private readonly now: () => number;

  constructor(opts?: {
    maxEntries?: number;
    domainThreshold?: number;
    urlThreshold?: number;
    now?: () => number;
  }) {
    this.maxEntries = opts?.maxEntries ?? ERROR_TRACKER_MAX_ENTRIES;
    this.domainThreshold = opts?.domainThreshold ?? 5;
    this.urlThreshold = opts?.urlThreshold ?? 2;
    this.now = opts?.now ?? Date.now;
  }

  /** Evict entries older than TTL and enforce the hard cap. */
  private evict(): void {
    const cutoff = this.now() - ERROR_TRACKER_TTL_MS;
    this.entries = this.entries.filter((e) => e.ts >= cutoff);
    if (this.entries.length > ERROR_TRACKER_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - ERROR_TRACKER_MAX_ENTRIES);
    }
  }

  /** Normalise a URL to origin+pathname for dedup (strip query, fragment). */
  private normalise(url: string): { key: string; domain: string } {
    try {
      const u = new URL(url);
      return { key: `${u.origin}${u.pathname}`, domain: u.hostname };
    } catch {
      return { key: url, domain: url };
    }
  }

  /** Record a failed navigation. */
  record(url: string): void {
    this.evict();
    const { key, domain } = this.normalise(url);
    this.entries.push({ key, domain, ts: this.now() });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Check if a URL would be a repeat error. Returns a warning string if the
   * agent appears to be looping, or null if the URL looks fresh.
   */
  check(url: string): string | null {
    this.evict();
    const { key, domain } = this.normalise(url);

    // Exact URL repeat
    const urlHits = this.entries.filter((e) => e.key === key).length;
    if (urlHits >= this.urlThreshold) {
      return `This exact URL has failed ${urlHits} time(s) recently. Try a different approach (e.g. search instead of guessing URLs).`;
    }

    // Same domain repeat
    const domainHits = this.entries.filter((e) => e.domain === domain).length;
    if (domainHits >= this.domainThreshold) {
      return `${domainHits} recent errors on ${domain}. The resource may not exist or the domain is blocking requests. Try searching for the correct URL instead.`;
    }

    return null;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }
}

/**
 * Dedupe raw anchor data by href, stripping fragments (#comments, #section).
 * First non-empty text wins in DOM order — on news pages the headline anchor
 * comes before the excerpt anchor and both point to the same URL, so picking
 * the first non-empty gives the headline.
 *
 * Empty placeholder anchors (image-only <a> with no text) are upgraded to
 * the first non-empty variant encountered.
 */
export function dedupeLinks(raw: Link[]): Link[] {
  const byHref = new Map<string, Link>();
  for (const l of raw) {
    const key = l.href.split("#")[0];
    const existing = byHref.get(key);
    if (!existing) {
      byHref.set(key, { text: l.text, href: l.href });
    } else if (!existing.text && l.text) {
      // Upgrade empty placeholder to non-empty text (first non-empty wins).
      byHref.set(key, { text: l.text, href: l.href });
    }
    // else: keep existing.
  }
  return Array.from(byHref.values());
}

/**
 * Pick the most likely article link from a deduped list.
 *
 * Heuristic: first link whose path has ≥ 2 non-empty segments. This skips
 * single-segment paths like `/world/` (category/nav) and prefers deeper
 * article URLs like `/world/some-slug-20260417`. Falls back to the first
 * link if none qualify.
 */
export function pickPrimaryLink(links: Link[]): string | undefined {
  const articleish = links.find((l) => {
    try {
      const u = new URL(l.href);
      return u.pathname.length > 1 && u.pathname.split("/").filter(Boolean).length >= 2;
    } catch {
      return false;
    }
  });
  if (articleish) return articleish.href;
  return links[0]?.href;
}

/**
 * Given a primaryLink URL and the deduped links list, return the text of the
 * anchor whose href matches (ignoring fragments). Used as the article title.
 */
export function findTitle(primaryLink: string | undefined, links: Link[]): string | undefined {
  if (!primaryLink) return undefined;
  const key = primaryLink.split("#")[0];
  const match = links.find((l) => l.href.split("#")[0] === key && l.text);
  return match?.text;
}

/**
 * Cap a string at maxChars; if truncated, append the single-char ellipsis.
 * maxChars ≤ 0 disables truncation.
 */
export function capText(s: string, maxChars: number): string {
  if (maxChars <= 0 || s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…";
}

/**
 * Detect Playwright "browser/context has been closed" errors. These arise when
 * the browser process died, the Steel session expired, or a context got
 * disposed while we still held a reference. Callers soft-reset and retry once.
 */
const BROWSER_CLOSED_RE =
  /Target page, context or browser has been closed|Target closed|Browser has been closed|Browser has disconnected|browserContext\.newPage|ECONNREFUSED|WebSocket closed|CDP (session|browser) closed/i;

export function isBrowserClosedError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as Error).message || String(err);
  return BROWSER_CLOSED_RE.test(msg);
}

/**
 * Detect Steel's "stuck live session" pattern: when the server fails to
 * refresh the primary page on session reuse after N internal retries.
 * Typical message:
 *   "500 Failed after 3 attempts. Last error: Browser process error
 *    (page_refresh): Failed to refresh primary page when reusing browser"
 *
 * Recovery: release all live sessions on the Steel server, then retry the
 * MCP's own connect logic. Happens when a previous MCP child died without
 * releasing its session and the server's background retry gives up.
 */
const STEEL_STUCK_SESSION_RE =
  /page_refresh|Failed to refresh primary page|Failed after \d+ attempts.*Browser process error/i;

export function isSteelSessionStuck(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as Error).message || String(err);
  return STEEL_STUCK_SESSION_RE.test(msg);
}

/**
 * Map an HTML element's tagName + input `type` to a fill_form dispatch kind.
 * Used by fill_form to route each field to page.fill / page.check /
 * page.selectOption / click-radio. When the element is not found or the
 * tag/type is unknown, falls back to "text" (page.fill), which is the widest
 * accept — will throw a clearer error if it really can't accept the value.
 */
export type FieldKind = "text" | "check" | "radio" | "select";

export function detectFieldKind(
  tag: string | null | undefined,
  type: string | null | undefined,
): FieldKind {
  const t = (tag ?? "").toUpperCase();
  if (t === "SELECT") return "select";
  if (t === "INPUT") {
    const ty = (type ?? "").toLowerCase();
    if (ty === "checkbox") return "check";
    if (ty === "radio") return "radio";
  }
  return "text";
}

/**
 * In-page function: takes an array of CSS selectors and returns a map of
 * selector → { tag, type } or null (element not found). Designed to be
 * serialized and run via page.evaluate so that kind-detection for an
 * entire form is a single round-trip instead of N per-field evaluates.
 */
export function detectFieldsInPage(
  selectors: string[],
): Record<string, { tag: string; type: string } | null> {
  const out: Record<string, { tag: string; type: string } | null> = {};
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) {
      out[sel] = null;
      continue;
    }
    const tag = el.tagName;
    const type = (el as HTMLInputElement).type ?? "";
    out[sel] = { tag, type };
  }
  return out;
}

/**
 * Checkbox truthy/falsy token sets. fill_form accepts a string `value` for
 * every field; for checkboxes the value has two possible meanings:
 *
 *   1. Boolean intent — check ("true"/"1"/"yes"/...) or uncheck ("false"/"0"/...)
 *      the checkbox(es) matched by `selector`.
 *   2. Option-value intent — when `value` is neither truthy nor falsy token,
 *      treat it like a radio: click the specific checkbox in the group whose
 *      `value` attribute equals the given string. This matches user intuition
 *      for HTML checkbox groups like `name=topping value=cheese`.
 */
const CHECKBOX_TRUTHY = new Set(["true", "1", "on", "yes", "checked", "y"]);
const CHECKBOX_FALSY = new Set(["false", "0", "off", "no", "unchecked", "n", ""]);

export type CheckboxIntent = "check" | "uncheck" | "selectByValue";

export function interpretCheckboxValue(value: string): CheckboxIntent {
  const v = value.toLowerCase();
  if (CHECKBOX_TRUTHY.has(v)) return "check";
  if (CHECKBOX_FALSY.has(v)) return "uncheck";
  return "selectByValue";
}

/** Back-compat shim — delegates to interpretCheckboxValue for existing callers. */
export function isCheckboxTruthy(value: string): boolean {
  return interpretCheckboxValue(value) === "check";
}

/**
 * Given a radio selector + a value, build a fully-qualified CSS selector that
 * matches only the radio in the group whose `value` attribute equals value.
 * If the incoming selector already contains a `[value=...]` attribute filter,
 * return it unchanged (caller already disambiguated).
 *
 * Examples:
 *   ("input[name=size]", "medium")       → 'input[name=size][value="medium"]'
 *   ("input[name=size][value=xl]", "xl") → 'input[name=size][value=xl]' (unchanged)
 */
export function buildRadioSelector(selector: string, value: string): string {
  if (/\[value[\s~|^$*]*=/.test(selector)) return selector;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${selector}[value="${escaped}"]`;
}

/**
 * Given a cookie's stored `domain` and a URL's hostname, return true if the
 * cookie should match. Mirrors how browsers compare cookies against requests:
 *
 *   - exact host match
 *   - cookie domain has a leading dot (public suffix style) and host ends with it
 *   - cookie domain stripped of leading dot == host OR a parent of host
 *
 * Used as the fallback when Playwright's own `context.cookies(urls)` matcher
 * returns empty for a shape it should have matched (observed with session
 * cookies set via redirect chains, httpbin-style Set-Cookie headers).
 */
export function matchesCookieHost(
  cookieDomain: string | null | undefined,
  urlHost: string | null | undefined,
): boolean {
  if (!cookieDomain || !urlHost) return false;
  const cd = cookieDomain.toLowerCase().replace(/^\./, "");
  const uh = urlHost.toLowerCase();
  if (cd === uh) return true;
  // host is a subdomain of cookie domain
  if (uh.endsWith("." + cd)) return true;
  // cookie domain is a subdomain of host — rare but occurs when passing a
  // bare hostname filter against cookies scoped to a subdomain
  if (cd.endsWith("." + uh)) return true;
  return false;
}

/**
 * Map a Content-Type (MIME) string to a file extension (with leading dot).
 * Uses the `mime-types` package for comprehensive coverage (1000+ types).
 * Returns empty string when unknown.
 */
export function mimeToExt(contentType: string | null | undefined): string {
  if (!contentType) return "";
  const ext = mime.extension(contentType);
  return ext ? `.${ext}` : "";
}

/**
 * Derive a sensible download filename from a URL when the server didn't send
 * `Content-Disposition`. Returns the last non-empty path segment if it looks
 * reasonable (< 200 chars, contains non-slash chars), else a timestamped
 * fallback.
 */
export function deriveDownloadFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && last.length < 200) return last;
  } catch {
    /* ignore — malformed URL, fall through */
  }
  return `download_${Date.now()}`;
}

// -----------------------------------------------------------------------------
// Content-area extraction — shared logic for get_page_text, go_to_url readPage,
// scroll readAfterScroll, and fetch_urls fallback.
//
// The extraction function is designed to be passed to page.evaluate() (runs in
// the browser) AND usable under linkedom in tests. It must be self-contained
// (no closure over module scope) because evaluate() serializes it.
// -----------------------------------------------------------------------------

/**
 * Self-contained content-area extraction function designed to be passed to
 * page.evaluate() (Playwright serializes it to the browser) AND run under
 * linkedom in tests. Contains all dependencies inline — no module closure.
 *
 * Two modes:
 *   mode="walk" (default) — walk-based extraction with block-tag awareness.
 *     When includeLinks is true, anchor text gets [href] appended and links
 *     are collected separately. Anchor text uses textContent?.trim() (preserves
 *     internal whitespace like "A\n B") matching the original get_page_text
 *     includeLinks behavior.
 *   mode="innerText" — uses HTMLElement.innerText (simpler, matches the
 *     go_to_url readPage / scroll readAfterScroll / fetch_urls fallback path).
 *
 * Returns { text, links?, __noMatch? }.
 */
export function extractPageContent(
  opts: {
    selector?: string | null;
    includeLinks?: boolean;
    mode?: "walk" | "innerText";
  },
  doc?: Document,
): { text: string; links?: Array<{ text: string; href: string }>; __noMatch?: boolean } {
  // Self-contained: all constants inlined so the function works when
  // serialized to the browser via page.evaluate().
  const CONTENT_AREA_SELECTORS = ["main", "article", '[role="main"]', "body"] as const;
  const BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TR",
    "BLOCKQUOTE",
    "PRE",
    "SECTION",
    "ARTICLE",
    "HEADER",
    "FOOTER",
    "NAV",
    "ASIDE",
    "MAIN",
    "DETAILS",
    "SUMMARY",
    "FIGCAPTION",
    "DT",
    "DD",
  ]);

  const d = doc || document;
  const sel = opts.selector ?? null;
  const includeLinks = opts.includeLinks ?? false;
  const mode = opts.mode ?? "walk";

  // Find content root
  let root: Element | null = null;
  if (sel) {
    root = d.querySelector(sel);
  } else {
    for (const s of CONTENT_AREA_SELECTORS) {
      if (s === "body") {
        root = d.body;
        break;
      }
      const el = d.querySelector(s);
      if (el && (el.textContent?.trim().length ?? 0) > 100) {
        root = el;
        break;
      }
    }
    if (!root) root = d.body;
  }
  if (!root) return sel ? { text: "", __noMatch: true } : { text: "" };

  if (mode === "innerText") {
    const text = ((root as HTMLElement)?.innerText ?? "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text };
  }

  // Walk-based extraction — matches original get_page_text includeLinks behavior.
  // Anchor text uses textContent?.trim() (preserves internal whitespace like
  // "A\n B" — the outer normalizer only collapses non-newline whitespace).
  const rawLinks: Array<{ text: string; href: string }> = [];

  const walk = (node: Element): string => {
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "A") {
      const href = (node as HTMLAnchorElement).href;
      const txt = (node.textContent ?? "").trim();
      if (includeLinks && href) rawLinks.push({ text: txt, href });
      return includeLinks ? `${txt} [${href}]` : txt;
    }
    const inner = Array.from(node.childNodes)
      .map((n) => (n.nodeType === 3 ? (n.textContent ?? "") : walk(n as Element)))
      .join("");
    return BLOCK_TAGS.has(node.tagName) ? "\n" + inner + "\n" : inner;
  };

  const text = walk(root)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (includeLinks) {
    return { text, links: rawLinks };
  }
  return { text };
}

/**
 * Validate that each cookie in a set has either `url` or (`domain` AND `path`).
 * Returns an array of violation messages (empty = all valid).
 */
export function validateCookies(
  cookies: Array<{ name: string; value?: string; url?: string; domain?: string; path?: string }>,
): string[] {
  const violations: string[] = [];
  for (const c of cookies) {
    if (!c.url && !(c.domain && c.path)) {
      violations.push(`Cookie "${c.name}": needs url, or domain+path.`);
    }
  }
  return violations;
}

/**
 * Validate a JavaScript expression before sending it to page.evaluate().
 * Uses new Function() to syntax-check — statements like `let x=1; x` will
 * fail because the tool contract requires a single expression.
 * Returns an error message string, or null if valid.
 */
export function validateExpression(expression: string): string | null {
  try {
    new Function(`return (${expression})`);
  } catch (e) {
    const msg = (e as Error).message;
    return `Expression is not valid JavaScript: ${msg}. The expression must be a single expression (not a statement). Wrap multi-line logic in an IIFE: (() => { ... })()`;
  }
  return null;
}

/**
 * Clean Playwright error messages for LLM consumption:
 *   - Strip ANSI colour escapes (ESC + `[` + digits + `m`) that Playwright
 *     embeds in its `Call log:` sections (visible as `[2m` / `[22m` in MCP
 *     text output).
 *   - Drop Playwright's internal stack frames (`UtilityScript.<anonymous>`,
 *     `UtilityScript.evaluate`, `at eval (<anonymous>…)`) — they never help
 *     diagnose user errors and waste tokens.
 *
 * Leaves meaningful lines (Playwright "Call log:" context, user errors,
 * SyntaxError messages with line/col) intact.
 */
// eslint-disable-next-line no-control-regex -- intentional: stripping ANSI escape codes
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const PLAYWRIGHT_INTERNAL_FRAME_RE =
  /^\s+at (?:UtilityScript\.(?:\w|<)|eval \((?:eval at )?evaluate \(|eval \(<anonymous>)/;

export function cleanErrorMessage(msg: unknown): string {
  const raw = msg instanceof Error ? msg.message : String(msg ?? "");
  const noAnsi = raw.replace(ANSI_RE, "");
  const filtered = noAnsi
    .split("\n")
    .filter((line) => !PLAYWRIGHT_INTERNAL_FRAME_RE.test(line))
    .join("\n")
    .trimEnd();
  return filtered;
}

// ---------------------------------------------------------------------------
// Profile name validation — prevents path traversal in profilesDir file paths.
// Matches the same pattern that relay /push and profile tools accept.
// ---------------------------------------------------------------------------

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Returns true if the name is safe to use as a profile filename component.
 * Rejects traversal attempts (../), separators (a/b), absolute paths,
 * empty strings, and names longer than 64 characters.
 */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

/**
 * Validates that the resolved path for a profile name stays under the given
 * profiles directory. Throws if the name is invalid or if the resolved path
 * escapes the directory (defense in depth — even if the validator has a bug).
 */
export function assertSafeProfilePath(name: string, profilesDir: string): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name "${name}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
    );
  }
  const resolvedDir = path.resolve(profilesDir);
  const resolvedPath = path.resolve(path.join(resolvedDir, `${name}.json`));
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Profile path "${resolvedPath}" escapes profiles directory "${resolvedDir}".`);
  }
  return resolvedPath;
}

// ---------------------------------------------------------------------------
// Network event filtering — pure helpers for get_network
// ---------------------------------------------------------------------------

/** Lightweight shape used by filterNetworkEvents so the helper stays testable
 * without importing the full BrowserManager type. */
export interface NetworkEventLike {
  id: number;
  tabId?: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failed?: boolean;
  contentType?: string;
  sizeBytes?: number;
  durationMs?: number;
  at: number;
}

/**
 * Match a URL against a pattern. Patterns wrapped in /.../ are treated as a
 * RegExp (flags supported, e.g. /api/i); otherwise the pattern is a substring.
 */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }
  if (pattern.length >= 2 && pattern.startsWith("/") && /\/[imsuy]*$/.test(pattern)) {
    // Regex with flags: /.../i
    const lastSlash = pattern.lastIndexOf("/");
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    try {
      return new RegExp(body, flags).test(url);
    } catch {
      return false;
    }
  }
  return url.includes(pattern);
}

/**
 * Match an event status against a filter token.
 *   - "4xx", "5xx", etc. match the corresponding HTTP range.
 *   - Exact digits match the exact status code.
 */
export function matchesNetworkStatus(
  status: number | undefined,
  failed: boolean | undefined,
  filter: string,
): boolean {
  if (/^(\d)xx$/i.test(filter)) {
    const first = parseInt(filter[0], 10);
    return status !== undefined && status >= first * 100 && status < (first + 1) * 100;
  }
  if (/^\d+$/.test(filter)) {
    return status === parseInt(filter, 10);
  }
  if (filter === "failed" || filter === "FAIL") {
    return !!failed;
  }
  return false;
}

/**
 * Pure filter for get_network. Preserves chronological order; applies limit
 * from the newest end so callers see the most recent matches.
 */
export function filterNetworkEvents(
  events: NetworkEventLike[],
  filter: {
    urlPattern?: string;
    resourceType?: string;
    status?: string;
    tabId?: number;
    limit?: number;
  },
): NetworkEventLike[] {
  let result = events.slice();
  if (filter.tabId !== undefined) {
    result = result.filter((e) => e.tabId === filter.tabId);
  }
  if (filter.resourceType) {
    result = result.filter((e) => e.resourceType === filter.resourceType);
  }
  if (filter.urlPattern) {
    result = result.filter((e) => matchesUrlPattern(e.url, filter.urlPattern!));
  }
  if (filter.status) {
    result = result.filter((e) => matchesNetworkStatus(e.status, e.failed, filter.status!));
  }
  const limit = filter.limit ?? 30;
  if (limit > 0 && result.length > limit) {
    result = result.slice(-limit);
  }
  return result;
}
