---
name: steel-browser
skill-memory:
  enabled: true
description: >
  Use when driving a browser through the Steel MCP backend (gateway server "steel") — load BEFORE
  the first steel invoke of a session. Workflow patterns for navigation, page extraction,
  screenshots, forms, and human handoff, safely and efficiently. Trigger — browse a site, scrape a
  page, fill a form, screenshot a page, drive the browser.
---

# Steel Browser — Workflow Patterns

Tool descriptions cover mechanics. This covers non-obvious patterns that prevent
common failures.

## Calling Convention (CRITICAL — read first)

In **opencode**, Steel is behind **mcp-gateway** — its tools are NOT exposed directly.
Every Steel tool call goes through `mcp-gateway_gateway_invoke`:

```
mcp-gateway_gateway_invoke({ server: "steel", tool: "<toolName>", arguments: { <args> } })
```

e.g. `go_to_url(url: "x", readPage: true)` shown below is shorthand for:
`mcp-gateway_gateway_invoke({ server: "steel", tool: "go_to_url", arguments: { url: "x", readPage: true } })`.

**All examples in this skill use the bare `toolName(args)` shorthand for readability** —
wrap each one in `mcp-gateway_gateway_invoke({ server: "steel", tool, arguments })` when you actually call it.
Need the tool list/schemas? `mcp-gateway_gateway_list_tools({ server: "steel" })`. (The mcporter route in
"Calling Routes" below applies only to OpenClaw agents, a different runtime.)

## Core Rules

- **You are the brain.** The MCP is a dumb Playwright driver. Every decision
  is yours.
- **Never `stop_browser` mid-task.** Destroys the shared session + other agents'
  tabs. For your own cleanup use `close_tabs` (see Concurrent Agents).
- **Auto-init.** No need to call `start_browser` unless you want the Steel
  debug URL to watch live.
- **Shared session.** Other agents may be using this browser. Open your own
  tab with an `owner` tag, operate with `tabId`, clean up with
  `close_tabs` at the end.

## Tool Selection — Which Tool for What

| I want to...                          | Use                                                        | Not                          |
|---------------------------------------|------------------------------------------------------------|------------------------------|
| Read page content                     | `get_page_text(selector: "main")`                          | `evaluate` (overkill)        |
| Navigate + read page (1 call)         | `go_to_url(url, readPage: true)`                           | `go_to_url` then `get_page_text` |
| Read article content cleanly          | `get_page_text(extractContent: true)`                      | `get_page_text` with raw text |
| Read as markdown                      | `get_page_text(extractContent: true, format: "markdown")`  | evaluate + regex             |
| Batch-fetch multiple URLs             | `fetch_urls(urls: [...])`                                  | chaining new_tab + get_page_text |
| Structured data extraction            | `extract(selector, fields)`                                | evaluate with fragile JS     |
| Get article URLs from a list          | `get_links(selector: "main")`                              | `get_page_text(matchAll)`    |
| Scrape structured list data           | `get_page_text(matchAll: true)`                            | `evaluate` + loop            |
| Get data-*, aria-*, src attrs         | `get_attrs(selector, attrs)`                               | `evaluate`                   |
| Type in a search box                  | `fill(fields: [{selector, value, submit}])`                | `evaluate`                   |
| Fill a login form                     | `fill(fields: [...], submitSelector)`                      | Multiple `fill` calls        |
| Click + wait for result               | `click(selector, waitFor: "...")`                          | `click` then `wait_for`      |
| Navigate + wait for content           | `go_to_url(url, waitFor: "...")`                           | `go_to_url` then `wait_for`  |
| Scroll + read in one call             | `scroll(direction, readAfterScroll: true)`                 | scroll then get_page_text    |
| Screenshot to file (default)          | `get_screenshot()` — now defaults to file                  | was inline base64            |
| Check what page I'm on                | `list_tabs(tabId: N)`                                      | ~~get_current_url~~          |
| Clean up my tabs                      | `close_tabs(owner: "agent:mine")`                          | `stop_browser`               |
| Debug page errors                     | `get_console(level: "error")`                              | `evaluate` console scan      |
| Compute/filter/custom extract         | `evaluate(expression: "...")`                              | —                            |

## Common Workflows

### Read a page (1 call)
```
go_to_url(url: "https://example.com", readPage: true, maxChars: 3000)
```

Or with explicit selector (2 calls):
```
go_to_url(url: "https://example.com", waitFor: "main")
get_page_text(selector: "main", maxChars: 3000)
```

### Read article content cleanly
```
go_to_url(url: "https://example.com/article", waitFor: "article")
get_page_text(extractContent: true, format: "markdown", maxChars: 5000)
```

