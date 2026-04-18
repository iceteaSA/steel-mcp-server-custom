---
name: steel-browser
description: >
  Workflow patterns for using Steel MCP browser tools safely and efficiently for
  navigation, extraction, screenshots, forms, and human handoff.
---

# Steel Browser — Workflow Patterns

Tool descriptions cover mechanics. This covers non-obvious patterns that prevent
common failures.

## Core Rules

- **You are the brain.** The MCP is a dumb Playwright driver. Every decision
  is yours.
- **Never `stop_browser` mid-task.** Destroys the shared session + other agents'
  tabs. For your own cleanup use `close_tabs_by_owner` (see Concurrent Agents).
- **Auto-init.** No need to call `start_browser` unless you want the Steel
  debug URL to watch live.
- **Shared session.** Other agents may be using this browser. Open your own
  tab with an `owner` tag, operate with `tabId`, clean up with
  `close_tabs_by_owner` at the end.

## Concurrent Agents — Tab Ownership

Multiple agents share one browser session. To avoid stepping on each other:

1. **Open your own tab with an owner tag.** Pick a unique string per agent
   (e.g. `"agent:my-scraper-<timestamp>"`):
   ```
   new_tab(url: "https://example.com", owner: "agent:my-scraper-12345")
   → Opened Tab 7 (owner=agent:my-scraper-12345)
   ```

2. **Pin operations to your tab via `tabId`.** All page-interacting tools
   (`go_to_url`, `get_page_text`, `get_links`, `get_attrs`, `click`, `type`,
   `evaluate`, `wait_for`, `scroll`, `history`, `get_screenshot`, etc.) accept
   an optional `tabId`. Without it, the tool uses the global current-active-tab,
   which another agent may have moved. Always pass your `tabId`:
   ```
   get_page_text(selector: "article", matchAll: true, tabId: 7)
   go_to_url(url: "https://other-site.com", tabId: 7)
   ```

3. **Clean up only your own tabs** at end of task:
   ```
   close_tabs_by_owner(owner: "agent:my-scraper-12345")
   → Closed 3 tab(s) owned by agent:my-scraper-12345: 7, 9, 11
   ```
   Do NOT call `stop_browser` — that kills everyone's tabs.

### Idle-tab sweeper (automatic)

Tabs with no tool activity for `TAB_IDLE_TIMEOUT_MS` (default 5 min) are
auto-closed. Any `tabId`-targeted tool call refreshes the activity timestamp.
Don't rely on it as your primary cleanup — call `close_tabs_by_owner` when
you're done. The sweeper is a safety net for abandoned tabs.

### Browser-closed auto-retry (automatic)

If you see `browserContext.newPage: Target page, context or browser has been
closed` on a very recent `start_browser` / `new_tab`, the server now soft-resets
+ retries internally. You don't need retry loops around `new_tab`. If the
retried call still fails, treat it as a real browser outage.

## Calling Routes

Two ways this MCP is reached. Escaping rules differ.

1. **Direct MCP** (opencode / Claude Code tools). Call tools by name; args are
   native objects. No shell escaping. Preferred when available.
2. **mcporter + exec** (OpenClaw agents). `mcporter call steel.<tool> key=value
   --output json`. The command is a shell string. Watch quoting (see below).

## Shell Escaping — mcporter Route

Quote rules for `mcporter call steel.evaluate expression=<JS>`:

- Wrap `expression` in **single quotes**; escape inner single quotes as
  `'\''`. Keep JS on ONE line. Multi-line JS via `\n` or literal newline
  fails with `SyntaxError: Unexpected end of input`.
- Prefer `matchAll` (below) to skip JS entirely on list pages.
- If JS is long, write it to a file via `write` tool and load via `evaluate
  expression="$(cat /tmp/script.js)"` — still one line of actual JS.

Known-bad example:
```
expression="\n(function(){\n  const out = [];\n  ...\n})()"
```
→ shell interprets `\n` as backslash-n, JS parser chokes.

Known-good:
```
expression='(() => { const out = []; document.querySelectorAll("article").forEach(a => out.push({t:a.innerText.slice(0,80)})); return out.slice(0,5); })()'
```

## Orient → Act → Confirm

1. **Orient** — `get_current_url` / `list_tabs` before acting. Cheap.
   After `go_to_url`, re-check URL — redirects to login/bot-check happen silently.
