# Steel MCP Server (Custom Fork)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents direct control of a browser via [Steel](https://steel.dev) and [Patchright](https://github.com/steel-dev/patchright) (a stealth-hardened Playwright fork). No internal LLM required — the calling agent provides all reasoning.

Fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server), customised for self-hosted Steel with enhanced stealth, CAPTCHA solving, credential management, profile isolation, and a browser extension for session sharing.

---

## Features

- **48 browser tools** (50 with AI tools) in lane mode. Each caller has different tabs and browser storage. `STEEL_LANES=off` uses the legacy tool set.
- **Patchright browser engine** — drops the `Runtime.enable` CDP fingerprint that vanilla Playwright leaks; native binary stays compatible with all standard Playwright page APIs
- **Snapshot-first paradigm** — `snapshot` returns an accessibility tree with stable `[ref=eN]` tokens; refs feed `click`/`fill`/`scroll`/`get_attrs`/`extract`/`press_key` directly without re-discovering selectors
- **MCP 2025 best practices** — `server.registerTool` with `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` annotations and `outputSchema` → `structuredContent` on JSON tools
- **Toolset filtering**: select `core`, `tabs`, `extract`, `media`, `network`, `auth`, `debug`, `ai`, or `intercept` through `--toolsets` or `TOOLSETS`. The server always includes `core`.
- **Agent lanes**: one BrowserContext for each calling session, with different current tabs, console buffers, network buffers, and idle leases. Each tab has a call queue.
- **Iframe targeting** — `click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot` accept `frame: "<name>" | "<url-substring>" | "<index>"` to reach into child frames
- **TLS-impersonated batch fetch** — `fetch_urls(mode: "auto"|"http"|"browser")` uses `impit` for fast HTTP first, auto-escalates to a real browser tab when the response looks like an SPA shell
- **Profiles**: one lane holds a named profile lease at a time. Saved cookies and localStorage load into that lane.
- **Credentials** — encrypted credential store (AES-256-GCM) with auto-fill support
- **Cookie Push Extension** — Chrome/Vivaldi extension pushes real browser sessions to Steel profiles via HTTP relay
- **CAPTCHA solving**: navigation and action tools wait a maximum of 90 s for CAPTCHA widgets or bot walls. Use `solve_captcha` for the REST API fallback (reCAPTCHA v2/v3 and Turnstile).
- **Dialog pre-arming** — `handle_dialog` sets an accept/dismiss policy for a tab before an action that triggers alert/confirm/prompt
- **Network inspection** — `get_network` exposes the request/response ring buffer; per-tab `pageerror` capture
- **Stealth fingerprint** — unified navigator/WebGL/canvas/audio/Intl spoofing across JS and HTTP
- **Bot-check detection** — `go_to_url` returns `isError` on Cloudflare/WAF walls
- **Error loop detection** — `ErrorTracker` warns when the same URL or domain repeatedly returns errors
- **Readability extraction** — `get_page_text(extractContent: true)` strips nav/ads and returns article body; `format: "markdown"` converts via turndown
- **Declarative extraction** — `extract(selector, fields)` maps CSS selectors to a field schema and returns structured JSON
- **Image resize/compress** — `get_screenshot` post-capture resize/compress via `@napi-rs/image`; new `maxWidth`/`maxHeight`/`maxFileBytes` params
- **Context budget aware** — `outputMode: "file"`, per-entry caps, auto-downgrade on large output
- **List-page scraping** — `get_page_text(matchAll: true)` for structured extraction in one call
- **Self-hosted Steel** — connect via `STEEL_BASE_URL`; no API key needed for local installs
- **Human-in-the-loop** — interactive URL for CAPTCHAs, 2FA, sensitive logins
- **LLM micro-loops (optional)** — `act` (1–5 LLM-chosen actions over a snapshot) and `extract_ai` (LLM structured extraction with optional JSON Schema) gated on `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL`

---

## Quick Start

### Prerequisites