### Research multiple URLs (1 call)
```
fetch_urls(urls: ["https://a.com", "https://b.com"], extractContent: true, maxCharsPerPage: 3000)
```

Returns one result per URL with extracted article text. Fetches in parallel.

### Scrape a list page (2 calls)
```
go_to_url(url: "https://news.site.com", waitFor: "article")
get_page_text(selector: "article", matchAll: true, includeLinks: true, maxEntries: 10)
```

### Login with stored credentials (3 calls)
```
go_to_url(url: "https://app.example.com/login", waitFor: "#email")
use_credential(name: "myapp", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]")
wait_for(text: "Dashboard")
```

### Multi-agent concurrent scrape
```
# Agent A
new_tab(url: "https://site-a.com", owner: "agent:A")   → Tab 3
get_page_text(selector: "main", tabId: 3)
close_tabs(owner: "agent:A")

# Agent B (simultaneously)
create_profile(name: "b-session", url: "https://site-b.com")  → Tab 4
get_page_text(selector: "main", tabId: 4)
save_profile(name: "b-session")
delete_profile(name: "b-session")
```

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
   close_tabs(owner:owner: "agent:my-scraper-12345")
   → Closed 3 tab(s) owned by agent:my-scraper-12345: 7, 9, 11
   ```
   Do NOT call `stop_browser` — that kills everyone's tabs.

### Idle-tab sweeper (automatic)

Tabs with no tool activity for `TAB_IDLE_TIMEOUT_MS` (default 5 min) are
auto-closed. Any `tabId`-targeted tool call refreshes the activity timestamp.
Don't rely on it as your primary cleanup — call `close_tabs` when
you're done. The sweeper is a safety net for abandoned tabs.

### Browser-closed auto-retry (automatic)

If you see `browserContext.newPage: Target page, context or browser has been
closed` on a very recent `start_browser` / `new_tab`, the server now soft-resets
+ retries internally. You don't need retry loops around `new_tab`. If the
retried call still fails, treat it as a real browser outage.

## Credentials — Stored Login Automation

Store site credentials once, reuse them across sessions and profiles without
re-entering passwords. Credentials persist to disk as JSON.

```
# Store a credential
credentials(name: "github", url: "github.com", username: "user@email.com", password: "s3cret")

# List stored credentials (passwords masked — call with no args)
credentials()
→ github: user@email.com @ github.com

# Auto-fill a login form
use_credential(name: "github", usernameSelector: "#login_field", passwordSelector: "#password", submitSelector: "input[type=submit]")
→ Credential "github" applied: username, password, submitted.

# Just retrieve (without filling) — useful for API auth
use_credential(name: "github")
→ { name: "github", url: "github.com", username: "user@email.com", password: "***ret" }
```

### Key rules

- **Encrypted at rest** when `CREDENTIALS_PASSPHRASE` env is set (AES-256-GCM).
  Without it, stored as plain JSON — homelab-only.
- **Extra fields** for 2FA secrets, security questions, etc.:
  `credentials(name: "aws", ..., extra: '{"account_id": "123456"}')`
- **Combine with profiles** for multi-account workflows: create profile
  "github-work", fill with work credential; create "github-personal",
  fill with personal credential. Both active simultaneously.

## Profiles — Concurrent Isolated Sessions

Profiles let multiple agents operate simultaneously with separate cookie jars,
localStorage, and browsing history. Each profile is a distinct BrowserContext
within the same Chromium instance — zero resource duplication.

### When to use profiles

- Multiple agents need **separate auth sessions** (e.g. Agent A logged into
  GitHub, Agent B logged into Jira — concurrently)
- You want to **persist login state** across browser restarts
- You need **isolation** between scraping targets to avoid cookie leaks

### Workflow

```
# 1. Create a named profile (auto-restores saved cookies if available)
create_profile(name: "github", url: "https://github.com")
→ Profile "github" created. Tab ID: 4

# 2. Use the returned tabId for all operations in this profile
go_to_url(url: "https://github.com/notifications", tabId: 4)
get_page_text(selector: "main", tabId: 4)