2. **Act** — click, type, navigate.
3. **Confirm** — `wait_for` before reading. Don't assume page updated.

## Nav + Wait in One Call (`go_to_url` waitFor)

`go_to_url` accepts optional `waitFor` selector + `waitTimeout` (default 10000ms). One call does nav + content-ready wait:

```
go_to_url(url: "https://news.example.com/section", waitFor: "article.item")
get_page_text(selector: "article.item", matchAll: true, includeLinks: true)
```

That's 2 exec instead of 3 (`go_to_url` → `wait_for` → `get_page_text`). Saves a round trip per page.

If waitFor times out, `go_to_url` returns success with a `TIMED OUT` note in text — page loaded but selector missing. Not an error, just a signal to diagnose with the selector-diagnostic pattern below.

### Bot-Check Detection (automatic)

`go_to_url` returns `isError: true` when destination is:
- Title matches `/just a moment|attention required|access denied|verify you are human/i`
- URL matches `/cdn-cgi/challenge-platform/`

Error message includes final URL + title. Hand off via `start_browser` Interactive URL (HITL section below). Don't retry.

## Legacy Wait Pattern

Still supported for fine-grained control or post-click waits:

```
go_to_url(url: "...")
wait_for(selector: "article")      # or text: "Load More", textGone: "Loading..."
```

Skip waits only for pure static pages (plain HTML, e.g. Ars Technica article bodies).

## State Hygiene

Don't trust leftover browser state for a new task.

- Start with `get_current_url` / `list_tabs`.
- For fresh work, explicitly `new_tab(url: ...)` instead of reusing.
- On unrelated page, re-orient before reading.

## Minimal Smoke Test

Proves Steel works:

```
go_to_url(url: "https://example.com")
get_current_url()
get_page_text(selector: "body", maxChars: 500)
get_screenshot(outputMode: "file")                           # webp default in 0.6.0+
```

## Protect Context Window

Page text + screenshots can be huge. Constrain:

- `get_page_text` — `maxChars: 3000`, scoped `selector` (e.g. `"main"`,
  `"article"`, `"#results"`). Full page only when needed.
- `get_screenshot` — default format is `"webp"` (0.6.0+), the smallest option.
  Quality defaults to 80. Use `outputMode: "file"` when not reading inline.
  Use `scale: 0.5` for large pages. Pass `format: "png"` when you need
  lossless (diagrams, UI regression shots).
- `get_cookies` — default caps at 50 cookies. Prefer `domain: "example.com"`
  over `urls: [...]`; simpler and robust against Playwright's matcher quirks.
- `evaluate` — return only fields needed; no full DOM trees.

## Extracting Structured Data — Pick the Right Path

### Path 1 — `get_page_text` with `matchAll: true` (preferred for list pages)

One call replaces N evaluates when scraping article cards, product tiles, search results. Returns JSON array with per-element `{text, title?, primaryLink?, links?}`.

```
get_page_text(
  selector: "article.article-item",
  matchAll: true,
  includeLinks: true,
  maxChars: 500,
  maxEntries: 10
)
```

Output (compact — one entry per line):
```json
[
{"text":"Section 1h ago Article headline here Excerpt of the article appears next…","title":"Article headline here","primaryLink":"https://news.example.com/section/article-slug-12345","links":[{"text":"Section","href":"https://news.example.com/section"},{"text":"Article headline here","href":"https://news.example.com/section/article-slug-12345"}]}
]
```

Flags:
- `matchAll: true` → querySelectorAll, one entry per match
- `includeLinks: true` → adds `title`, `primaryLink`, and deduped `links` array
- `maxChars` — cap text per entry (default 10000)
- `maxEntries` — cap array length (default 20; 0 = no cap)
- `pretty: true` — 2-space indent inline JSON (default false = compact one-per-line)
- `outputMode: "file"` — save JSON to disk if huge (always pretty on file)

Sanitization in matchAll:
- `text` has anchor text only; no embedded `[href]` tokens (links are in the separate `links` array)
- Anchor text whitespace collapsed (internal `\n`/tabs stripped)
- `links` deduped by href (fragment stripped); **first non-empty text wins in DOM order** (headline anchor comes before excerpt anchor on news pages, so this picks the headline)
- `primaryLink` picks first link whose path depth ≥ 2 (filters nav/category like `/world/`); falls back to first link
- `title` = text of the link whose href matches `primaryLink` — use directly as article headline

