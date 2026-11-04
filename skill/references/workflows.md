# Steel Browser — Workflow Patterns

Tool descriptions cover mechanics. This covers non-obvious patterns that prevent
common failures.

## Call tools through Code Mode

Call Steel tools inside Code Mode with native JavaScript objects:

```javascript
return await tools["steel"].go_to_url({ url: "https://example.com", readPage: true });
```

- Find the exact tool signature through Code Mode search before a call.
- Translate the shorthand examples below to `tools["steel"].<tool>({ ... })`.
- Await each call whose result is necessary.
- Use `Promise.allSettled` only for independent calls on separate tabs.
- Keep the tab ID from the result and give it on each call to that page.

## Core Rules

- **You are the brain.** The MCP is a dumb Playwright driver. Every decision
  is yours.
- Use `close_tabs` for selected tabs and `close_lane` to close your lane.
- **Auto-init.** No need to call `start_browser` unless you want the Steel
  debug URL to watch live.
- Use your caller lane in the shared browser. Give `tabId` for workflows with multiple tabs.
- Read [lane instructions](#concurrent-agents-and-lanes) before work with multiple callers or saved profiles.

## Snapshot-First — The Default Read

The preferred first look at any page is `snapshot`, not `get_page_text`.
`snapshot` returns the accessibility tree with compact `@eN` ref tokens.
That structure is both cheaper (no layout/walk costs) and more actionable —
refs feed `click` / `fill` / `scroll` / `wait_for` / `get_attrs` / `extract`
/ `press_key` directly. No selector guessing.

The default `filter:"interactive"` shows only actionable elements (buttons,
links, inputs) plus their structural ancestors — typically 3-5× fewer nodes
than the full tree. Pass `filter:"all"` when you need the complete tree.

```
# 1. Snapshot the page (filter:"interactive" is the default)
snapshot(tabId: 7)
→ [Tab 7] https://example.com/login
  generic @e1 "Sign in to your account"
  textbox  "Email"    @e2
  textbox  "Password" @e3
  button   "Sign in"  @e4

# 2. Click / fill by ref (pass @e2 or bare e2 — both are accepted)
fill(fields: [{ref: "@e2", value: "me@example.com"}, {ref: "@e3", value: "..."}], tabId: 7)
click(ref: "@e4", tabId: 7)

# 3. Read the action feedback (snapshot-diff line in the result)
#    "2 fields changed" / "3 elements changed" — tells you the click landed.
#    If it didn't, take a fresh snapshot — refs are stale after mutation.
```

**Why refs win over selectors.**

- Selectors break across page updates; refs are scoped to the snapshot you took.
- One snapshot drives N actions without re-querying the DOM.
- `get_attrs(ref, attrs)` and `extract(ref, fields)` work the same way — no
  separate `querySelector` for each attribute.

**When to use `get_page_text` instead.**

- The agent needs the actual prose content of an article (then `extractContent: true` + `format: "markdown"`).
- You're building a one-shot full-page dump for downstream LLM summarisation.
- The page has no useful accessibility tree (rare — JS-shell pages with no semantic markup).

**Refs are stale** after navigation, DOM mutation, or re-render. Take a fresh
snapshot. Errors on stale refs hint "Ref may be stale — take a fresh snapshot."

### Snapshot variants — diff and intent

- **`diff: true`** — returns only elements that changed since the last snapshot
  on this tab (a delta, not the full tree). Cheap way to see "what moved" after
  a click without re-reading the whole page. Filter and intent are not applied
  in diff mode — it shows the raw delta.
- **`intent`** — goal-scoped filter applied on top of the visibility/interactive
  filter. Pass `"login"`, `"search"`, `"read_content"`, `"fill_form"`,
  `"navigate"`, `"buy"`, or `"extract_data"` to narrow the tree to only
  elements relevant to that task (e.g. `"login"` keeps form fields + login text,
  drops navigation chrome).

### `page_state` — ultra-light check

`page_state()` returns `{url, title, scrollPercent, elementCount,
interactiveCount}` in ~48 tokens. Use it to check "did the page change?" after
a click before deciding whether to take a fresh snapshot. Much cheaper than a
full snapshot (5–20× fewer tokens).

## Tool Selection — Which Tool for What

| I want to...                          | Use                                                        | Not                          |
|---------------------------------------|------------------------------------------------------------|------------------------------|
| See page structure + element refs     | `snapshot()`                                               | `get_page_text` (no refs)    |
| Click a button / link                 | `click(ref: "eN")`                                         | `click(selector)`            |
| Fill a form field                     | `fill({ref, value})` or `fill([...])` for batches          | `type` + `select` (separate) |
| Press Enter / Escape / shortcut       | `press_key("Enter")` or `press_key("Control+A", ref)`      | `evaluate` key dispatch      |
| Read page content (prose)             | `get_page_text(extractContent: true, format: "markdown")`  | `evaluate` + regex           |
| Read article URLs from a list         | `get_links(ref: "e5")` or `get_links(selector: "main")`    | `get_page_text(matchAll)`    |
| Scrape structured list data           | `get_page_text(matchAll: true)`                            | `evaluate` + loop            |
| Get data-*, aria-*, src attrs         | `get_attrs(ref, attrs)`                                    | `evaluate`                   |
| Declarative structured extraction     | `extract(ref, fields)`                                     | `evaluate` with fragile JS   |
| Target an iframe element              | `snapshot(); click(ref, frame: "...")`                     | `evaluate` into iframe       |
| Handle alert/confirm/prompt           | `handle_dialog(action: "accept")` BEFORE the triggering action | page hangs                   |
| Upload a file                         | `upload_file(ref: "e7", files: ["/abs/path"])`             | `evaluate` + hidden input    |
| Inspect network traffic               | `get_network(urlPattern: "/api/")`                         | `evaluate` performance API   |
| Compute/filter/custom extract         | `evaluate(expression: "...")`                              | —                            |
| Drive a micro-task via LLM (optional) | `act(instruction: "...", maxSteps: 3)`                     | manual click/fill loop       |
| LLM structured extraction (optional)  | `extract_ai(instruction: "...", schema: "...")`            | hand-written JS              |
| Check "did the page change?" cheaply  | `page_state()`                                              | `snapshot` (5-20× more tokens) |
| Mock / block / simulate network       | `intercept(pattern: "**/api/*", action: "fulfill", body: "...")` | `evaluate` mockery        |
| Export network trace for analysis     | `export_har(owner: "agent:mine")`                           | `get_network` + hand-build    |
| Click at coordinates (canvas/WebGL)   | `click_at(x: 100, y: 200)`                                  | `click(selector)` on non-DOM  |
| Drag / hover (sequence)               | `mouse_move(x,y); mouse_down(); mouse_move(x2,y2); mouse_up()` | —                         |
| Numbered visual labels on screenshot  | `get_screenshot(annotate: true)` → marks array with number→ref/coord map | `snapshot` + visual matching |
| Vision-grounded LLM drive             | `act(instruction: "...", useVision: true)`                  | text-only act                |
| Batch-fetch URLs                      | `fetch_urls(urls: [...], mode: "auto")`                    | chaining new_tab + get_page_text |
| Debug page errors                     | `get_console(level: "error")`                              | `evaluate` console scan      |
| Check what page I'm on                | `list_tabs(tabId: N)`                                      | ~~get_current_url~~          |
| Clean up my tabs                      | `close_tabs(owner: "agent:mine")`                          | `stop_browser`               |
| Screenshot to file (default)          | `get_screenshot()` — defaults to file                      | was inline base64            |

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
Use `mode: "auto"` (default) for the TLS-impersonated fast path with browser
fallback, or `mode: "http"` to force the no-browser path. See "Path 1b" below.

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
snapshot(tabId: 3)                                     # refs for site-a
get_attrs(ref: "e5", attrs: ["data-price"], tabId: 3)
close_tabs(owner: "agent:A")

# Agent B (simultaneously)
create_profile(name: "b-session", url: "https://site-b.com")  → Tab 4
snapshot(tabId: 4)                                           # refs for site-b
click(ref: "e12", tabId: 4)
save_profile(name: "b-session")
delete_profile(name: "b-session")
```

Give `tabId` to select a page. In lane mode, `owner` is only a label.

## Concurrent agents and lanes

- Use the caller identity that the hub sends in `params._meta["ai.opencode/sessionID"]`.
- On `no_caller`, repair request metadata. Do not use an owner label as a replacement.
- Keep work in your lane's BrowserContext. The operator keeps Steel's default context and primary tab.
- Give `tabId` for each page when a task uses multiple tabs.
- Use `list_tabs` to find your lane's tabs and popups.
- On `not_in_lane`, select your own tab. Do not use `force` to bypass the error.
- Use `owner` only as a tab label or filter in your lane.
- Use parallel calls for different tabs. Calls on one tab run in order.
- Use `get_console({clear:true})` to clear only your lane's console buffer.
- Use `list_lanes` to see callers, ages, and tab counts. It does not give page URLs from other lanes.
- Use `close_lane` to close your context and all its tabs without a save.
- Use `stop_browser` only when no other lane is active. It closes only your lane.
- On `lane_closed`, discard the previous tab ID and call without `tabId` for a new lane.
- Read the closure NOTE line before the next step. It reports the reset of cookies, tabs, and buffers.
- Use the lane's idle lease, not an idle tab sweeper. The lease closes the lane after `LANE_IDLE_MS` (default 15 minutes).
- After an MCP restart, discard all previous in-memory lane state. Saved profile files stay on disk.
- On a `session-ended` NOTE line, use a new lane instead of previous tabs or browser storage.
- In legacy mode (`STEEL_LANES=off`), use owner labels and the tab sweeper. Do not stop the browser while other callers use it.

## Handle Dialog — Pre-Arm the Policy

Playwright dialogs (`alert` / `confirm` / `prompt`) **block the triggering
action until resolved**. The policy must be armed in advance — the dialog is
handled the instant it fires. Default policy is `dismiss`.

```
# Pre-arm BEFORE the action that triggers the dialog
handle_dialog(action: "accept", tabId: 7)
click(ref: "e12", tabId: 7)   # "Confirm deletion?" → auto-accept

# For prompt(), pass the response text
handle_dialog(action: "accept", promptText: "yes", tabId: 7)
click(ref: "e3", tabId: 7)    # prompt("Type 'yes' to confirm")

# One-shot — apply to the next dialog only, then revert to dismiss
handle_dialog(action: "accept", once: true, tabId: 7)

# Inspect what happened
handle_dialog(tabId: 7)
→ Dialog policy for tab 7: default (dismiss).
  Last dialog (3s ago): confirm "Are you sure?" — accept (auto-handled).
```

`handle_dialog` is per-tab — arm it on the `tabId` of the page that will fire
the dialog, not the calling agent.

## Frame Targeting — Reaching Into Iframes

`click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot` accept
`frame: "<name>" | "<url-substring>" | "<0-based index>"` to target an iframe.
Child frames exclude the main frame; the index is 0-based within the child list.

```
# 1. Enumerate frames (snapshot with no selector appends a frames section)
snapshot(tabId: 7)
→ ...
  --- frames ---
  [0] name="payment-iframe" url=https://embed.example.com/checkout
  [1] name=""             url=https://embed.example.com/3ds

# 2. Snapshot into the iframe to get refs for its elements
snapshot(frame: "payment-iframe", tabId: 7)
→ @e1 ... (refs scoped to the iframe DOM)

# 3. Act on iframe elements
fill(ref: "e3", value: "4111...", frame: "payment-iframe", tabId: 7)
click(ref: "e7", frame: "0", tabId: 7)   # by 0-based child index
```

Refs scoped to a frame stay valid for subsequent calls on that same frame, but
they do NOT survive a re-render — take a fresh `snapshot(frame: ...)` if the
iframe DOM mutates.

## Driving a Micro-Task via LLM (`act`, `extract_ai`)

Two optional tools require `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL` to be set on
the server (any OpenAI-compatible endpoint, e.g. ollama). Skip this section
if those tools aren't registered.

```
# Bounded micro-loop: 1-5 LLM-chosen actions over the current snapshot
act(instruction: "Sign in with email me@example.com and password from credentials 'myapp'", maxSteps: 5, tabId: 7)
→ step 1: click @e4  "Email"
  step 2: fill @e4   "me@example.com"
  step 3: click @e7  "Password"
  step 4: fill @e7   "***ret"
  step 5: click @e12 "Sign in"
  done: Dashboard heading appears.

# Structured extraction with an optional JSON Schema
extract_ai(instruction: "Extract product titles and prices", schema: "{\"type\":\"object\",\"properties\":{\"products\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"price\":{\"type\":\"number\"}}}}}}", tabId: 7)
→ {"products": [{"title": "...", "price": 12.50}, ...]}
```

- `act` runs the LLM step-by-step and stops at `done`, `stuck`, or `maxSteps`. Use it for short, well-bounded UI tasks where you can articulate the goal but the path isn't obvious.
- `useVision: true` sends a screenshot alongside the a11y snapshot each step, enabling the LLM to ground decisions on visual layout. Falls back to text-only if the configured model lacks vision support.
- `extract_ai` is one-shot — it reads the page once and returns structured data. Cheaper than `act` for pure extraction.
- The LLM has no memory across calls; pass enough context in `instruction`.
- `extract_ai` validates against the schema via Zod and performs one repair retry on parse / schema failure.

## Inspecting Network Traffic (`get_network`)

The browser captures a per-tab request/response ring buffer (default 500
events; configurable via `NETWORK_BUFFER_SIZE`). Use `get_network` to find
hidden API endpoints, debug SPA loads, or verify form submissions.

```
# Compact list of recent traffic
get_network(urlPattern: "/api/", resourceType: "xhr", tabId: 7)
→ 12 events (showing first 12)
  [3] GET    https://api.example.com/users      200    12ms  4.2KB
  [7] POST   https://api.example.com/login      200   240ms  0.6KB
  ...

# Fetch a single response body
get_network(body: true, requestId: 7, tabId: 7)
→ {"userId": 42, "token": "..."}

# Filter by status range
get_network(status: "5xx", tabId: 7)
```

`body: true` requires exactly one match (or pass `requestId` to fetch a
specific event). Body is capped at 10K chars and downgrades to file mode if
it exceeds `MAX_INLINE_BYTES`.

## Network Interception (`intercept`)

Mock API responses, block noisy third-party resources, or simulate errors
on a per-tab basis. All routes are tab-scoped + owner-isolated — no agent
can touch another owner's routes.

```
# Mock an API endpoint
intercept(pattern: "**/api/users", action: "fulfill", body: '{"name":"test"}', contentType: "application/json", tabId: 7)

# Block tracking pixels / analytics
intercept(pattern: "**/analytics/*", action: "abort", tabId: 7)

# Override request headers (e.g. auth token injection)
intercept(pattern: "**/api/**", action: "continue", headers: {"Authorization": "Bearer xyz"}, tabId: 7)

# List active routes
intercept(action: "list", tabId: 7)

# Remove routes
intercept(pattern: "**/api/users", action: "unroute", tabId: 7)  # remove one
intercept(action: "unroute", tabId: 7)                             # remove ALL on tab
```

Routes persist until the tab closes or `unroute` is called. Use `list` to
inspect what's armed.

## HAR Export (`export_har`)

Export captured browser network traffic as HAR 1.2 for performance analysis
or debugging. Always writes to disk (no inline option). Owner-scoped.

```
# Export all traffic from your tabs (by owner)
export_har(owner: "agent:my-job-42")
→ HAR exported: /tmp/steel-mcp/network.har (247 entries)

# Export a specific tab's events
export_har(tabId: 7, owner: "agent:my-job-42")
→ HAR exported: /tmp/steel-mcp/network.har (89 entries)
```

Requires `owner` or `tabId` — refuses an unscoped dump of all traffic.

## Coordinate-Based Interaction (`click_at`, `mouse_move`/`mouse_down`/`mouse_up`)

Vision/coordinate fallback for targets the accessibility tree cannot address:
canvas elements, WebGL renderers, custom-drawn widgets, coordinate-based games.

```
# Click a canvas button at known coordinates
click_at(x: 420, y: 310, tabId: 7)

# Drag-and-drop (e.g. slider, sortable list)
mouse_move(x: 100, y: 200, tabId: 7)
mouse_down(tabId: 7)                      # press left button
mouse_move(x: 300, y: 200, tabId: 7)      # drag to new position
mouse_up(tabId: 7)                        # release → drop
```

`click_at` supports `button: "right"|"middle"` and `clickCount: 2` for
double-click. Coordinates are viewport-absolute. Prefer `click(ref:)` when
the a11y tree covers the target — coordinate-based clicks are fragile across
viewport changes.

## Screenshot Annotation (`annotate`)

`get_screenshot(annotate: true)` overlays numbered labels on every interactive
element and returns a `marks` array mapping number → `{ref, x, y}`. Use it to
correlate visual position with actionable refs — especially useful on complex
UIs or when the accessibility tree structure is unclear.

```
get_screenshot(annotate: true, tabId: 7)
→ Screenshot saved to /tmp/steel-mcp/screenshot_....webp
  Marks: [
    {"number":1,"ref":"@e12","x":420,"y":310},
    {"number":2,"ref":"@e15","x":500,"y":310},
    ...
  ]

# Use the ref directly
click(ref: "@e12", tabId: 7)
# Or the coordinates
click_at(x: 420, y: 310, tabId: 7)
```

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

## Profiles and lane storage

Each caller lane has its own BrowserContext. A profile supplies saved cookies and localStorage to that context.
Different profile names in one lane do not isolate tabs. Profile leases are not available.

### When to use profiles

- Use a profile to keep approved login state across restarts.
- Use different caller lanes, not different profile names, when isolated browser storage is necessary.

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
→ Closes the profile's tabs. The lane context and saved state remain.
```

### Key rules

- **Tabs from profiles use the same global tabId space.** All existing tools
  work unchanged — just pass the tabId returned by `create_profile`.
- Save the profile before `close_lane` when the task must keep login state.
- Use `new_tab({profile})` to load a saved profile into the lane's context.
- Use profile files as shared files. Profile leases are different work.
- In legacy mode, each active profile uses a different BrowserContext.
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

- Use `captcha_status` to check balance and availability before CAPTCHA-heavy work.
- Let `go_to_url`, `click`, `fill`, `press_key` and `act` wait for detected CAPTCHAs. These tools use extension signals, widget fields and bot-wall checks. The default wait is 90 s. `CAPTCHA_WAIT_TOTAL_MS` on the MCP process changes it.
- Read the CAPTCHA result line before the next action. A page without a detected CAPTCHA has no added wait. A detected CAPTCHA returns solved, an extension error, or a timeout with the next steps.
- Do not add sleep or retry loops for CAPTCHAs. The automatic wait does not create another paid REST task.
- After a failure, call `solve_captcha({ tabId, owner, timeoutMs: 90000 })` for an explicit API attempt when permitted. Give `frame` when the widget is inside a specific frame.
- Configure `CAPSOLVER_API_KEY` on the MCP process for the direct API path. A key in the browser container alone does not configure that path. Do not retrieve or print the key.
- Expect `solve_captcha` to reuse an existing token or wait for an active extension solve first. Its timeout covers the extension wait and API polling together. If the extension wait times out, the tool does not create another task.
- Use the direct API path for reCAPTCHA v2/v3 and Turnstile only. Use the extension or human handoff for hCaptcha, other unsupported types, or a missing site key.
- Read the returned type, public site key, seconds, injection status and error. Do not request the token. Success does not prove the site accepted the token. Check with `snapshot` or `wait_for`.
- Do not call `solve_captcha` in parallel with actions on the same tab. The extension can start after the API check and cause a second charge. ProxyLess tokens can fail when the site binds a token to an IP.
- Use the Interactive URL from `start_browser` when the solver fails or human input is necessary.

## Stealth & Fingerprint

The MCP drives the browser through **Patchright** — a stealth-hardened Playwright
fork that drops the `Runtime.enable` CDP fingerprint that vanilla Playwright
leaks. All standard Playwright page APIs work unchanged.

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

Any UA-vs-navigator.platform mismatch (e.g. UA claiming macOS on a Linux host) is
a Steel-side config issue — our custom Steel fork adds stealth code mods to the
stock image and loads the CapSolver plugin, so anti-bot evasion + CAPTCHA solving
are handled inside the container. The MCP's `captcha_status`/`go_to_url`
integration adds the balance check + wait-and-retry loop. In LOCAL mode the MCP
launches Chromium via Patchright and prefers `channel:"chrome"` (system Chrome)
when available for stealth.

## Calling Routes

Two ways this MCP is reached. Escaping rules differ.

1. **Code Mode** (opencode). Call `tools["steel"].<tool>({ ... })` with native objects. Do not apply shell escaping.
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

Follow [CAPTCHA Solving](#captcha-solving) for the automatic wait, explicit API
fallback and human handoff. Read the result line instead of starting a retry loop.

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
  maxCharsPerPage: 3000,
  mode: "auto"
)
```

Returns one result per URL. Faster than chaining `new_tab` + `get_page_text` per URL.

**Modes:**

- `"auto"` (default) — try `impit` (TLS-impersonated HTTP, no browser) first; escalate to a real browser tab when the HTTP result looks like an SPA shell or anti-bot challenge. Each result carries a `[http]` or `[browser]` label; `auto` results also include an `escalated: true|false` flag in `structuredContent`.
- `"http"` — force the fast path. Skips the browser entirely. Misses JS-rendered content; use for static pages, RSS, or well-known APIs.
- `"browser"` — force a real browser tab per URL. Always works, slowest. Use when you specifically need JS-rendered content or anti-bot bypasses.

A tiny `maxCharsPerPage` doesn't trigger auto-escalation — the cap is applied
before the SPA-shell heuristic.

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

- Follow [CAPTCHA Solving](#captcha-solving) for bot walls after navigation or actions.
- Read the automatic wait result before another operation. Use `solve_captcha` for an explicit API attempt, or `start_browser` for human handoff.

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

**Small (1-2 fields):** `fill` + `click` is fine. Prefer refs from a fresh `snapshot`.
```
fill({ref: "e4", value: "user@example.com", tabId: 7})
fill({ref: "e7", value: "secret", tabId: 7})
click(ref: "e12", tabId: 7)
wait_for(text: "Dashboard", tabId: 7)
list_tabs(tabId: 7)   # confirm landing, not error
```

**Many fields (sign-up / checkout / multi-input):** `fill` with a `fields[]` array in one call.
Auto-detects each field's type and dispatches correctly:
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
    {ref: "e4",  value: "user@example.com"},
    {ref: "e7",  value: "secret"},
    {ref: "e10", value: "yes"},          # checkbox truthy → check
    {ref: "e12", value: "cheese"},       # checkbox group → check the cheese option
    {ref: "e13", value: "bacon"},        # same group → also check bacon
    {ref: "e16", value: "pro"},          # radio group
    {ref: "e19", value: "za"},           # select by value
    {ref: "e22", value: "Medium", kind: "selectLabel"},
    {ref: "e25", value: "1990-04-18"},   # date input
  ],
  submitSelector: "button[type=submit]",
  tabId: 7
)
wait_for(text: "Welcome", tabId: 7)
```

`fill` replaces N separate tool calls with one. Pass `skipMissing: true` if some fields are conditionally rendered. Mix `ref` and `selector` per field; force a specific dispatch per field with `kind: "text"|"check"|"radio"|"select"|"selectLabel"|"selectIndex"`.

## Human-in-the-Loop (HITL)

For a failed CAPTCHA solve, 2FA, or a login that needs human input, hand off:

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

`cookies` operates on the caller's lane context. Cookies stay until expiry or lane closure.

**Output cap**: without `limit`, `cookies` returns at most 50 cookies
and appends a `[CAPPED — N total]` footer. Set `limit: 0` for all cookies.
Use `domain` or `urls` to limit output from a lane with many cookies.

**urls filter fallback**: if Playwright's exact-match URL filter returns
nothing (happens with some Set-Cookie redirect chains), the tool automatically
falls back to a host-contains match across all cookies. Usually invisible —
surfaces in the result the same way a clean match would.

## Multi-Tab Workflows

Tabs have different URLs and DOMs, but all tabs in one lane share browser storage.
Give `tabId` to select a tab in a workflow with multiple tabs.

```
a = new_tab(url: "https://site-a.com", owner: "agent:my-job-42")  # → Tab 7
b = new_tab(url: "https://site-b.com", owner: "agent:my-job-42")  # → Tab 8

# Snapshot each tab; refs are scoped to that tab's snapshot
snapshot(tabId: 7, owner: "agent:my-job-42")
→ ... refs e1..eN ...

snapshot(tabId: 8, owner: "agent:my-job-42")
→ ... refs e1..eN ...

# Drive both tabs in parallel without races
click(ref: "e4", tabId: 7, owner: "agent:my-job-42")
click(ref: "e3", tabId: 8, owner: "agent:my-job-42")

close_tabs(owner: "agent:my-job-42")                      # clean up both
```

Rules:
- Give `tabId` to select the correct page. Use `owner` only as an optional label in the lane.
- `new_tab` uses real CDP context; visible in session viewer.
- Never `browser.newPage()` / `browser.newContext()` directly — phantom
  contexts. Always use MCP tools.
- Use `close_tabs` for selected tabs or `close_lane` for complete lane cleanup.

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
- 1 `go_to_url` (with `readPage: true` to combine nav + extract, OR `snapshot` for ref-driven)
- 1 `snapshot` if you're going to act on the page (refs drive `click`/`fill`/`scroll` without re-querying)
- 1 `get_page_text` with `matchAll` (list extraction, if not using readPage or refs)
- 1 `list_tabs` (verify, optional)

≈ 3–5 calls total per page with `readPage` (or one `snapshot` + N action calls
fed by refs). If you exceed 8 without new info, stop + probe with the selector
diagnostic — don't iterate blind.