# 3. Open more tabs within the same profile (pass profile param)
new_tab(url: "https://github.com/pulls", profile: "github", owner: "agent:researcher")
→ Tab 5 [github] (shares profile "github"'s cookies)

# 4. Save the profile state (cookies + localStorage) to disk
save_profile(name: "github")
→ Profile "github" saved to $OUTPUT_DIR/profiles/github.json

# 5. Check what profiles exist
list_profiles()
→ github: active (2 tabs) | saved: 2026-05-02T18:30:00Z
   jira: saved

# 6. Clean up when done
delete_profile(name: "github")
→ Closes all tabs + BrowserContext. Saved state remains on disk.
```

### Key rules

- **Tabs from profiles use the same global tabId space.** All existing tools
  work unchanged — just pass the tabId returned by `create_profile`.
- **Profiles don't share cookies.** That's the point. Each context is isolated.
- **`save_profile` before `stop_browser`.** Stopping the browser kills all
  contexts including profiles. Save first if you want to restore later.
- **Saved profiles survive restarts.** `create_profile("github")` automatically
  restores cookies/localStorage from the last `save_profile("github")` call.
- **Profile HTTP UA limitation.** Profile contexts show `HeadlessChrome` in
  HTTP `User-Agent` headers (server-side). All JS-visible properties
  (`navigator.userAgent`, `platform`, `plugins`, WebGL, etc.) are fully spoofed.
  Most anti-bot detection is client-side JS — the HTTP header rarely matters.

## Cookie Push — Browser Extension Integration

The Steel Cookie Push browser extension lets users push cookies, localStorage,
and credentials from their real browser (Vivaldi/Chrome/Edge) to a Steel profile
in one click. A built-in relay HTTP server receives the push.

### How it works

1. User clicks the extension icon on any site they're logged into
2. Extension grabs cookies + localStorage + optional credentials
3. POSTs to the relay server (runs alongside the MCP stdio transport)
4. Relay writes a profile JSON to disk (same format as `save_profile`)
5. Agent uses `create_profile(name: "...")` to restore the session in Steel

### Agent workflow — using a pushed profile

```
# 1. start_browser shows the relay URL
start_browser()
→ Relay server: http://localhost:3001 (for Steel Cookie Push extension)

# 2. Tell user to push cookies from their browser
#    "Push your github.com cookies using the Steel Cookie Push extension"

# 3. Once pushed, create the profile — auto-restores cookies/localStorage
create_profile(name: "github", url: "https://github.com")
→ Profile "github" created. Tab ID: 4 (restored saved cookies/localStorage)

# 4. You're authenticated — scrape away
get_page_text(selector: "main", tabId: 4)
```

### Key rules

- **Relay URL comes from `start_browser`.** Give the user this URL + the
  shared secret so they can configure the extension.
- **Profile names match.** The extension's "Profile name" field determines
  the filename. Use the same name in `create_profile`.
- **Merges, not replaces.** Pushing again to the same profile merges new
  cookies/localStorage with existing data.
- **Auth: Bearer token.** The relay requires `Authorization: Bearer <RELAY_SECRET>`.
  The extension stores this in `chrome.storage.local`.

## CAPTCHA Solving

CapSolver extension is loaded in the Steel container. It auto-detects and
solves CAPTCHAs via API (token mode — no visual click simulation).

**Supported:** reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, AWS WAF,
GeeTest v4, DataDome, ImageToText.

```
# Check balance and availability before CAPTCHA-heavy tasks
captcha_status()
→ Balance: $10.00 | Extension: loaded (token mode)
```

### Key rules

- **Automatic.** No manual trigger needed — extension detects CAPTCHAs and
  solves them without agent intervention.
- **Token mode.** Solutions are injected via API tokens, not visual clicking.
  More reliable in headless environments.
- **Budget.** ~$0.80-1.20 per 1000 solves depending on type. Check balance
  with `captcha_status` before large batches.
- **Google `/sorry` pages.** CapSolver handles these transparently — wait
  a few seconds after the redirect and the page loads with results.
- **Wait-and-retry built in.** `go_to_url` polls CapSolver for up to 15s when
  it detects a CAPTCHA wall before returning `isError: true`. You don't need
  manual retry loops — the tool waits for the solver to complete.

## Stealth & Fingerprint

The Steel container presents as a macOS Chrome user from South Africa:

- **UA:** macOS Chrome (version varies per container start)
- **Platform:** MacIntel
- **Languages:** en-ZA, en
- **Timezone:** Africa/Johannesburg
- **WebGL:** Apple M-series GPU (Metal renderer)
- **Plugins:** 5 PDF viewer plugins (matches real Chrome)
- **Canvas/Audio:** Per-session noise (anti-correlation across sessions)
- **webdriver:** false (hidden)
- **Intl locale:** en-ZA

The fingerprint is generated fresh on each container start. In the default
context (non-profile tabs), HTTP and JS fingerprints are unified. Profile
contexts have full JS-level stealth but HTTP headers show the real Chrome UA
(see profile limitation above).

## Calling Routes

Two ways this MCP is reached. Escaping rules differ.

1. **mcp-gateway** (opencode). Reach every Steel tool via
   `mcp-gateway_gateway_invoke({ server: "steel", tool: "<tool>", arguments: { ... } })` — args are
   native objects, no shell escaping. This is the route for opencode (see Calling Convention at top).
2. **mcporter + exec** (OpenClaw agents — a different runtime). `mcporter call steel.<tool> key=value
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

1. **Orient** — `list_tabs` / `list_tabs` before acting. Cheap.
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

Before returning `isError`, the tool polls CapSolver for up to 15s to give the
solver time to complete. If the CAPTCHA resolves, navigation continues normally.
If it doesn't, `isError: true` is returned with the final URL + title.

Hand off via `start_browser` Interactive URL (HITL section below). Don't retry.

### Error Loop Detection (automatic)

`ErrorTracker` in `src/helpers.ts` monitors repeated failures to the same URL
or domain. When the same destination fails multiple times in a session, the tool
emits a warning in the response. This surfaces patterns like:
- Repeated 404s to the same path (bad URL construction)
- Repeated bot-walls from the same domain (IP blocked)

No action required — it's a diagnostic signal. If you see the warning, stop
iterating and diagnose the root cause.

## Legacy Wait Pattern

Still supported for fine-grained control or post-click waits:

```
go_to_url(url: "...")
wait_for(selector: "article")      # or text: "Load More", textGone: "Loading..."
```

Skip waits only for pure static pages (plain HTML, e.g. Ars Technica article bodies).

## State Hygiene

Don't trust leftover browser state for a new task.

- Start with `list_tabs` / `list_tabs`.
- For fresh work, explicitly `new_tab(url: ...)` instead of reusing.
- On unrelated page, re-orient before reading.

## Minimal Smoke Test

Proves Steel works:

```
go_to_url(url: "https://example.com")
list_tabs()
get_page_text(selector: "body", maxChars: 500)
get_screenshot()                                             # defaults to file mode
```

## Protect Context Window

Page text + screenshots can be huge. Constrain:

- `get_page_text` — `maxChars: 3000`, scoped `selector` (e.g. `"main"`,
  `"article"`, `"#results"`). Full page only when needed. Default maxChars is 5K.
- `get_screenshot` — default `outputMode: "file"` (prevents base64 context bloat).
  Default format is `"webp"` (smallest). Quality defaults to 80. Use `scale: 0.5`
  for large pages. Use `maxWidth`/`maxHeight`/`maxFileBytes` to cap output size
  via post-capture resize/compress. Pass `format: "png"` when you need lossless
  (diagrams, UI regression shots).
- `cookies` — default caps at 50 cookies. Prefer `domain: "example.com"`
  over `urls: [...]`; simpler and robust against Playwright's matcher quirks.
- `evaluate` — return only fields needed; no full DOM trees. `maxChars` cap
  (default 10K); use `outputMode: "file"` for large computed results.

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
- `maxChars` — cap text per entry (default 5000)
- `maxEntries` — cap array length (default 20; 0 = no cap)
- `pretty: true` — 2-space indent inline JSON (default false = compact one-per-line)
- `outputMode: "file"` — save JSON to disk if huge (always pretty on file)
- `extractContent: true` — Readability article extraction (strips nav/ads)
- `format: "markdown"` — convert extracted HTML to markdown via turndown

Sanitization in matchAll:
- `text` has anchor text only; no embedded `[href]` tokens (links are in the separate `links` array)
- Anchor text whitespace collapsed (internal `\n`/tabs stripped)
- `links` deduped by href (fragment stripped); **first non-empty text wins in DOM order** (headline anchor comes before excerpt anchor on news pages, so this picks the headline)
- `primaryLink` picks first link whose path depth ≥ 2 (filters nav/category like `/world/`); falls back to first link
- `title` = text of the link whose href matches `primaryLink` — use directly as article headline

Default (`matchAll: false`) → single-match string behavior preserved; `includeLinks` still embeds `[href]` in text for legacy use.

### Path 1b — `fetch_urls` (batch parallel fetch)

When you have a list of URLs to read, `fetch_urls` fetches them all in parallel
(up to 10) in a single tool call:

```
fetch_urls(
  urls: ["https://a.com/article", "https://b.com/post"],
  extractContent: true,
  maxCharsPerPage: 3000
)
```

Returns one result per URL. Faster than chaining `new_tab` + `get_page_text` per URL.

### Path 1c — `extract` (declarative field extraction)

When you need structured data from a known page shape, `extract` maps a CSS
selector to a field schema and returns JSON — no JS required:

```
extract(
  selector: "article.product-card",
  fields: {
    name: "h2.title",
    price: ".price",
    sku: "[data-sku]"
  }
)
```

Returns an array of objects matching the field map. Prefer over `evaluate` when
the page structure is predictable — less fragile than hand-written JS.

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

Before returning `isError`, the tool waits up to 15s for CapSolver to resolve
the CAPTCHA. If it resolves, navigation continues normally. If not, `isError: true`
is returned with the final URL + title.

For bot walls that appear **after** a click (rare — usually on form submits):

```
list_tabs()              # check for unexpected redirect
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
list_tabs()   # confirm landing, not error
```

**Many fields (sign-up / checkout / multi-input):** `fill` in one call.
Auto-detects each field's type and dispatches correctly (0.6.0+):
- text/email/tel/password/url/number/textarea/date/time → `page.fill`
- `<select>` → `page.selectOption` (value by default; use `kind: "selectLabel"` for label or `kind: "selectIndex"` for index)
- checkboxes — three value shapes:
  - truthy token (`"true"`, `"1"`, `"on"`, `"yes"`, `"checked"`, `"y"`) → `page.check`
  - falsy token (`"false"`, `"0"`, `"off"`, `"no"`, `"unchecked"`, `"n"`, `""`) → `page.uncheck`
  - anything else → treats value as the option-value; targets the specific checkbox whose `value` attribute matches and checks it (same shape as radio)
- radios → click the radio whose `value` attribute matches the given value

```
fill(
  fields: [
    {selector: "input[name=email]", value: "user@example.com"},
    {selector: "input[name=password]", value: "secret"},
    {selector: "input[name=newsletter]", value: "yes"},          # checkbox truthy → check
    {selector: "input[name=topping]", value: "cheese"},          # checkbox group → check the cheese option
    {selector: "input[name=topping]", value: "bacon"},           # same group → also check bacon
    {selector: "input[name=plan]", value: "pro"},                # radio group
    {selector: "select[name=country]", value: "za"},             # select by value
    {selector: "select[name=size]", value: "Medium", kind: "selectLabel"},
    {selector: "input[name=dob]", value: "1990-04-18"},          # date input
  ],
  submitSelector: "button[type=submit]"
)
wait_for(text: "Welcome")
```

`fill` replaces N separate tool calls with one. Pass `skipMissing: true` if some fields are conditionally rendered. Force a specific dispatch per field with `kind: "text"|"check"|"radio"|"select"|"selectLabel"|"selectIndex"`.

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
list_tabs()
```

Never handle 2FA / credentials yourself.

### Persist / restore an auth session

After a successful HITL login, dump the cookies so the next run can skip
the login entirely. Prefer `domain` filter over `urls` — simpler and robust:

```
cookies(domain: "target.example.com", limit: 0)
→ [{name, value, domain, expires, ...}, ...]
# Save the JSON to disk.

# Next run:
cookies(setCookies:cookies: [...])   # paste the saved array
go_to_url(url: "https://target.example.com/dashboard")
```

`cookies` / `cookies` operate on the shared context, so cookies
survive until `stop_browser` or until they expire naturally.

**Output cap**: without `limit`, `cookies` returns at most 50 cookies
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
close_tabs(owner:owner: "agent:my-job-42")                      # clean up both
```

Rules:
- Always pass `tabId` so concurrent agents don't race on a global active-tab
  pointer.
- `new_tab` uses real CDP context; visible in session viewer.
- Never `browser.newPage()` / `browser.newContext()` directly — phantom
  contexts. Always use MCP tools.
- Prefer `close_tabs` over `stop_browser` for end-of-task cleanup.

## Debugging Failures

First stop for unexpected page behavior:

```
get_console(level: "error")
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
- `"webp"` — smallest. **Default.** Uses CDP directly (requires Chromium ≥ 88).
- `"jpeg"` — widely compatible. Good for photos/screenshots with gradients.
- `"png"` — lossless. Good for UI regression shots, diagrams with text.

Default `outputMode` is `"file"` — screenshots are saved to disk and the path
is returned. This prevents base64 blobs from bloating the context window. Pass
`outputMode: "inline"` only when you need to read the image directly.

Post-capture resize/compress via `@napi-rs/image`:
- `maxWidth` / `maxHeight` — resize to fit within these dimensions (aspect-ratio preserved)
- `maxFileBytes` — compress until file is under this size

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
- 1 `go_to_url` (with `readPage: true` to combine nav + extract)
- 1 `get_page_text` with `matchAll` (list extraction, if not using readPage)
- 1 `list_tabs` (verify, optional)

≈ 3–5 calls total per page with `readPage`. If you exceed 8 without new info, stop + probe
with the selector diagnostic — don't iterate blind.