Default (`matchAll: false`) → single-match string behavior preserved; `includeLinks` still embeds `[href]` in text for legacy use.

### Path 2 — `get_links` (URL-only, no text walking)

Lightest path when you only need URLs from a page:

```
get_links(
  selector: "main",                                          # optional, defaults to body
  urlPattern: "example\\.com/section/[a-z-]+-\\d+",          # optional regex (no slashes)
  limit: 50                                                  # default 50; 0 = no cap
)
```

Returns deduped `[{text, href}]`. Same first-non-empty-text dedup as matchAll. Use when building link indexes, sitemap scrapes, or feeding URLs into follow-up fetches.

**Selector scope is querySelectorAll (0.6.0+)** — `selector: "article"` iterates every `<article>` on the page and concatenates their descendant anchors. Previous versions scoped to the first match only — pass `selector` freely now to scope to list items.

Example output:
```json
[
{"text":"First headline","href":"https://news.example.com/section/first-headline-12345"},
{"text":"Second headline","href":"https://news.example.com/section/second-headline-12346"}
]
```

### Path 3 — `get_attrs` (custom attributes per element)

Use when you need specific attributes (data-*, aria-*, src, alt, href) rather than full text or just links:

```
get_attrs(
  selector: "article.product-card",
  attrs: ["data-product-id", "data-price", "aria-label", "text"],
  limit: 50
)
```

Returns compact JSON (one object per line) with ONLY the requested attributes. Special names: `"text"` = innerText (layout-aware, preserves whitespace between block-level children — matches what a user sees), `"html"` = outerHTML. Missing attributes become `null`.

Use cases: scraping product grids with structured data, extracting widget state, pulling embed IDs from iframes.

### Path 4 — `evaluate` (when shape doesn't fit Paths 1–3)

Use for computed fields (parsed dates, joined rows, filtered subsets, data not on the DOM surface):

```
evaluate(expression: "Array.from(document.querySelectorAll('tr')).map(r => r.innerText)")
evaluate(expression: "Array.from(document.querySelectorAll('a.result')).map(a => ({text: a.textContent.trim(), href: a.href}))")
```

**Element-scoped evaluate** — pass `selector` and reference the element as `el`:

```
evaluate(selector: "h1.headline", expression: "el.textContent.trim()")
evaluate(selector: "article[data-id]", expression: "el.getAttribute('data-id')")
evaluate(selector: ".price", expression: "parseFloat(el.textContent.replace(/[^0-9.]/g, ''))")
```

Returns `null` if the selector matches nothing. The selector is JSON-stringified
so you don't have to escape it yourself.

### Selector Diagnostic — One Call, Not a Retry Loop

When `matchAll` / `get_links` returns `[]`, don't iterate blind. Probe:

```
evaluate(expression: "({n: document.querySelectorAll('article').length, sample: [...document.querySelectorAll('article')].slice(0,1).map(e => e.outerHTML.slice(0,500))})")
```

Returns `{n: 21, sample: ["<article class=\"...\" ...>"]}`. Read the classes + nested link structure from the sample, craft the real selector, retry ONCE.

## Bot-Check / Cloudflare Detection

`go_to_url` auto-detects and returns `isError: true` (see "Nav + Wait in One Call" above). No manual check needed after nav.

For bot walls that appear **after** a click (rare — usually on form submits):

```
get_current_url()              # check for unexpected redirect
evaluate(expression: "document.title")
```

If signals match (`Just a moment`, `Attention Required`, `/cdn-cgi/challenge-platform/`): stop automation. Hand off via HITL pattern. Don't retry — same IP fails again.

## Waiting Correctly

Never `sleep`. Use `wait_for`:

```
click(selector: "button[type=submit]")
wait_for(text: "Order confirmed")
get_page_text(selector: "main", maxChars: 2000)
```

Spinners/loading: use `textGone`:
```
wait_for(textGone: "Loading...", timeout: 15000)
```

