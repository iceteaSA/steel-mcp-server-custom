# Steel MCP Server (Custom Fork)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents direct control of a browser via [Steel](https://steel.dev) and [Patchright](https://github.com/steel-dev/patchright) (a stealth-hardened Playwright fork). No internal LLM required — the calling agent provides all reasoning.

Fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server), customised for self-hosted Steel with enhanced stealth, CAPTCHA solving, credential management, profile isolation, and a browser extension for session sharing.

---

## Features

- **35 browser tools** — snapshot-first interaction (a11y tree + ref targeting), navigate, click, fill forms, screenshot, extract text/links/attrs, evaluate JS, scroll, history, wait, dialog handling, file uploads, key presses, network inspection, batch URL fetching, declarative structured extraction
- **Patchright browser engine** — drops the `Runtime.enable` CDP fingerprint that vanilla Playwright leaks; native binary stays compatible with all standard Playwright page APIs
- **Snapshot-first paradigm** — `snapshot` returns an accessibility tree with stable `[ref=eN]` tokens; refs feed `click`/`fill`/`scroll`/`get_attrs`/`extract`/`press_key` directly without re-discovering selectors
- **MCP 2025 best practices** — `server.registerTool` with `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` annotations and `outputSchema` → `structuredContent` on JSON tools
- **Toolset filtering** — `core` / `tabs` / `extract` / `media` / `network` / `auth` / `debug` / `ai` groups via `--toolsets` CLI flag or `TOOLSETS` env, to trim the tool surface for context-budget-constrained agents
- **Concurrent-agent safe** — owner-tagged tabs, `tabId` + `force` on every page tool, per-tab ownership guard with explicit override, idle sweeper, scoped cleanup
- **Iframe targeting** — `click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot` accept `frame: "<name>" | "<url-substring>" | "<index>"` to reach into child frames
- **TLS-impersonated batch fetch** — `fetch_urls(mode: "auto"|"http"|"browser")` uses `impit` for fast HTTP first, auto-escalates to a real browser tab when the response looks like an SPA shell
- **Profiles** — isolated BrowserContexts with persistent cookies/localStorage across restarts
- **Credentials** — encrypted credential store (AES-256-GCM) with auto-fill support
- **Cookie Push Extension** — Chrome/Vivaldi extension pushes real browser sessions to Steel profiles via HTTP relay
- **CAPTCHA solving** — CapSolver extension (reCAPTCHA, hCaptcha, Turnstile, AWS WAF, GeeTest) + automatic wait-and-retry (15s CapSolver poll before returning `isError`)
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
- Node.js 18+ (runtime only — for `node dist/index.cjs`)

### Build

```bash
git clone <this-repo>
cd steel-mcp-server-custom
bun install
bun run build          # → dist/index.cjs
bun test               # run unit tests (bun test)
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
| `STEEL_PUBLIC_URL` | — | Public-facing Steel URL for debug/interactive URLs in `start_browser` output |
| `SESSION_TIMEOUT_MS` | `300000` | Steel session auto-release timeout (ms) |
| `SETTLE_TIMEOUT_MS` | `5000` | Max time to wait for network idle + DOM quiet after actions. `0` disables |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool |
| `OPTIMIZE_BANDWIDTH` | `false` | Block images/fonts/CSS for text-only scraping |
| `MAX_INLINE_BYTES` | `512000` | Auto-downgrade to file mode above this size |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file outputs, profiles, credentials |
| `PROFILES_DIR` | `$OUTPUT_DIR/profiles` | Profile state persistence directory |
| `CREDENTIALS_FILE` | `$OUTPUT_DIR/credentials.json` | Credential store path |
| `CREDENTIALS_PASSPHRASE` | — | Encrypts credentials at rest (AES-256-GCM). Plain JSON if unset |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default webp/jpeg quality (1–100) |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Viewport height in px |
| `TAB_IDLE_TIMEOUT_MS` | `300000` | Auto-close idle tabs after this long. `0` disables |
| `TAB_IDLE_SWEEP_INTERVAL_MS` | `60000` | Sweeper check interval |
| `NETWORK_BUFFER_SIZE` | `500` | Max request/response events kept for `get_network`. `0` disables capture |
| `RELAY_PORT` | `3001` | HTTP relay port for Cookie Push extension. `0` disables |
| `RELAY_BIND_ADDR` | `127.0.0.1` | Address the relay HTTP server binds to. Use `0.0.0.0` only behind a reverse proxy/firewall |
| `RELAY_SECRET` | — | Shared secret for relay auth (Bearer token). Required when relay enabled |
| `RELAY_PUBLIC_URL` | — | Public relay URL shown in `start_browser` (e.g. `http://your-host:3001`) |
| `TOOLSETS` | all | Comma-separated toolset groups: `core,tabs,extract,media,network,auth,debug,ai`. Overridden by `--toolsets` |
| `ACT_LLM_BASE_URL` | — | OpenAI-compatible endpoint for `act` / `extract_ai`. Required to enable those tools |
| `ACT_LLM_MODEL` | — | Model name sent to the LLM endpoint. Required to enable `act` / `extract_ai` |
| `ACT_LLM_API_KEY` | — | Optional API key for the LLM endpoint. Unset = no `Authorization` header (ollama-style) |

