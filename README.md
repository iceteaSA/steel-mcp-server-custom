# Steel MCP Server (Custom Fork)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents direct control of a browser via [Steel](https://steel.dev) and [Playwright](https://playwright.dev). No internal LLM required — the calling agent (Claude Code, OpenCode, Gemini, etc.) provides all reasoning and drives the tools directly.

Fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server), customised for self-hosted Steel with context-budget-aware tooling.

---

## Features

- **21 browser tools** — navigate, click, type, select, screenshot, page text, extract links/attrs, evaluate JS, scroll, history, wait (consolidated in 0.4.0 from 25 → 21)
- **Concurrent-agent safe** — `new_tab(owner)` tags tabs; `close_tabs_by_owner` lets each agent clean up only its own tabs without stopping the shared browser. All page-interacting tools accept an optional `tabId` so concurrent agents can operate on distinct tabs.
- **Idle tab sweeper** — tabs untouched for `TAB_IDLE_TIMEOUT_MS` (default 5 min) are auto-closed. Keeps long-running shared sessions from leaking tabs.
- **Browser-closed auto-retry** — `new_tab` and page lookups transparently recover from transient `browserContext.newPage: Target page/context/browser has been closed` races (one soft-reset + retry).
- **List-page scraping** — `get_page_text(matchAll: true)` returns one structured entry per matched element with `{text, title, primaryLink, links}`; `get_links` returns URL-only extracts. One call replaces N evaluates.
- **Nav + wait in one call** — `go_to_url(waitFor: "selector")` merges navigation + content-ready wait. Saves a round trip on JS-rendered pages.
- **Bot-check detection** — `go_to_url` returns `isError` when destination is a Cloudflare / Access-denied wall; agents hand off via Interactive URL instead of silently reading an empty page.
- **Context budget aware** — `get_screenshot`, `get_page_text`, `get_links`, and `get_attrs` support `outputMode: "file"` and per-entry / per-array caps; auto-downgrade if output exceeds `MAX_INLINE_BYTES`
- **No LLM dependency** — works in pure toolset mode; the calling agent is the LLM
- **Self-hosted Steel** — connect to any Steel instance via `STEEL_BASE_URL`; no API key needed for local installs
- **Direct Playwright** — uses `chromium.connectOverCDP()` for Steel sessions and `chromium.launch()` for local mode
- **Human-in-the-loop** — `start_browser` returns an interactive URL (via `STEEL_PUBLIC_URL`) so remote users can take control for CAPTCHAs, 2FA, or sensitive logins

---

## Quick Start

### Prerequisites

