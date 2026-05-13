# Steel MCP Server (Custom Fork)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents direct control of a browser via [Steel](https://steel.dev) and [Playwright](https://playwright.dev). No internal LLM required — the calling agent provides all reasoning.

Fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server), customised for self-hosted Steel with enhanced stealth, CAPTCHA solving, credential management, profile isolation, and a browser extension for session sharing.

---

## Features

- **29 browser tools** — navigate, click, fill forms, screenshot, extract text/links/attrs, evaluate JS, scroll, history, wait, download files, batch-fetch URLs, declarative structured extraction
- **Concurrent-agent safe** — owner-tagged tabs, `tabId` on all tools, idle sweeper, scoped cleanup
- **Profiles** — isolated BrowserContexts with persistent cookies/localStorage across restarts
- **Credentials** — encrypted credential store (AES-256-GCM) with auto-fill support
- **Cookie Push Extension** — Chrome/Vivaldi extension pushes real browser sessions to Steel profiles via HTTP relay
- **CAPTCHA solving** — CapSolver extension (reCAPTCHA, hCaptcha, Turnstile, AWS WAF, GeeTest) + automatic wait-and-retry (15s CapSolver poll before returning `isError`)
- **Stealth fingerprint** — unified navigator/WebGL/canvas/audio/Intl spoofing across JS and HTTP
- **Bot-check detection** — `go_to_url` returns `isError` on Cloudflare/WAF walls
- **Error loop detection** — `ErrorTracker` warns when the same URL or domain repeatedly returns errors
- **Readability extraction** — `get_page_text(extractContent: true)` strips nav/ads and returns article body; `format: "markdown"` converts via turndown
- **Batch URL fetching** — `fetch_urls` fetches 1–10 URLs in parallel with Readability extraction in one call
- **Declarative extraction** — `extract(selector, fields)` maps CSS selectors to a field schema and returns structured JSON
- **Image resize/compress** — `get_screenshot` post-capture resize/compress via `@napi-rs/image`; new `maxWidth`/`maxHeight`/`maxFileBytes` params
- **Context budget aware** — `outputMode: "file"`, per-entry caps, auto-downgrade on large output
- **List-page scraping** — `get_page_text(matchAll: true)` for structured extraction in one call
- **Self-hosted Steel** — connect via `STEEL_BASE_URL`; no API key needed for local installs
- **Human-in-the-loop** — interactive URL for CAPTCHAs, 2FA, sensitive logins

---

## Quick Start

### Prerequisites

