# Changelog

## [0.5.2] — 2026-04-17

Root-cause fix for the 0.5.1 stuck-session error: idle sweeper must never close the primary tab.

### Fixed

- **Primary tab is now exempt from the idle sweeper.** Steel creates a session with an initial blank primary page; our MCP registered it as tabId 1 and then the sweeper would close it after 5 min of inactivity. Steel's session stayed `live` but lost its primary page reference, causing `page_refresh: Failed to refresh primary page when reusing browser` 500s on every subsequent connect. Sweeping that tab was the root cause of the error 0.5.1's auto-recovery worked around. Now the primary is tracked and skipped.
- `closeTabsByOwner` also skips the primary tab defensively.
- Explicit `close_tab(tabId=<primary>)` now returns a clear error instead of silently poisoning the session: "Tab N is the primary tab and cannot be closed. Use stop_browser to end the session instead."

### Context

Before 0.3.0 there was no sweeper, so the primary page lived as long as the MCP process did. 0.3.0 added the sweeper for abandoned tabs — correct for user-spawned tabs, wrong for the Steel-provided primary. 0.5.2 distinguishes the two.

## [0.5.1] — 2026-04-17

Resilience: auto-recover from Steel's stuck-live-session state.

### Added

- **Stuck-session detection on connect.** The MCP now detects Steel's `page_refresh` / "Failed after N attempts" error during `initialize()` and automatically:
  1. Calls `GET /v1/sessions` to list live sessions
  2. `POST /v1/sessions/<id>/release` for each
  3. Retries the original `sessions.create` + CDP connect
- `isSteelSessionStuck(err)` helper + 9 unit tests.
- Self-hosted only — skipped in Steel Cloud mode (no admin rights across tenants).

### Context

Previously, when a Steel session got into an unhealthy `live` state (e.g. the browser process crashed but Steel's session record wasn't cleaned up), every subsequent MCP connect attempt failed with a generic 500. Recovery required manual `curl -X POST .../release` + MCP restart. Now handled automatically on the first failure.

## [0.5.0] — 2026-04-17

Feature pack: element-scoped captures, form batch helper, cookies, downloads, WebP screenshots, stricter init.

### Added