- [bun](https://bun.sh) 1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- [Steel Browser](https://github.com/steel-dev/steel-browser) running (self-hosted or Steel Cloud)
- Node.js 20+ for the built artifact. Patchright requires this runtime version.
- `/usr/bin/chromium` for the local headless WebSocket and iframe regression tests on Linux.

### Build

```bash
git clone <this-repo>
cd steel-mcp-server-custom
bun install
bun run build          # → dist/index.cjs
STEEL_LANES=off bun test # legacy suite plus explicit lane-mode tests
```

### Run

```bash
# Self-hosted Steel (most common)
BROWSER_MODE=steel STEEL_BASE_URL=http://your-steel-host:3000 node dist/index.cjs

# Steel Cloud (API key required)
BROWSER_MODE=steel STEEL_API_KEY=your_key node dist/index.cjs

# Local Chromium (no Steel, no stealth/CAPTCHA)
BROWSER_MODE=local node dist/index.cjs

# Trim the tool surface for a smaller context budget
node dist/index.cjs --toolsets core,extract,media
```

---

## Environment Variables

All variables are validated at startup via Zod (`src/env.ts`). Invalid values cause a descriptive error.

| Variable | Default | Description |
|---|---|---|
| `BROWSER_MODE` | `"steel"` | `"steel"` for Steel; `"local"` for plain Chromium |
| `STEEL_API_KEY` | — | Required for Steel Cloud (when `STEEL_BASE_URL` is not set) |
| `STEEL_BASE_URL` | Steel Cloud | Self-hosted Steel URL (e.g. `http://your-steel-host:3000`) |
| `STEEL_LANES` | `on` | Isolated caller lanes. Set `off` for the legacy shared context, owner guard, and `force` override. |
| `LANE_IDLE_MS` | `900000` | Close an idle lane after 15 minutes. Active calls keep the lane open. |
| `LANE_DRAIN_MS` | `5000` | Maximum drain time in ms before context closure. |
| `LANE_MAX` | `8` | Maximum number of open or pending lanes. |
| `STEEL_NTFY_TOPIC_FILE` | unset | Path to the `0600` file with the operator's ntfy topic. Unset means no push. |
| `STEEL_PUBLIC_URL` | — | Public-facing Steel URL for debug/interactive URLs in `start_browser` output |
| `SESSION_TIMEOUT_MS` | `300000` | Steel session auto-release timeout (ms) |
| `SETTLE_TIMEOUT_MS` | `5000` | Max time to wait for network idle + DOM quiet after actions. `0` disables |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool |
| `OPTIMIZE_BANDWIDTH` | `false` | Block images/fonts/CSS for text-only scraping |
| `STEEL_HIDDEN_TEXT` | `drop` | Hidden-text policy for `snapshot`, `get_page_text`, and `extract`: `drop`, `flag`, or `off` |
| `MAX_INLINE_BYTES` | `512000` | Auto-downgrade to file mode above this size |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file outputs, profiles, credentials |
| `PROFILES_DIR` | `$OUTPUT_DIR/profiles` | Profile state persistence directory |
| `CREDENTIALS_FILE` | `$OUTPUT_DIR/credentials.json` | Credential store path |
| `CREDENTIALS_PASSPHRASE` | — | Encrypts credentials and profile files (AES-256-GCM). Plain JSON if unset |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default webp/jpeg quality (1–100) |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Viewport height in px |
| `TAB_IDLE_TIMEOUT_MS` | `300000` | Legacy mode only: close idle tabs after this long. `0` disables. |
| `TAB_IDLE_SWEEP_INTERVAL_MS` | `60000` | Sweeper check interval |
| `NETWORK_BUFFER_SIZE` | `500` | Max request/response events kept for `get_network`. `0` disables capture |
| `RELAY_PORT` | `3001` | HTTP relay port for Cookie Push extension. `0` disables |
| `RELAY_BIND_ADDR` | `127.0.0.1` | Address the relay HTTP server binds to. Use `0.0.0.0` only behind a reverse proxy/firewall |
| `RELAY_SECRET` | — | Shared secret for relay auth (Bearer token). Required when relay enabled |
| `RELAY_PUBLIC_URL` | — | Public relay URL shown in `start_browser` (e.g. `http://your-host:3001`) |
| `TOOLSETS` | all | Comma-separated toolsets: `core,tabs,extract,media,network,auth,debug,ai,intercept`. The `--toolsets` flag takes precedence. |
| `ACT_LLM_BASE_URL` | — | OpenAI-compatible endpoint for `act` / `extract_ai`. Required to enable those tools |
| `ACT_LLM_MODEL` | — | Model name sent to the LLM endpoint. Required to enable `act` / `extract_ai` |
| `ACT_LLM_API_KEY` | — | Optional API key for the LLM endpoint. Unset = no `Authorization` header (ollama-style) |

---

## Agent lanes

`STEEL_LANES=on` is the default. The hub must send `params._meta["ai.opencode/sessionID"]` on each `tools/call`.
The SDK supplies this value as `extra._meta` to the tool handler. Tool arguments cannot select a different caller.
A stateful call without this value gives `no_caller` with a hint.
`list_profiles`, `credentials`, and `captcha_status` operate without a lane.
Credential writes and deletes still require caller metadata. Each successful request records only its operation and caller on stderr.
`list_profiles` shows active tab counts only for the caller. Anonymous calls show the saved catalogue without active usage.

The first browser call opens a new BrowserContext for its caller. The default context and Steel's primary tab stay with the operator.
Agents cannot address the operator's tabs. A popup stays in the lane of its context.

Tab IDs are global numbers, but a caller can address only its own lane's tabs.
A tab from a different active lane gives `not_in_lane`. A closed or unknown tab ID gives `lane_closed`, also after an MCP restart.

Each lane has its own current-tab pointer and console and network buffers.
`get_console({clear:true})` clears only the caller's buffer.
Calls on one tab run in order. Calls on different tabs and lanes can run in parallel.
An omitted tab ID selects the current tab before the queue waits.

Two tools are available only in lane mode:

- `list_lanes`: show each active lane's caller, age in seconds, and tab count. It does not give page URLs.
- `close_lane`: close the caller's tabs and context. It does not stop the shared Steel session.

With other active lanes, `stop_browser` refuses the call. With no other active lanes, it closes only the caller's lane.

`owner` is an optional tab label, not an access check. `force` is accepted but ignored, with a NOTE line.

`use_profile({name, wait?, autosave?})` gets a profile lease and loads cookies and localStorage for all saved origins.
`new_tab({profile})` gets the same lease. All tabs in that lane share storage.
A different lane gets `profile_busy` with the holder's lane label and `ageSeconds`, not its session ID.

One lane context can hold only one named profile. A different name gives `lane_profile_conflict` with the held profile name.
Use `close_lane` or a different lane to change profiles. After `delete_profile`, the live context keeps its profile binding.

Use `wait` for at most 120 seconds. A wait does not hold the profile write queue.
Use `save_profile` with a held lease. Close and idle release it without a save unless `autosave` is `true`.
A browser disconnect releases all leases. Autosave cannot read a closed browser context.

`list_profiles` shows the holder and lease age in its text result. Leases stay only in this process.
`delete_profile` closes tagged tabs, not the lane's live context. Its cookies, storage, and lease stay until lane closure.
When `delete_profile` gives no error, autosave is off for that lease. Closure does not make a deleted file again.

### Profile encryption and rollback

Encryption is off unless the operator sets `CREDENTIALS_PASSPHRASE`.
With a passphrase, all profile writes use AES-256-GCM and scrypt through `src/crypto.ts`.

The first read of a plaintext file writes an encrypted temporary file with mode `0600`.
The server decrypts that file and compares its contents before the atomic replacement.
If the decrypted contents do not agree, the server keeps the plaintext and logs only the profile name.
An incorrect passphrase stops the read without a write. Use the same passphrase to read an encrypted file.

For rollback, stop the MCP server and the relay before these commands.
Keep `PROFILES_DIR` and the same `CREDENTIALS_PASSPHRASE` in the command environment.
Do not put a passphrase in a command line or in this repository.

```sh
bun run decrypt-profiles --dry-run
bun run decrypt-profiles
# For the built Node package:
node dist/decrypt-profiles.mjs --dry-run
node dist/decrypt-profiles.mjs
```

The command checks each profile before the first write. It refuses symlinks and invalid names.

Rollback requires Linux with accessible procfs at `/proc/self/fd`.
The command holds the directory descriptor and opens files with `O_NOFOLLOW`, so pathname changes cannot redirect file access.

The dry run does not change files. Without `--dry-run`, the command writes plaintext with mode `0600`.
After rollback, remove `CREDENTIALS_PASSPHRASE` before the server starts, or the next read encrypts the files again.

Autosave has the same time limit as `LANE_DRAIN_MS`.
If a page prevents the save, closure gives `autosave_timeout` and releases the lease.
The last saved file stays available. Save before closure when the task must keep a checked snapshot.

The idle lease closes a lane after `LANE_IDLE_MS`. It does not close individual idle tabs.
The lease defaults to 15 minutes. A new call resets its activity clock.
A running call can expire only after at least that interval since its admission.
Lane closure waits up to `LANE_DRAIN_MS` (default 5000 ms) for admitted calls, then closes the context to interrupt pending browser work.
Signal shutdown has a final exit deadline of the drain grace plus 1500 ms.
Lane closure does not save cookies. The next call without `tabId` opens a new lane and reports the previous closure in a NOTE line.
Closure details stay for at most 24 hours and 1000 callers. Without those details, the call gets a plain new-lane NOTE.

`LANE_MAX` limits active and opening lanes to 8 by default.
At capacity, a new caller gets `lanes_full`. Use `list_lanes` to inspect usage and `close_lane` to close your lane.
Existing lanes still work at capacity.

Tab IDs start at a cryptographically random process offset and increase within the process.
Restart alias resistance is probabilistic. The allocator does not use process-relative clock time as a restart identity.

Previous tab IDs stay invalid. An MCP restart clears in-memory lanes, tabs, queues, and buffers.
The hub must keep the child alive during idle periods (`servers.steel.idleSeconds: 0`).
Before release, check caller metadata on the live host for direct, Code Mode, and child-session calls.

If the shared browser disconnects, all lanes close. The NOTE line shows `session-ended`.
Calls with previous tab IDs return `lane_closed`. Calls without a tab ID open new lanes and report the session end.
Concurrent calls share one new browser startup. `SESSION_TIMEOUT_MS` stays unchanged and can end the shared Steel session before a lane's idle lease.

Set `STEEL_LANES=off` to restore the legacy shared context, owner-based targeting, `force` override, tab sweeper, and whole-browser stop.
Restart the MCP process to change this switch. The restart does not keep lanes from the previous process.

## Tools (45 default, 47 with AI tools, legacy mode)

This table lists the legacy tool set, which lane mode also includes. The lane rules above replace its shared-state behavior.

All page-interacting tools accept an optional `tabId`. Omit for current-active-tab; pass it for concurrent-agent safety. `click`, `fill`, `scroll`, `wait_for`, `get_attrs`, `extract`, `press_key`, and `upload_file` also accept `ref: "eN"` from `snapshot` in place of a CSS `selector`. `click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot` accept `frame` to target an iframe by name, URL substring, or 0-based child index.

| Tool | Description |
|---|---|
| **Navigation** | |
| `go_to_url` | Navigate + optional `waitFor`. `readPage` extracts content in the same call. `disableMedia` blocks images/fonts/CSS. Waits up to 90 s for detected CAPTCHAs. Detects bot walls + error loops |
| `history` | Back, forward, or reload |
| `scroll` | Scroll up/down by `selector`/`ref`. `readAfterScroll` returns visible text in same call |
| `wait_for` | Wait for selector, text appear, text disappear. Accepts `ref` |
| `press_key` | Press a key or combo (`Enter`, `Escape`, `Control+A`, `Shift+Tab`, …). Optional `selector`/`ref` to focus first |
| **Tabs** | |
| `list_tabs` | List tabs (filter by tabId, owner, profile) with `idleSeconds` |
| `new_tab` | Open tab with optional URL, owner, profile |
| `close_tabs` | Close by tabId, owner, or both |
| **Extraction** | |
| `snapshot` | Accessibility tree with `[ref=eN]` tokens. The preferred first look — refs feed interaction tools directly. Default maxChars: 8K |
| `page_state` | Return the URL, title, scroll position, and element counts without a full snapshot. |
| `get_page_text` | Text extraction with smart content area fallback. `extractContent` for Readability article extraction. `format: "markdown"` via turndown. `matchAll` for list scraping. Default maxChars: 5K |
| `get_links` | Extract `[{text, href}]` with optional `urlPattern` filter. Accepts `ref` |
| `get_attrs` | Extract specific attributes from matched elements (by `selector` or `ref`) |
| `get_screenshot` | Screenshot (webp/jpeg/png, selector/clip/fullPage). Default `outputMode: "file"`. Post-capture resize/compress via `@napi-rs/image` (`maxWidth`, `maxHeight`, `maxFileBytes`) |
| `evaluate` | Run JS in page context, return JSON. `maxChars` cap (default 10K). `outputMode: "file"` for large output. `frame` targets an iframe |
| `get_console` | Browser console messages (filter by level) |
| `fetch_urls` | Batch-fetch 1–10 URLs in parallel. `mode: "auto"|"browser"|"http"` (impit TLS-impersonated fast-path with auto-escalation) |
| `extract` | Declarative structured extraction: CSS selector + field map → JSON. Accepts `ref` |
| **Interaction** | |
| `click` | Click by `selector` or `ref`. Optional `waitFor`/`waitForText`. `frame` targets an iframe. Reports navigation + snapshot-diff feedback |
| `click_at` | Click viewport coordinates. Supports mouse buttons and multiple clicks. |
| `mouse_move` | Move the mouse to viewport coordinates. |
| `mouse_down` | Press a mouse button at the current position. |
| `mouse_up` | Release a mouse button at the current position. |
| `fill` | Fill form fields by `selector` or `ref`. Auto-detects text/select/checkbox/radio. `frame` targets an iframe |
| `upload_file` | Upload files via `<input type=file>` or a custom upload button (`viaChooser: true`). Absolute host paths only |
| `handle_dialog` | Pre-arm the dialog policy (`accept`/`dismiss`, optional `promptText`) before an action that triggers alert/confirm/prompt |
| `download_file` | Download URL to disk (handles attachments + inline binaries) |
| **Network** | |
| `cookies` | Get or set browser cookies |
| `get_network` | Inspect request/response traffic (filter by urlPattern/resourceType/status). `body: true` or `requestId` fetches a single response body |
| `export_har` | Export lane network events as HAR 1.2. In legacy mode, give an owner or tab ID. |
| `intercept` | List, fulfill, abort, continue, or remove per-tab request routes in the caller's lane. |
| **Sessions & Auth** | |
| `request_signin` | Request operator approval for one site and `profile`. Optional `wait` is seconds, at most 120. |
| `signin_status` | Read your request status and counts, not state values. |
| `cancel_signin` | Cancel your pending request. Saved state stays unchanged. |
| `create_profile` | Load a named profile in the lane. Legacy mode uses a different BrowserContext. |
| `list_profiles` | Active + saved profiles |
| `save_profile` | Persist cookies + localStorage to disk |
| `delete_profile` | Close the profile's tabs. Legacy mode also closes the profile context. |
| `credentials` | List/store/update/delete credentials |
| `use_credential` | Retrieve or auto-fill login form |
| **System** | |
| `captcha_status` | CapSolver balance + extension status |
| `solve_captcha` | Wait for an active extension solve, or solve reCAPTCHA v2/v3 and Turnstile through the REST API. Accepts `tabId`, `owner`, `frame`, `timeoutMs`. Returns type, public site key, seconds, injection status and errors, never the token |
| `smoke_test` | Self-test: navigate, fingerprint, stealth, CapSolver checks. Headless-detection probe (sannysoft) |
| `start_browser` | Start browser, get Session Viewer + Interactive + Relay URLs |
| `stop_browser` | Close the caller's lane if no other lane is active. Legacy mode stops the shared browser. |
| **AI (optional — requires `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL`)** | |
| `act` | LLM-driven bounded micro-loop over a snapshot (1–5 actions) |
| `extract_ai` | LLM structured extraction from the current page (text or html, optional JSON Schema) |

The unit suite compares this inventory with the actual MCP `tools/list`, with both AI tools enabled.

### CAPTCHA waits and explicit fallback

`go_to_url`, `click`, `fill`, `press_key` and `act` detect CAPTCHA widgets,
extension signals and bot walls. They wait for a token, a solved signal, an
extension error, or a timeout. The default timeout is 90 s. Set the MCP process
variable `CAPTCHA_WAIT_TOTAL_MS` to change it. Pages without a detected CAPTCHA
have no added wait. These waits do not create paid REST tasks.

Use `captcha_status` before CAPTCHA-heavy work. Read the result line before
the next operation: `CAPTCHA reCAPTCHA v2 solved in 31 s`, or a failure with
`solve_captcha` and `start_browser` guidance. Do not add sleep or retry loops.

After a failure, call `solve_captcha({tabId, owner, timeoutMs: 90000})` for an
explicit API task. The MCP process must have `CAPSOLVER_API_KEY` for this path.
An extension key in the browser container is not sufficient. The tool first
reuses an existing token or waits for an extension that is already solving.
The timeout includes this wait and all API polling. hCaptcha and other types
are unsupported by the direct API path. Use the extension or the Interactive
URL from `start_browser` for those types, or when the site key is unavailable.

The API path uses ProxyLess tasks. A site can reject a token bound to another
IP. An extension can start a task after the API check and cause a second charge.
Do not call `solve_captcha` in parallel with other actions on the same tab.
Success means a token was injected or the extension reported success, not that
the site accepted the form. Check the page with `snapshot` or `wait_for`.

### Focused reads and continuation

Use `query` on `snapshot` or `get_page_text` to find lines with case-insensitive literal text.
Snapshot results keep their element refs, including frame-qualified refs such as `@f2e3`.
Use `paginate: true` without a query to read a long capture in chunks.
The structured result contains `text`, `totalChars`, and an optional `nextCursor`.
Give that token as `cursor` with the same targeting and query arguments.

Continuation reads the stored capture, not the changing page. Get a fresh snapshot before an interaction if the page changed.
Tokens expire after five minutes. The cache holds at most 32 tokens and rejects captures larger than 1,000,000 characters.
Paginated `maxChars` must be from 1 to 64,000. Continuation is not available with snapshot diffs or text list/file modes.

All MCP text blocks have an untrusted-content fence. Page text cannot close this fence with a forged delimiter.
Text and serialized structured data share a 512,000-byte UTF-8 budget, including fences and truncation notices.

Per-tool `maxChars` controls the payload before this envelope. Page-controlled string values in structured results have the same fence. Enum values, cursors, file paths, and server metadata stay unchanged.

JSON property names stay unchanged. This also applies to page-controlled keys from `evaluate`. Read these keys as untrusted data too.

`STEEL_HIDDEN_TEXT=drop` removes non-rendered text from a detached copy during content reads. The guard checks CSS display, visibility, opacity, text size and colour, element geometry, and full-clip shapes. It keeps `aria-hidden` text, standard clipped screen-reader text, and content in scroll containers. It does not change the live DOM, screenshots, or interaction targets.

In snapshots, a hidden string stays unchanged if a person can also see that string. Thus, button names and hyperlink names stay unchanged. The hidden copy adds no new text in this case.

`flag` keeps hidden text with `[hidden]` markers. `off` uses the previous text collection path. The Unicode control strip and trust fences stay active for these modes. The strip removes dangerous Unicode controls in all modes.

Guarded results include `hidden: <count>` in their text. The count includes page-wide text, comment, hidden-label, and control-bearing text entries, not only the selected subtree. A structured `text` field also contains the count when that field is available. The guard does not add schema fields to list results.

Complex CSS masks, image backgrounds, shadow trees, and page changes between capture and inspection can evade these checks. The guard does not replace the trust fence.

These features adapt the focused-read, pagination, and provenance-fence methods from upstream v2.0.1 under the existing MIT license.

### MCP result contracts

All 43 tools declare the four safety hints. Hints cover every mode, not only the default mode.
File output, log clearing, cookie replacement, and arbitrary page interaction do not advertise read-only behavior.
Browser interactions use conservative destructive hints because page handlers can submit or delete data.
These hints do not replace authorization checks.

The 18 JSON-producing tools publish output schemas and structured results.
`evaluate` and `extract_ai` place arbitrary JSON under `result`.
File results contain `filePath`, not a second inline copy of large data.
Oversized structured results return an error instead of bypassing the output budget.
The interception regression uses a strict SDK client for success, empty, and error cases.

---

## Cookie Push Extension

A Manifest V3 extension sends selected site cookies and localStorage to saved Steel profiles. The popup shows domains and counts, not sign-in values. See [extension instructions](extension/README.md) for permissions, batch pushes, pinned sync, and limits.

### Agent sign-in requests

The three sign-in tools use one process store with the HTTP server.
With `STEEL_LANES=on`, caller metadata is necessary, but a sign-in request does not open a browser lane.
The caller comes from `params._meta["ai.opencode/sessionID"]`. A missing caller gets `no_caller`.
The tools report `signin_unknown` for a request ID from a different caller.

With `STEEL_LANES=off`, all sign-in calls use the same caller `single-process` and ignore supplied caller metadata.
This mode is for one agent. It does not isolate sign-in requests between agents.

Select `Approve` in the extension Review page. An approved push saves state before live apply.
Only contexts that hold the requested `profile` get the live update.
With no such context, the HTTP server reports `liveApplied=false`. The next `new_tab({profile, url})` loads the saved state.
Manual `/push` does not apply state to live contexts.

On SIGINT or SIGTERM, pending requests become `cancelled`, waiting tools get that status, and the store writes state before exit.
The HTTP server closes its connections in the same shutdown interval.

### Setup

1. **Install the extension** — Go to `chrome://extensions` (or `vivaldi://extensions`), enable Developer Mode, click "Load unpacked", select the `extension/` directory.

2. **Configure the relay** — Set `RELAY_PORT` and `RELAY_SECRET` env vars on the MCP server. The relay starts automatically alongside the stdio transport.

3. **Configure the extension**: Open Settings from the popup. Set the relay URL and shared secret, save settings, grant relay access, then select Test connection. Use HTTPS for remote relays. Use HTTP for loopback connections only.

### Usage

1. Open a site and sign in, then open the extension popup.
2. Grant access to that site if prompted. Check its cookie and storage-key counts.
3. Select an existing profile or set a new profile name.
4. Select **Push this site** and check the per-site results.
5. In lane mode, use `use_profile({name: "github"})` with the selected profile name. The call loads cookies and localStorage for all saved origins. In compatibility mode, use `create_profile({name: "github", url: "https://github.com"})`.

Push merges cookies and storage keys into saved state and applies them to the lane with the profile lease.
It does not remove stale data. Use the saved profile contents panel to remove a domain before a clean replacement.
The relay accepts credentials from older clients. The extension UI does not accept manual credentials.

### Relay API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /status` | No | Health check |
| `POST /push` | Bearer token | Receive cookies/localStorage/credentials → profile |
| `GET /profiles` | Bearer token | List saved profile names, domains, and counts |
| `GET /profiles/:name` | Bearer token | Show saved domains and counts without values |
| `DELETE /profiles/:name/domains/:domain` | Bearer token | Remove one exact domain from saved cookies and localStorage |

Domain removal ignores the first cookie dot and hostname case. Subdomains, active contexts, and the global credential store stay unchanged. The original `GET /status` and `POST /push` stay compatible with extension 1.0.0.

---

## Client Configuration

### mcporter

```json
"steel": {
  "command": "node",
  "args": ["/path/to/dist/index.cjs"],
  "lifecycle": { "mode": "keep-alive" },
  "env": {
    "BROWSER_MODE": "steel",
    "STEEL_BASE_URL": "http://your-steel-host:3000",
    "STEEL_PUBLIC_URL": "https://your-public-steel-url",
    "CREDENTIALS_PASSPHRASE": "your-passphrase",
    "RELAY_SECRET": "your-relay-secret",
    "SESSION_TIMEOUT_MS": "300000",
    "GLOBAL_WAIT_SECONDS": "2",
    "OUTPUT_DIR": "/path/to/output"
  }
}
```

### OpenCode

```jsonc
"mcp": {
  "steel": {
    "type": "local",
    "command": ["node", "/path/to/dist/index.cjs"],
    "enabled": true,
    "environment": {
      "BROWSER_MODE": "steel",
      "STEEL_BASE_URL": "http://your-steel-host:3000",
      "RELAY_SECRET": "your-relay-secret"
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio \
  --env BROWSER_MODE=steel \
  --env STEEL_BASE_URL=http://your-steel-host:3000 \
  --env RELAY_SECRET=your-relay-secret \
  --scope user \
  steel -- node /path/to/dist/index.cjs
```

### Claude Desktop / Gemini CLI

```json
{
  "mcpServers": {
    "steel": {
      "command": "node",
      "args": ["/path/to/dist/index.cjs"],
      "env": {
        "BROWSER_MODE": "steel",
        "STEEL_BASE_URL": "http://your-steel-host:3000",
        "RELAY_SECRET": "your-relay-secret"
      }
    }
  }
}
```

---

## Custom Steel Browser Docker Image

For enhanced stealth and CAPTCHA solving, this repo includes a custom Steel Browser image in `docker/`.

### Quick Start

```bash
cd docker

# Optional: set CapSolver API key for CAPTCHA solving
export CAPSOLVER_API_KEY=your-key

# Build and start
docker compose up -d --build

# Verify
curl http://localhost:3000/
```

This starts the Steel Browser on port `3000` (API + session viewer) and `9223` (CDP debug).

### What's Included

- **CapSolver extension** — auto-solves reCAPTCHA v2/v3, hCaptcha, Turnstile, AWS WAF, GeeTest (token mode)
- **Stealth extension** — canvas/audio noise, WebGL spoofing, navigator/platform/userAgentData overrides, Client Hints
- **Unified fingerprint** — generated per container start, consistent across JS and HTTP headers
- **Custom entrypoint** — configurable locale, timezone, GPU renderer (SwiftShader for headless WebGL)

### Configuration

| Env Variable | Default | Description |
|---|---|---|
| `CAPSOLVER_API_KEY` | — | CapSolver key for the container extension, or for `solve_captcha` when set on the MCP process. Do not expose this value in tool calls |
| `CAPTCHA_WAIT_TOTAL_MS` | `90000` | MCP CAPTCHA wait budget in ms. `solve_captcha.timeoutMs` overrides it for one call |
| `TZ` | `UTC` | Container timezone |
| `LANG` | `en-US` | Chrome `--lang` flag |

### Files

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Custom Steel Browser image (CapSolver + stealth on official base) |
| `docker/docker-compose.yml` | Compose file with browser + optional MCP server |
| `docker/entrypoint.sh` | Fingerprint generation, CDPService patching, CapSolver config |
| `docker/extensions/stealth-extra/` | Canvas/audio/WebGL/navigator spoofing extension |
| `docker/smoke-test.sh` | End-to-end test script |

### Running the MCP Server

The MCP server runs locally (not in Docker) since it communicates via stdio with your AI agent:

```bash
BROWSER_MODE=steel STEEL_BASE_URL=http://localhost:3000 node dist/index.cjs
```

For an all-Docker setup, uncomment the `steel-mcp` service in `docker/docker-compose.yml`.

---

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile to dist/index.cjs
bun run test         # Run unit tests
bun run dev          # Watch mode (bun --watch src/index.ts)
bun x tsc --noEmit   # Type-check without emitting
bun run inspector    # Inspect tools via MCP Inspector
bun run lint         # Lint source files (oxlint)
bun run format:check # Check formatting (oxfmt)
```

### Project Structure

```
src/
  index.ts               # Entry point — env, server, register tools, lifecycle
  manager.ts             # BrowserManager class (single responsibility)
  credentials-store.ts   # Credential type + load/save + crypto re-exports
  crypto.ts              # AES-256-GCM encrypt/decrypt (shared)
  utils.ts               # sleep, globalWait, writeToFile
  env.ts                 # Zod env schema
  helpers.ts             # Pure functions — bot-wall, ErrorTracker, dedup, etc.
  relay.ts               # Cookie push relay server
  snapshot.ts            # captureSnapshot + per-tab snapshot baselines (snapshot-diff feedback)
  settle.ts              # SETTLE_INIT_SCRIPT — network-idle + DOM-quiet detection
  llm.ts                 # OpenAI-compatible JSON client (used by act / extract_ai)
  tools/
    index.ts             # Barrel re-exports
    shared.ts            # Toolset gating, tab/frame targets, ref resolver, executors
    extraction.ts        # get_page_text, fetch_urls, get_links, get_attrs, evaluate, extract, snapshot
    interaction.ts       # click, fill, scroll, wait_for, handle_dialog, upload_file, press_key
    screenshots.ts       # get_screenshot (+ @napi-rs/image)
    session.ts           # start_browser, stop_browser, smoke_test, captcha_status, get_console
    network.ts           # cookies, download_file, get_network
    navigation.ts        # go_to_url, history (+ ErrorTracker, CAPTCHA wait)
    credentials.ts       # credentials, use_credential
    tabs.ts              # list_tabs, new_tab, close_tabs
    profiles.ts          # create_profile, list_profiles, save_profile, delete_profile
    act.ts               # act, extract_ai (gated on ACT_LLM_BASE_URL + ACT_LLM_MODEL)
  __tests__/             # Bun tests and local headless browser regressions
docker/
  Dockerfile        # Custom Steel Browser image (CapSolver + stealth)
  docker-compose.yml # Compose for Steel Browser + optional MCP server
  entrypoint.sh     # Fingerprint gen, CDPService patch, CapSolver config
  extensions/       # stealth-extra extension (canvas/audio/WebGL/navigator)
  smoke-test.sh     # End-to-end browser test
extension/          # Chrome/Vivaldi Cookie Push extension (MV3)
skill/              # LLM-facing skill documentation (SKILL.md)
dist/               # Built output (index.cjs)
Dockerfile          # MCP server container image
```

### Tests

```
449 tests total (12 skipped):
  helpers.test.ts                — pure helper functions
  encryption.test.ts             — AES-256-GCM round-trip
  env.test.ts                    — env schema derivation
  relay.test.ts                  — HTTP relay server
  tools.test.ts                  — non-browser + browser-dependent (skipped when Steel unavailable)
  llm.test.ts                    — OpenAI-compatible JSON client (gated)
  snapshot.test.ts               — snapshot + ref resolution
  toolsets.test.ts               — toolset gating + resolver
  network-tool.test.ts           — get_network + cookie filter
  fetch_urls.test.ts             — fetch_urls mode routing (http/browser/auto)
  act.test.ts                    — bounded act micro-loop
  extract_ai.test.ts             — extract_ai JSON-schema validation
  settle.test.ts                 — post-action settle detection
  interaction-lasturl.test.ts    — last-URL tracking per tab
  frame-tools.test.ts            — iframe targeting
  manager.test.ts                — BrowserManager unit tests
  shared.test.ts                 — shared helper tests
  session.test.ts                — start/stop/smoke_test
```

See [AGENTS.md](./AGENTS.md) for architecture details, code style, and tool handler patterns.

---

## License

MIT — see [LICENSE](./LICENSE).
