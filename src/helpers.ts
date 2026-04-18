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