**`history` no-op detection (0.6.0+)**: `history(action: "back")` on the first
page of a tab's history returns `(no-op — no previous entry in tab history; URL unchanged)`
in the response. Previously it silently reported "Went back" even when nothing
moved. Same for forward on the last page.

## Multi-Step Form Pattern

Two ways — pick by field count:

**Small (1-2 fields):** `type` + `click` is fine.
```
type(selector: "input[name=email]", text: "user@example.com")
type(selector: "input[name=password]", text: "secret")
click(selector: "button[type=submit]")
wait_for(text: "Dashboard")
get_current_url()   # confirm landing, not error
```

**Many fields (sign-up / checkout / multi-input):** `fill_form` in one call.
Auto-detects each field's type and dispatches correctly (0.6.0+):
- text/email/tel/password/url/number/textarea/date/time → `page.fill`
- `<select>` → `page.selectOption` (value by default; use `kind: "selectLabel"` for label or `kind: "selectIndex"` for index)
- checkboxes → `page.check`/`page.uncheck` based on truthy/falsy string value
- radios → click the radio whose `value` attribute matches the given value

```
fill_form(
  fields: [
    {selector: "input[name=email]", value: "user@example.com"},
    {selector: "input[name=password]", value: "secret"},
    {selector: "input[name=newsletter]", value: "yes"},          # checkbox
    {selector: "input[name=plan]", value: "pro"},                # radio group
    {selector: "select[name=country]", value: "za"},             # select by value
    {selector: "select[name=size]", value: "Medium", kind: "selectLabel"},
    {selector: "input[name=dob]", value: "1990-04-18"},          # date input
  ],
  submitSelector: "button[type=submit]"
)
wait_for(text: "Welcome")
```

`fill_form` replaces N separate tool calls with one. Pass `skipMissing: true` if some fields are conditionally rendered. Force a specific dispatch per field with `kind: "text"|"check"|"radio"|"select"|"selectLabel"|"selectIndex"`.

## Human-in-the-Loop (HITL)

CAPTCHA / 2FA / login walls / Cloudflare block → hand off:

1. `start_browser()` → returns **Session Viewer** + **Interactive URL**
2. Send user the Interactive URL + task description
3. Wait for user confirmation
4. Continue — cookies/auth preserved

```
start_browser()
→ "Interactive URL: https://steel.example.com/v1/sessions/debug?..."
[user logs in]
wait_for(text: "Dashboard", timeout: 60000)
get_current_url()
```

Never handle 2FA / credentials yourself.

### Persist / restore an auth session

After a successful HITL login, dump the cookies so the next run can skip
the login entirely. Prefer `domain` filter over `urls` — simpler and robust:

```
get_cookies(domain: "target.example.com", limit: 0)
→ [{name, value, domain, expires, ...}, ...]
# Save the JSON to disk.

# Next run:
set_cookies(cookies: [...])   # paste the saved array
go_to_url(url: "https://target.example.com/dashboard")
```

`get_cookies` / `set_cookies` operate on the shared context, so cookies
survive until `stop_browser` or until they expire naturally.

**Output cap**: without `limit`, `get_cookies` returns at most 50 cookies
and appends a `[CAPPED — N total]` footer. Set `limit: 0` for all cookies.
Shared multi-agent contexts can hold hundreds of cross-site cookies, so
prefer filtering via `domain` or `urls` to keep output tight.

**urls filter fallback**: if Playwright's exact-match URL filter returns
nothing (happens with some Set-Cookie redirect chains), the tool automatically
falls back to a host-contains match across all cookies. Usually invisible —
surfaces in the result the same way a clean match would.

## Multi-Tab Workflows

Tabs are per-session, each with own URL/cookies/DOM. For concurrent-safe use,
always address tabs by their `tabId` — never rely on a shared "active tab".

```
a = new_tab(url: "https://site-a.com", owner: "agent:my-job-42")  # → Tab 7
b = new_tab(url: "https://site-b.com", owner: "agent:my-job-42")  # → Tab 8
get_page_text(selector: "main", maxChars: 2000, tabId: 7)
go_to_url(url: "https://site-c.com", tabId: 8)
get_page_text(selector: "article", matchAll: true, tabId: 8)
close_tabs_by_owner(owner: "agent:my-job-42")                      # clean up both
```

Rules:
- Always pass `tabId` so concurrent agents don't race on a global active-tab
  pointer.