- [pnpm](https://pnpm.io) — `npm install -g pnpm`
- [Steel Browser](https://github.com/steel-dev/steel-browser) running locally (or a Steel Cloud account)
- A Playwright-compatible Chromium — installed automatically via `pnpm install`

### Build

```bash
git clone https://github.com/your-fork/steel-mcp-server-custom
cd steel-mcp-server-custom
pnpm install
pnpm build
# Output: dist/index.cjs
```

### Run

```bash
# Self-hosted Steel
BROWSER_MODE=steel STEEL_BASE_URL=http://your-steel-host:3000 node dist/index.cjs

# Steel Cloud (API key required)
BROWSER_MODE=steel STEEL_API_KEY=your_key node dist/index.cjs

# Local Chromium (no Steel)
BROWSER_MODE=local node dist/index.cjs
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BROWSER_MODE` | `"steel"` | `"steel"` for Steel Cloud/self-hosted; `"local"` for plain Chromium |
| `STEEL_API_KEY` | — | Required for Steel Cloud (`BROWSER_MODE=steel` with no `STEEL_BASE_URL`) |
| `STEEL_BASE_URL` | Steel Cloud | Self-hosted Steel URL (e.g. `http://your-steel-host:3000`). When set, `STEEL_API_KEY` is optional. |
| `STEEL_PUBLIC_URL` | — | Public-facing Steel URL (e.g. `https://steel.example.com`). Rewrites debug/interactive/viewer URLs in `start_browser` output so they are accessible remotely. Does **not** affect the CDP connection. |
| `SESSION_TIMEOUT_MS` | `300000` (5 min) | Steel session auto-release timeout in ms. Safety net if `stop_browser` is never called. |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool (for slow-loading pages) |
| `OPTIMIZE_BANDWIDTH` | `false` | When `true`, blocks images/fonts/CSS in Steel sessions for faster text-only scraping |
| `MAX_INLINE_BYTES` | `512000` | Bytes threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100) |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Viewport height in px |
| `TAB_IDLE_TIMEOUT_MS` | `300000` (5 min) | Auto-close tabs with no tool activity for this long. `0` disables the sweeper. |
| `TAB_IDLE_SWEEP_INTERVAL_MS` | `60000` (60 s) | How often the idle sweeper checks for stale tabs. |

---

## Tools

All page-interacting tools accept an optional `tabId` parameter. Omit for current-active-tab behaviour; pass it in concurrent-agent workflows where each agent holds its own tab.

| Tool | Description |
|---|---|
| `list_tabs` | List all open tabs with ID, URL, title, active state, and owner tag |
| `new_tab` | Open a new tab (optional URL + `owner` tag), returns tab ID |
| `switch_tab` | Switch active tab by ID |
| `close_tab` | Close a tab by ID (default: current); auto-switches to next |
| `close_tabs_by_owner` | Close all tabs matching an owner tag (for agent-scoped cleanup) |
| `get_current_url` | URL + title of current or specified tab |
| `get_screenshot` | Screenshot — format, quality, scale, clip, fullPage, outputMode, `tabId` |
| `get_page_text` | Visible page text — selector, maxChars, outputMode, includeLinks, `tabId`. With `matchAll: true`, returns JSON array of per-element `{text, title, primaryLink, links}` — list-page scraping in one call |
| `get_links` | Extract deduped `[{text, href}]` under selector, optional `urlPattern` regex filter, `tabId` |
| `get_attrs` | Extract arbitrary element attributes — pass `attrs: ["data-id", "href", …]` and get structured per-element JSON, `tabId` |
| `click` | Click an element by CSS selector |
| `type` | Type into an input — clear (default true), submit (press Enter) |
| `select` | Select a `<select>` dropdown by value, label, or index |
| `evaluate` | Run JavaScript in the page context, returns JSON |
| `wait_for` | Wait for a selector, text to appear, or text to disappear |
| `console_log` | Browser console messages — level filter, maxEntries, clear |
| `scroll` | Scroll page by pixels — `direction: "up"`\|`"down"`, `pixels?`, `tabId?` (replaces scroll_up/scroll_down) |
| `history` | Browser history op — `action: "back"`\|`"forward"`\|`"reload"`, `tabId?` (replaces go_back/go_forward/refresh) |
| `go_to_url` | Navigate to URL, optional `waitFor` selector + `waitTimeout`. Auto-detects Cloudflare / bot-check walls and returns `isError` |
| `start_browser` | Start browser; returns Session Viewer and Interactive URL (shared state — affects all agents) |
| `stop_browser` | Stop browser and release Steel session (shared state — affects all agents; use `close_tabs_by_owner` for per-agent cleanup) |

---

## Client Configuration

### mcporter (recommended for local use)

Add to `~/.mcporter/mcporter.json`:

```json
"steel": {
  "command": "node",
  "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
  "lifecycle": { "mode": "keep-alive" },
  "env": {
    "BROWSER_MODE": "steel",
    "STEEL_BASE_URL": "http://your-steel-host:3000",
    "STEEL_PUBLIC_URL": "https://steel.example.com",
    "SESSION_TIMEOUT_MS": "300000",
    "GLOBAL_WAIT_SECONDS": "2",
    "OUTPUT_DIR": "/home/user/.mcporter/steel-output"
  }
}
```

### OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "steel": {
    "type": "local",
    "command": ["node", "/path/to/steel-mcp-server-custom/dist/index.cjs"],
    "enabled": true,
    "environment": {
      "BROWSER_MODE": "steel",
      "STEEL_BASE_URL": "http://your-steel-host:3000",
      "STEEL_PUBLIC_URL": "https://steel.example.com",
      "SESSION_TIMEOUT_MS": "300000",
      "GLOBAL_WAIT_SECONDS": "2",
      "OUTPUT_DIR": "/home/user/.mcporter/steel-output"
    }
  }
}
```

### Claude Code

Run once to register at user scope (available in all projects):

```bash
claude mcp add --transport stdio \
  --env BROWSER_MODE=steel \
  --env STEEL_BASE_URL=http://your-steel-host:3000 \
  --env STEEL_PUBLIC_URL=https://steel.example.com \
  --env SESSION_TIMEOUT_MS=300000 \
  --env GLOBAL_WAIT_SECONDS=2 \
  --env OUTPUT_DIR=/tmp/steel-mcp \
  --scope user \
  steel -- node /path/to/steel-mcp-server-custom/dist/index.cjs
```

Verify with `claude mcp get steel`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "steel": {
      "command": "node",
      "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
      "env": {
        "BROWSER_MODE": "steel",
        "STEEL_BASE_URL": "http://your-steel-host:3000",
        "STEEL_PUBLIC_URL": "https://steel.example.com",
        "SESSION_TIMEOUT_MS": "300000",
        "GLOBAL_WAIT_SECONDS": "2",
        "OUTPUT_DIR": "/tmp/steel-mcp"
      }
    }
  }
}
```

### Gemini CLI

Add to `~/.gemini/mcp_config.json`:

```json
{
  "mcpServers": {
    "steel": {
      "command": "node",
      "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
      "env": {
        "BROWSER_MODE": "steel",
        "STEEL_BASE_URL": "http://your-steel-host:3000",
        "STEEL_PUBLIC_URL": "https://steel.example.com",
        "SESSION_TIMEOUT_MS": "300000",
        "GLOBAL_WAIT_SECONDS": "2",
        "OUTPUT_DIR": "/tmp/steel-mcp"
      }
    }
  }
}
```

---

## Development

```bash
pnpm watch          # Watch mode (rebuild on changes)
pnpm exec tsc --noEmit  # Type-check
pnpm inspector      # Inspect tools via MCP Inspector
```

See [AGENTS.md](./AGENTS.md) for architecture details, code style, and tool patterns.