---

## Tools (35)

All page-interacting tools accept an optional `tabId`. Omit for current-active-tab; pass it for concurrent-agent safety. `click`, `fill`, `scroll`, `wait_for`, `get_attrs`, `extract`, `press_key`, `handle_dialog`, and `upload_file` also accept `ref: "eN"` from `snapshot` in place of a CSS `selector`. `click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot` accept `frame` to target an iframe by name, URL substring, or 0-based child index.

| Tool | Description |
|---|---|
| **Navigation** | |
| `go_to_url` | Navigate + optional `waitFor`. `readPage` extracts content in same call. `disableMedia` blocks images/fonts/CSS. CAPTCHA wait-and-retry (15s poll). Auto-detects bot walls + error loops |
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
| `fill` | Fill form fields by `selector` or `ref`. Auto-detects text/select/checkbox/radio. `frame` targets an iframe |
| `upload_file` | Upload files via `<input type=file>` or a custom upload button (`viaChooser: true`). Absolute host paths only |
| `handle_dialog` | Pre-arm the dialog policy (`accept`/`dismiss`, optional `promptText`) before an action that triggers alert/confirm/prompt |
| `download_file` | Download URL to disk (handles attachments + inline binaries) |
| **Network** | |
| `cookies` | Get or set browser cookies |
| `get_network` | Inspect request/response traffic (filter by urlPattern/resourceType/status). `body: true` or `requestId` fetches a single response body |
| **Sessions & Auth** | |
| `create_profile` | Isolated BrowserContext with auto-restore |
| `list_profiles` | Active + saved profiles |
| `save_profile` | Persist cookies + localStorage to disk |
| `delete_profile` | Close profile context + tabs |
| `credentials` | List/store/update/delete credentials |
| `use_credential` | Retrieve or auto-fill login form |
| **System** | |
| `captcha_status` | CapSolver balance + extension status |
| `smoke_test` | Self-test: navigate, fingerprint, stealth, CapSolver checks. Headless-detection probe (sannysoft) |
| `start_browser` | Start browser, get Session Viewer + Interactive + Relay URLs |
| `stop_browser` | Stop browser. `owner`+`force` override the multi-agent safety check |
| **AI (optional — requires `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL`)** | |
| `act` | LLM-driven bounded micro-loop over a snapshot (1–5 actions) |
| `extract_ai` | LLM structured extraction from the current page (text or html, optional JSON Schema) |

---

## Cookie Push Extension

A Chrome/Vivaldi/Edge extension that pushes your real browser cookies, localStorage, and credentials to Steel profiles in one click.

### Setup

1. **Install the extension** — Go to `chrome://extensions` (or `vivaldi://extensions`), enable Developer Mode, click "Load unpacked", select the `extension/` directory.

2. **Configure the relay** — Set `RELAY_PORT` and `RELAY_SECRET` env vars on the MCP server. The relay starts automatically alongside the stdio transport.

3. **Configure the extension** — Click the extension icon → Server settings → enter the relay URL and shared secret → Save Settings → Test Connection.

### Usage

1. Navigate to a site you're logged into in your browser
2. Click the extension icon
3. Set a profile name (e.g. "github")
4. Click "Push to Steel"
5. In your agent, use `create_profile(name: "github")` — cookies are restored automatically

### Relay API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /status` | No | Health check |
| `POST /push` | Bearer token | Receive cookies/localStorage/credentials → profile |

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
| `CAPSOLVER_API_KEY` | — | CapSolver API key. Leave empty to disable CAPTCHA solving |
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
  __tests__/             # 18 test files, 437 passed + 12 skipped
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