- `new_tab` uses real CDP context; visible in session viewer.
- Never `browser.newPage()` / `browser.newContext()` directly — phantom
  contexts. Always use MCP tools.
- Prefer `close_tabs_by_owner` over `stop_browser` for end-of-task cleanup.

## Debugging Failures

First stop for unexpected page behavior:

```
console_log(level: "error")
```

Network failures, JS errors, CSP violations all appear here. Check this before
blaming selectors.

**Source location included (0.6.0+)**: each entry renders with an `at url:line:col`
continuation line when Playwright captures a location. Essential for diagnosing
"Failed to load resource" 404s — previous versions stripped the URL.

**`pageerror` captured too (0.6.0+)**: unhandled JS exceptions and uncaught
promise rejections are recorded as `[ERROR] [pageerror] ErrorType: message`.
These don't surface on `console.*` — previously invisible.

## Screenshots — format, scope, output path

Format choices (smallest → largest):
- `"webp"` — smallest. **Default in 0.6.0+.** Uses CDP directly (requires Chromium ≥ 88).
- `"jpeg"` — widely compatible. Good for photos/screenshots with gradients.
- `"png"` — lossless. Good for UI regression shots, diagrams with text.

Scope:
- `selector: "article.hero"` — capture just that element's bounding box.
  Tighter output than `fullPage + clip` math. Matched-count error if 0.
- `clip: {x,y,width,height}` — manual rectangle. Mutually exclusive with `selector`.
- `fullPage: true` — full scrollable page (no scope args).
- None of the above — current viewport.

```
get_screenshot(
  selector: "article.hero",
  format: "webp", quality: 75,
  outputMode: "file",
  outputPath: "$WORKSPACE/artifacts/hero.webp",
  tabId: 7
)
```

### Sandboxed agents (output path)

Some agent runtimes (e.g. OpenClaw) require attachments to resolve under a
specific workspace directory. Pass an explicit `outputPath` under that root:

```
get_screenshot(
  format: "webp", quality: 70,
  outputMode: "file",
  outputPath: "$WORKSPACE/artifacts/<name>.webp"
)
```

Same for `get_page_text` with `outputMode: "file"` — use
`$WORKSPACE/artifacts/<name>.txt`. Substitute `$WORKSPACE` with your runtime's
allowed output root.

## Downloading Binaries

`download_file` handles two delivery shapes (0.6.0+):

1. **Attachment downloads** — URLs that send `Content-Disposition: attachment`
   (or a MIME Chromium saves by default). Uses `waitForEvent('download')`,
   works around `ERR_ABORTED` on `page.goto`.
2. **Inline binaries** — URLs that serve `application/octet-stream`, PDFs, CSVs,
   or API-served bytes WITHOUT a disposition header. Chromium views these
   inline — no download event fires. On timeout, the tool falls back to
   `context.request.fetch(url)` which reuses the browser session's cookies
   and auth, and writes the body directly to disk.

```
download_file(
  url: "https://example.com/report.pdf",
  outputPath: "$WORKSPACE/artifacts/downloads/report.pdf",
  tabId: 7
)
→ "Downloaded report.pdf [via download-event]\nSaved to: ...\nSize: 184,329 bytes"

# Or for a known-inline API binary:
download_file(
  url: "https://api.example.com/export.csv",
  forceFetch: true,                 # skip download-event path
  outputPath: "$WORKSPACE/artifacts/export.csv"
)
→ "Downloaded export.csv [via forceFetch]\nSaved to: ...\nSize: 5,432 bytes"
```

Filename falls back to the last URL path segment + MIME-derived extension
when the server doesn't suggest one.

If the download is triggered by a click (not a direct URL):
```
click(selector: "a.download-link", tabId: 7)
# then wait for file to appear under your output dir, extract via kreuzberg, etc.
```

## Call Budget Discipline

Rough budget for a single scrape task:
- 1 `list_tabs` (check session)
- 1 `new_tab` (own tab)
- 1 `go_to_url`
- 1 `wait_for` (content loaded)
- 1 `get_page_text` with `matchAll` (list extraction)
- 1 `get_current_url` (verify, optional)

≈ 5–6 calls total per page. If you exceed 8 without new info, stop + probe
with the selector diagnostic — don't iterate blind.
