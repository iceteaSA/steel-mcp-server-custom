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
- **Never `stop_browser` mid-task.** Destroys session + state. Only at very end.
- **Auto-init.** No need to call `start_browser` unless you want the Steel
  debug URL to watch live.
- **Shared session.** Other agents may be using this browser. Join via
  `new_tab`; never reset.

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

## `wait_for` Before `evaluate` — Mandatory on JS-Rendered Pages

Common failure: `go_to_url` → `evaluate` → empty array. Page hadn't hydrated.

Rule: for any JS-rendered site (news sites, SPAs, dashboards, most modern
pages), call `wait_for` on a known content selector FIRST:

```
go_to_url(url: "https://www.news24.com/world")
wait_for(selector: "article")      # or text: "Load More", textGone: "Loading..."
get_page_text(selector: "article.article-item", matchAll: true, includeLinks: true)
```

Skip only for pure static pages (plain HTML, e.g. Ars Technica article bodies).

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
get_screenshot(format: "jpeg", quality: 60, outputMode: "file")
```

## Protect Context Window

Page text + screenshots can be huge. Constrain:

- `get_page_text` — `maxChars: 3000`, scoped `selector` (e.g. `"main"`,
  `"article"`, `"#results"`). Full page only when needed.
- `get_screenshot` — `format: "jpeg", quality: 60` default (far smaller than
  PNG). `outputMode: "file"` when not reading inline. `scale: 0.5` for large.
- `evaluate` — return only fields needed; no full DOM trees.

## Extracting Structured Data — Pick the Right Path

### Path 1 — `get_page_text` with `matchAll: true` (preferred for list pages)

One call replaces N evaluates when scraping article cards, product tiles,
search results. Returns JSON array with per-element `{text, primaryLink, links}`.

```
get_page_text(
  selector: "article.article-item",
  matchAll: true,
  includeLinks: true,
  maxChars: 500,
  maxEntries: 10
)
```

Output:
```json
[
  {
    "text": "LIVE 1h ago Trump rejects NATO offer... [https://news24.com/...]",
    "primaryLink": "https://news24.com/world/...",
    "links": [{"text": "Trump rejects...", "href": "https://..."}]
  }
]
```

Flags:
- `matchAll: true` → querySelectorAll, one entry per match
- `includeLinks: true` → adds `primaryLink` (first `<a>`) + `links` array
- `maxChars` — cap text per entry
- `maxEntries` — cap array length (default 20; 0 = no cap)
- `outputMode: "file"` — save JSON to disk if huge

Default (`matchAll: false`) → single-match string behavior preserved.

### Path 2 — `evaluate` (when shape doesn't fit matchAll)

Use for computed fields (parsed dates, joined rows, filtered subsets, data
not on the DOM surface):

```
evaluate(expression: "Array.from(document.querySelectorAll('tr')).map(r => r.innerText)")
evaluate(expression: "Array.from(document.querySelectorAll('a.result')).map(a => ({text: a.textContent.trim(), href: a.href}))")
```

### Selector Diagnostic — One Call, Not a Retry Loop

When `matchAll` returns `[]`, don't iterate blind. Probe:

```
evaluate(expression: "({n: document.querySelectorAll('article').length, sample: [...document.querySelectorAll('article')].slice(0,1).map(e => e.outerHTML.slice(0,500))})")
```

Returns `{n: 21, sample: ["<article class=\"...\" ...>"]}`. Read the classes
+ nested link structure from the sample, craft the real selector, retry ONCE.

## Bot-Check / Cloudflare Detection

After `go_to_url` or `click` that causes navigation:

```
get_current_url()   # check for unexpected redirect
```

Cloudflare / anti-bot signals:
- title contains `"Just a moment"` / `"Attention Required"` / `"Access denied"`
- URL path includes `/cdn-cgi/challenge-platform/`
- body empty or shows a spinner with no article content

On detection: stop automation. Hand off to user via HITL pattern (below).
Don't retry — same IP will fail again.

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

## Multi-Step Form Pattern

Type into each field separately. `clear: true` (default) replaces. `submit:
true` on last field only:

```
type(selector: "input[name=email]", text: "user@example.com")
type(selector: "input[name=password]", text: "secret")
click(selector: "button[type=submit]")
wait_for(text: "Dashboard")
get_current_url()   # confirm landing, not error
```

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

## Multi-Tab Workflows

Tabs are per-session, each with own URL/cookies/DOM.

```
new_tab(url: "https://site-b.com")     # opens Tab 2
get_page_text(selector: "main", maxChars: 2000)
switch_tab(tabId: 1)                   # back to Tab 1
list_tabs()
close_tab(tabId: 2)                    # done with Tab 2
```

Rules:
- All tools act on the **active tab** — `switch_tab` first if needed.
- `new_tab` uses real CDP context; visible in session viewer.
- Never `browser.newPage()` / `browser.newContext()` directly — phantom
  contexts. Always use MCP tools.

## Debugging Failures

First stop for unexpected page behavior:

```
console_log(level: "error")
```

Network failures, JS errors, CSP violations all appear here. Check this before
blaming selectors.

## Output Paths (openclaw agents)

Discord can only send files from under `~/.openclaw/`. Set `outputPath` on
screenshots / saved text:

```
get_screenshot(
  format: "jpeg", quality: 70,
  outputMode: "file",
  outputPath: "/home/openclaw/.openclaw/workspace/artifacts/<name>.jpeg"
)
```

Same for `get_page_text` with `outputMode: "file"` — use
`/home/openclaw/.openclaw/workspace/artifacts/<name>.txt`.

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
