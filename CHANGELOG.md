# Changelog

## [0.6.0] — 2026-04-18

Audit pass based on live-workflow dogfooding — five real bugs fixed, four UX gaps closed, screenshot default switched to WebP for a default-case context-budget win, plus a second-pass round of refinements from mcporter-boundary testing. Non-breaking for existing code except the screenshot format default.

### Fixed

- **`get_cookies` `urls` filter returned empty even on real matches.** Root cause was a shape mismatch in how Playwright's `context.cookies(urls)` matches stored cookies (e.g. `httpbin.org` cookie vs `https://httpbin.org/` filter). Now: if Playwright's exact match returns nothing, the tool falls back to a host-contains match across all cookies in the context. Added `domain` param (string or string[]) as the preferred site-scoped filter — simpler and doesn't fail on Playwright's quirks.
- **`fill_form` only worked on `<input type=text>` and `<textarea>`.** Every other form field — `<select>`, radios, checkboxes, date/time inputs — threw "page.fill: Timeout". Now auto-detects `tagName`/`type` and dispatches correctly: `page.selectOption` for `<select>`, `page.check`/`page.uncheck` for checkboxes, `page.click` on `[name][value=X]` for radios, `page.fill` for everything else. Added `kind` override per-field for edge cases. Result report now includes the dispatch kind per field.
- **`fill_form` checkbox value semantics made intuitive.** When the `value` on a checkbox field isn't a recognized truthy/falsy token (e.g. `"cheese"` on `input[name=topping]`), the tool now targets the specific checkbox whose `value` attribute matches — same shape as radio, matches user intent for HTML checkbox groups. Truthy/falsy tokens (`"true"`/`"1"`/`"yes"`/`"no"`/etc.) continue to check/uncheck via `page.check`/`page.uncheck`.
- **`get_links` `selector` scoped to the first matching element only.** `document.querySelector(selector)` was used instead of `querySelectorAll`, so `selector: "article"` returned only the first article's anchors. Now iterates all matching roots and concatenates descendant anchors — matches the expected "scope per list item" semantics already used by `get_page_text(matchAll: true)`.
- **`get_attrs` `"text"` special used `textContent`.** Block-level children's text got concatenated without whitespace, producing strings like `"Fibre1h agoHeadline"`. Switched to `innerText` (layout-aware, inserts whitespace between block-level children). Matches what a user sees and what `get_page_text` returns.
- **`download_file` timed out on binaries without `Content-Disposition: attachment`.** Many API-served PDFs, CSVs, and `application/octet-stream` URLs are viewed inline by Chromium, so no download event fires. Now: on download-event timeout, falls back to `context.request.fetch(url)` (reuses session cookies/auth), writes body to disk, derives filename from URL path + MIME type. Added `forceFetch: true` to skip the download-event path when you know the URL serves inline. Also improved filename derivation when no extension is present.
- **`download_file` `page.goto` suppress regex** expanded to catch `"Download is starting"` and `"Cannot load download URL"` — newer Chromium versions emit these instead of `ERR_ABORTED` when Chromium aborts the navigation because the response is a download. Without this fix, the download event would fire but the outer `Promise.all` would reject on the unhandled goto error.
- **`download_file` saveAs ENOENT on remote browser.** Steel's remote Chromium writes the download to its own container's `/tmp/playwright-artifacts-XXX/...`; `download.saveAs()` then tries to `copyfile` from that path which only exists on the remote host → `ENOENT`. Now detects this specific failure and falls back to `context.request.fetch(url)` (which fetches the bytes through the CDP session and so works regardless of where the browser runs).
- **`history` no-op detection refined.** Previously flagged navigation as "no-op" when Playwright returned `null` from `goBack`/`goForward` — but Playwright returns null even on successful navigation to `about:blank` and data URLs. Now requires BOTH the null response AND an unchanged URL before flagging a no-op. Real navigations report cleanly; only truly stuck-on-same-page history calls get the `(no-op …)` warning.
- **Error messages cleaned for agent consumption.** Playwright's error output contains ANSI dim-text escapes (`\u001b[2m` / `\u001b[22m`) in its `Call log:` sections — they surfaced as literal `[2m` / `[22m` tokens in MCP text output. Also stripped Playwright's internal stack frames (`UtilityScript.<anonymous>`, `UtilityScript.evaluate`, nested eval frames from `evaluate()`) which never help the caller diagnose user errors and waste tokens. New `cleanErrorMessage` helper in `src/helpers.ts` is wired into all 24 tool error paths plus `wait_for`'s custom prefix.
- **`get_links` invalid `urlPattern` now returns a clear error.** Previously the invalid regex threw from inside `page.evaluate`, surfacing Chromium/Playwright stack traces. Now validated up front: `urlPattern is not a valid regex: <reason>`.
- **`get_page_text` 0-match output cleaned.** `matchAll=true` with zero matches returned malformed `[\n\n]`; single-mode 0-match returned an empty string that mcporter renders as the internal response object. Now both paths produce an explicit message: matchAll → `[]\n(selector "…" matched no elements)`; single → `(selector "…" matched no elements)`.
- **`get_links` 0-match output cleaned.** Same `[\n\n]` malformed-array bug as `get_page_text` had, now also fixed — returns `[]` plus a contextual note about why nothing matched (selector scope, urlPattern, or both).
- **`get_attrs` 0-match output cleaned.** Same issue, same fix — explicit `[]\n(selector "…" matched no elements)` response.
- **`scroll` reports actual delta.** Before: always reported success, misleading when a fixed-viewport page refused to scroll or was already at the edge. Now: captures `window.scrollY` before/after, reports `(no-op — page not scrollable …)` when zero delta, or `(actual: Npx — reached document edge)` when partial.
- **`get_screenshot` validates `clip` dimensions up front.** Previously, negative coords, zero/negative width or height, and oversized regions (>16384px Chromium limit) hit CDP's cryptic `Protocol error (Page.captureScreenshot): Unable to capture screenshot`. Now validated server-side: `Invalid clip region: <specific issues>`.

### Changed

- **Screenshot default format is now `webp`** (was `png`). WebP typically 5–10× smaller than PNG for the same visual fidelity, and is produced via CDP `Page.captureScreenshot` which works across all modern Chromium builds. Pass `format: "png"` to restore the old default. `format: "jpeg"` also unchanged.
- **`get_cookies` output now capped** at 50 cookies by default. Shared browser contexts in multi-agent setups can hold hundreds of cookies; the old unfiltered dump regularly exceeded 80 KB of context. Set `limit: 0` for no cap, or use `domain`/`urls` filters to scope. Response includes a `[CAPPED — …]` footer when truncated.
- **`history back/forward`** now detects no-op navigations (first page of tab history) and appends `(no-op — no previous entry in tab history; URL unchanged)` to the response. Previously reported "Went back" even when Chromium stayed on the same page.

### Added

- **`console_log` includes source location.** Each console message now captures the `url:lineNumber:columnNumber` of its origin (from Playwright's `ConsoleMessage.location()`) and renders it on a continuation line. Diagnosing "Failed to load resource" errors is now possible — previously the URL was stripped.
- **`console_log` captures `pageerror`** (unhandled exceptions, uncaught promise rejections). Previously only `console.*` calls were captured; real JS errors were invisible.

### Migration notes

- If you relied on the `png` screenshot default, add `format: "png"` to existing calls.
- `fill_form` previously passing a `<select>` or radio selector would throw; existing correct calls (all-text-input forms) are unchanged.
- `get_cookies` with a truthy `urls` filter that was previously returning nothing will now return matches (via the host-contains fallback). If this is unwanted, pass `domain` explicitly instead.

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
