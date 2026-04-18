// Pure helpers shared by multiple tool handlers. Node-side — safe to unit test
// without a browser. Keep zero runtime deps so the built bundle stays lean.

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
 * Detects whether the page is sitting on a Cloudflare / anti-bot wall based
 * on title text and URL. Callers should return isError and hand off to a
 * human via the Interactive URL — do not retry, same IP will fail again.
 */
const BOT_WALL_TITLE_RE =
  /just a moment|attention required|access denied|verify you are human/i;
const BOT_WALL_URL_RE = /\/cdn-cgi\/challenge-platform\//i;

export function isBotWall(title: string, url: string): boolean {
  return BOT_WALL_TITLE_RE.test(title) || BOT_WALL_URL_RE.test(url);
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
      return (
        u.pathname.length > 1 &&
        u.pathname.split("/").filter(Boolean).length >= 2
      );
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
export function findTitle(
  primaryLink: string | undefined,
  links: Link[]
): string | undefined {
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
  type: string | null | undefined
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
const CHECKBOX_FALSY = new Set([
  "false",
  "0",
  "off",
  "no",
  "unchecked",
  "n",
  "",
]);

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
  urlHost: string | null | undefined
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
 * Map a Content-Type (MIME) string to a plausible file extension for saving
 * downloaded bodies. Strips parameters (`; charset=…`). Returns empty string
 * when unknown — caller can leave the filename extension-less.
 */
const MIME_EXT_MAP: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/html": ".html",
};

export function mimeToExt(mime: string | null | undefined): string {
  if (!mime) return "";
  const m = mime.toLowerCase().split(";")[0].trim();
  return MIME_EXT_MAP[m] ?? "";
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