- [pnpm](https://pnpm.io) — `npm install -g pnpm`
- [Steel Browser](https://github.com/steel-dev/steel-browser) running (self-hosted or Steel Cloud)
- Node.js 18+

### Build

```bash
git clone <this-repo>
cd steel-mcp-server-custom
pnpm install
pnpm build          # → dist/index.cjs
pnpm test           # run tests (vitest)
```

### Run

```bash
# Self-hosted Steel (most common)
BROWSER_MODE=steel STEEL_BASE_URL=http://your-steel-host:3000 node dist/index.cjs

# Steel Cloud (API key required)
BROWSER_MODE=steel STEEL_API_KEY=your_key node dist/index.cjs

# Local Chromium (no Steel, no stealth/CAPTCHA)
BROWSER_MODE=local node dist/index.cjs
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
| `RELAY_PORT` | `3001` | HTTP relay port for Cookie Push extension. `0` disables |
| `RELAY_SECRET` | — | Shared secret for relay auth (Bearer token). Required when relay enabled |
| `RELAY_PUBLIC_URL` | — | Public relay URL shown in `start_browser` (e.g. `http://your-host:3001`) |

---

## Tools (29)

All page-interacting tools accept an optional `tabId`. Omit for current-active-tab; pass it for concurrent-agent safety.

| Tool | Description |
|---|---|
| **Navigation** | |
| `go_to_url` | Navigate + optional `waitFor`. `readPage` extracts content in same call. `disableMedia` blocks images/fonts/CSS. CAPTCHA wait-and-retry (15s poll). Auto-detects bot walls + error loops |
| `history` | Back, forward, or reload |
| `scroll` | Scroll up/down. `readAfterScroll` returns visible text in same call |
| `wait_for` | Wait for selector, text appear, or text disappear |
| **Tabs** | |
| `list_tabs` | List tabs (filter by tabId, owner, profile) |
| `new_tab` | Open tab with optional URL, owner, profile |
| `close_tabs` | Close by tabId, owner, or both |
| **Extraction** | |
| `get_page_text` | Text extraction with smart content area fallback. `extractContent` for Readability article extraction. `format: "markdown"` via turndown. `matchAll` for list scraping. Default maxChars: 5K |
| `get_links` | Extract `[{text, href}]` with optional `urlPattern` filter |
| `get_attrs` | Extract specific attributes from matched elements |
| `get_screenshot` | Screenshot (webp/jpeg/png, selector/clip/fullPage). Default `outputMode: "file"`. Post-capture resize/compress via `@napi-rs/image` (`maxWidth`, `maxHeight`, `maxFileBytes`) |
| `evaluate` | Run JS in page context, return JSON. `maxChars` cap (default 10K). `outputMode: "file"` for large output |
| `get_console` | Browser console messages (filter by level) |
| `fetch_urls` | Batch-fetch 1–10 URLs in parallel with Readability extraction |
| `extract` | Declarative structured extraction: CSS selector + field map → JSON |
| **Interaction** | |
| `click` | Click element + optional `waitFor`/`waitForText` |
| `fill` | Fill form fields. Auto-detects text/select/checkbox/radio |
| `download_file` | Download URL to disk (handles attachments + inline binaries) |
| **Sessions & Auth** | |
| `create_profile` | Isolated BrowserContext with auto-restore |
| `list_profiles` | Active + saved profiles |
| `save_profile` | Persist cookies + localStorage to disk |
| `delete_profile` | Close profile context + tabs |
| `cookies` | Get or set browser cookies |
| `credentials` | List/store/update/delete credentials |
| `use_credential` | Retrieve or auto-fill login form |
| **System** | |
| `captcha_status` | CapSolver balance + extension status |
| `smoke_test` | Self-test: navigate, fingerprint, stealth checks |
| `start_browser` | Start browser, get Session Viewer + Interactive + Relay URLs |
| `stop_browser` | Stop browser (kills all tabs/profiles) |

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
pnpm install        # Install dependencies
pnpm build          # Compile to dist/index.cjs
pnpm test           # Run tests (vitest)
pnpm watch          # Watch mode (rebuild on changes)
pnpm exec tsc --noEmit  # Type-check without emitting
pnpm inspector      # Inspect tools via MCP Inspector
npx oxlint src/     # Lint source files
npx oxfmt --check src/  # Check formatting
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
  tools/
    index.ts             # Barrel re-exports
    extraction.ts        # get_page_text, fetch_urls, get_links, get_attrs, evaluate, extract
    interaction.ts       # click, fill, scroll, wait_for
    screenshots.ts       # get_screenshot (+ @napi-rs/image)
    session.ts           # start_browser, stop_browser, smoke_test, captcha_status, get_console
    network.ts           # cookies, download_file
    navigation.ts        # go_to_url, history (+ ErrorTracker, CAPTCHA wait)
    credentials.ts       # credentials, use_credential
    tabs.ts              # list_tabs, new_tab, close_tabs
    profiles.ts          # create_profile, list_profiles, save_profile, delete_profile
  __tests__/             # 5 test files, 146 passed
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
146 tests total (10 skipped):
  helpers.test.ts     — pure helper functions
  encryption.test.ts  — AES-256-GCM round-trip
  env.test.ts         — env schema derivation
  relay.test.ts       — HTTP relay server
  tools.test.ts       — non-browser + browser-dependent (skipped when Steel unavailable)
```

See [AGENTS.md](./AGENTS.md) for architecture details, code style, and tool handler patterns.

---

## License

MIT — see [LICENSE](./LICENSE).