- **`fill_form(fields[], submitSelector?, skipMissing?, timeout?, tabId?)`** — batch-fill N form fields with one call. Replaces N `type` calls for sign-in / search / multi-step forms.
- **`get_cookies(urls?)`** — return Playwright cookies from the shared browser context, optionally filtered to one or more URLs.
- **`set_cookies(cookies[])`** — inject cookies into the shared context. Unlocks auth-restored workflows without re-running login.
- **`download_file(url, outputPath?, timeout?, tabId?)`** — capture a direct-download URL via Playwright's `waitForEvent('download')` pattern. Handles `ERR_ABORTED` on binary URLs silently. Saves to disk and returns the path + byte size.
- **`get_screenshot(selector)`** — element-scoped screenshot. Captures just the element's bounding box. Replaces manual `clip` math when you know the selector.
- **`get_screenshot(format: "webp")`** — new format, uses CDP `Page.captureScreenshot` (Playwright's built-in API only supports png/jpeg). Smallest file sizes. Requires Chromium ≥ 88.
- **`evaluate(selector?)`** — when set, runs the expression with `el` bound to `document.querySelector(selector)`. Returns null if no match. Defends against injection by JSON-stringifying the selector.

### Changed

- **`start_browser`** now runs a post-init health check (probes `browserContext.pages()` + creates/closes a throwaway page if empty). Fixes the race where `start_browser` returned success but the very next `new_tab` hit `browserContext.newPage: Target page, context or browser has been closed`.
- **`switch_tab` REMOVED.** Always pass `tabId` to each tool instead. Mutating a global "active tab" is not safe under concurrent agent use. Breaking change.

### Migration guide

| Old call                                 | New call                                                  |
| ---------------------------------------- | --------------------------------------------------------- |
| `switch_tab(tabId: 3); get_page_text(...)` | `get_page_text(..., tabId: 3)` (tabId on each subsequent call) |

### Fixed

- `start_browser` race with immediate `new_tab` — now proactively probes the context instead of relying on retry fallback.

## [0.4.0] — 2026-04-17

Tool consolidation. 25 → 21 tools. Breaking change: 6 old tool names removed, 2 new merged replacements added.

### Removed

- **`google_search`** — use OpenClaw's `web_search` instead (API-based, no browser overhead). If you need the SERP in a real browser, use `go_to_url("https://www.google.com/search?q=...")`.
- **`scroll_up`** — merged into `scroll`.
- **`scroll_down`** — merged into `scroll`.
- **`go_back`** — merged into `history`.
- **`go_forward`** — merged into `history`.
- **`refresh`** — merged into `history`.

### Added

- **`scroll(direction, pixels?, tabId?)`** — unified scroll tool. `direction: "up" | "down"`, pixels defaults to 500.
- **`history(action, tabId?)`** — unified browser-history tool. `action: "back" | "forward" | "reload"`.

### Changed

- `switch_tab` marked **discouraged for concurrent workflows** in docs — pass `tabId` to each tool directly instead. Kept for backward compat.

### Migration guide

| Old call                         | New call                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `scroll_up(pixels: 300)`           | `scroll(direction: "up", pixels: 300)`                                               |
| `scroll_down()`                    | `scroll(direction: "down")`                                                          |
| `go_back()`                        | `history(action: "back")`                                                            |
| `go_forward()`                     | `history(action: "forward")`                                                         |
| `refresh()`                        | `history(action: "reload")`                                                          |
| `google_search(query: "foo")`      | OpenClaw `web_search(query: "foo")` **or** `go_to_url("https://www.google.com/search?q=foo")` |

## [0.3.0] — 2026-04-17

Multi-agent safe concurrent use. Per-tab ownership, per-tool tab targeting, browser-closed auto-retry, idle tab sweeper.

### Added

- **Per-agent tab ownership**: `new_tab(url?, owner?)` accepts an optional owner tag. Agents can later call `close_tabs_by_owner(owner)` to clean up only their own tabs — the shared browser session stays alive for other agents.
- **`close_tabs_by_owner(owner)`** tool — batch close all tabs matching an owner tag.
- **`tabId` parameter on all page-interacting tools** (`go_to_url`, `get_page_text`, `get_links`, `get_attrs`, `get_current_url`, `get_screenshot`, `click`, `type`, `select`, `evaluate`, `wait_for`, `scroll_up`, `scroll_down`, `go_back`, `go_forward`, `refresh`, `google_search`). Omit for current-active-tab behaviour; pass for concurrent-agent workflows where each agent holds different tabs.
- **`list_tabs` now reports owner tags** — `[Tab 3] * (owner=...)  url  —  title`.
- **Browser-closed auto-retry**: `newTab` and `getPage` detect "Target page/context/browser has been closed" errors and auto-recover via soft-reset + re-init (2s backoff, one retry). Fixes the race between `start_browser` returning and the context being ready for `newPage()`.
- **Idle tab sweeper**: tabs with no tool activity for `TAB_IDLE_TIMEOUT_MS` (default 5 min) are auto-closed. Every page-interacting call touches the tab's activity timestamp. Set `TAB_IDLE_TIMEOUT_MS=0` to disable. Sweep interval configurable via `TAB_IDLE_SWEEP_INTERVAL_MS` (default 60s).
- `isBrowserClosedError(err)` helper + 14 unit tests.

### Changed

- `BrowserManager` now uses internal retry wrappers (`_openFreshPage`, `_doNewTab`) so tool handlers stay simple.
- `BrowserManager.softReset()` — gentle state clear that doesn't try to close an already-dead browser. Used only in retry paths.
- Tabs attach a `page.on("close")` cleanup listener — external closures keep the tab registry consistent.

### Fixed

- Race between `start_browser` return and `newContext.newPage()` causing `browserContext.newPage: Target page, context or browser has been closed` on the very next `new_tab` call. Now recovered transparently.

### Environment

- `TAB_IDLE_TIMEOUT_MS` (default 300000 = 5 min) — auto-close idle tabs. 0 disables.
- `TAB_IDLE_SWEEP_INTERVAL_MS` (default 60000 = 60 s) — how often the sweeper runs.

### Documentation

- `README.md` — updated tool table, new env vars documented.
- `skill/SKILL.md` — concurrent-agent pattern section, owner / tabId / idle cleanup docs.
- `AGENTS.md` — concurrency section.

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
