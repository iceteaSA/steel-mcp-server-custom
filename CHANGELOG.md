# Changelog

## [0.2.0] — 2026-04-17

New list-page scraping flow + bot-check safety + optional JS extraction tool. Cuts browser-call count per page roughly in half for scrape workflows.

### Added

- `get_links(selector?, urlPattern?, limit?)` — URL-only extraction. Returns deduped `[{text, href}]` for anchors under a CSS scope, filtered by optional regex. Lighter than `get_page_text` when only URLs matter.
- `go_to_url(..., waitFor?, waitTimeout?)` — optional CSS selector to wait for after navigation. Merges nav + content-ready wait in one call. Saves one round trip per page on JS-rendered sites.
- `go_to_url` automatic bot-check detection — returns `isError: true` when destination is a Cloudflare/Access-denied wall (title matches `/just a moment|attention required|access denied|verify you are human/i` or URL hits `/cdn-cgi/challenge-platform/`). Agents should hand off via `start_browser` Interactive URL — do not retry.
- `get_page_text(matchAll: true)` — querySelectorAll mode. Returns JSON array with one entry per match, each `{text, title?, primaryLink?, links?}`. Designed for scraping article cards, product tiles, search results in a single call.
- `matchAll` `title` field — text of the anchor whose `href` matches `primaryLink`. Direct headline — no post-processing.
- `matchAll` `pretty: true` toggle — 2-space indent inline JSON. Default stays compact (one entry per line).
- `matchAll` `maxEntries` cap (default 20; 0 = no cap).

### Changed

- `matchAll` output sanitization:
  - `text` anchor whitespace collapsed (internal `\n`/tabs stripped).
  - `links` deduped by href (fragment stripped). **First non-empty text wins in DOM order** — picks the headline anchor on news pages, not the excerpt.
  - `primaryLink` = first link whose path depth ≥ 2 (skips nav/category roots like `/world/`); falls back to first link if none qualify.
- `get_links` uses the same first-non-empty-wins dedup.
- Inline `matchAll` JSON is compact by default (one object per line) to avoid `\n` pollution in tool-response wrappers.

### Fixed

- `page.evaluate` arg wrapping — Playwright rejected two-arg call with "Too many arguments".
- Bot-wall redirects no longer fail silently; surfaced as `isError`.

### Documentation

- `README.md` — updated tool table with new entries, matchAll/waitFor described.
- `skill/SKILL.md` — new sections: Nav + Wait, Bot-Check Detection (automatic), Path 2 `get_links`, selector diagnostic pattern.
- `AGENTS.md` — tool surface and architectural notes refreshed.

### Internal

- Repo history scrubbed of identifiable domain/IP/path references; commit messages rewritten.
