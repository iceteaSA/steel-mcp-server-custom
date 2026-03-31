# Steel MCP Server (Custom Fork)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents direct control of a browser via [Steel](https://steel.dev) and [Playwright](https://playwright.dev). No internal LLM required — the calling agent (Claude Code, OpenCode, Gemini, etc.) provides all reasoning and drives the tools directly.

Fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server), customised for self-hosted Steel with context-budget-aware tooling.

---

## Features

- **18 browser tools** — navigate, click, type, select, screenshot, page text, evaluate JS, scroll, history, wait
- **Context budget aware** — `get_screenshot` and `get_page_text` support `outputMode: "file"` to avoid loading large blobs into agent context; auto-downgrade if output exceeds `MAX_INLINE_BYTES`
- **No LLM dependency** — works in pure toolset mode; the calling agent is the LLM
- **Self-hosted Steel** — connect to any Steel instance via `STEEL_BASE_URL`; no API key needed for local installs
- **Direct Playwright** — uses `chromium.connectOverCDP()` for Steel sessions and `chromium.launch()` for local mode

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
BROWSER_MODE=steel STEEL_BASE_URL=http://10.1.1.1:3000 node dist/index.cjs

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
| `STEEL_BASE_URL` | Steel Cloud | Self-hosted Steel URL (e.g. `http://10.1.1.1:3000`). When set, `STEEL_API_KEY` is optional. |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool (for slow-loading pages) |
| `MAX_INLINE_BYTES` | `512000` | Bytes threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100) |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Viewport height in px |

---

## Tools

| Tool | Description |
|---|---|
| `get_current_url` | Current page URL and title |
| `get_screenshot` | Screenshot — format, quality, scale, clip, fullPage, outputMode |
| `get_page_text` | Visible page text — selector, maxChars, outputMode, includeLinks |
| `click` | Click an element by CSS selector |
| `type` | Type into an input — clear (default true), submit (press Enter) |
| `select` | Select a `<select>` dropdown by value, label, or index |
| `evaluate` | Run JavaScript in the page context, returns JSON |
| `wait_for` | Wait for a selector, text to appear, or text to disappear |
| `console_log` | Browser console messages — level filter, maxEntries, clear |
| `scroll_down` | Scroll down by pixels |
| `scroll_up` | Scroll up by pixels |
| `go_back` | Browser history back (returns new URL) |
| `go_forward` | Browser history forward (returns new URL) |
| `refresh` | Reload page (returns URL) |
| `google_search` | Navigate to Google search results with outputMode support |
| `go_to_url` | Navigate to URL (returns final URL after redirects) |
| `start_browser` | Start browser, returns Steel debug URL |
| `stop_browser` | Stop browser and release Steel session |

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
    "STEEL_BASE_URL": "http://10.1.1.1:3000",
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
      "STEEL_BASE_URL": "http://10.1.1.1:3000",
      "GLOBAL_WAIT_SECONDS": "2",
      "OUTPUT_DIR": "/home/user/.mcporter/steel-output"
    }
  }
}
```

### Claude Code / Claude Desktop

Add to `~/.claude/settings.json` (Claude Code) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "steel": {
      "command": "node",
      "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
      "env": {
        "BROWSER_MODE": "steel",
        "STEEL_BASE_URL": "http://10.1.1.1:3000",
        "GLOBAL_WAIT_SECONDS": "2",
        "OUTPUT_DIR": "/tmp/steel-mcp"
      }
    }
  }
}
```

### Gemini CLI

Add to `~/.gemini/antigravity/mcp_config.json` (Gemini with Antigravity) or `~/.gemini/mcp_config.json` (standard Gemini CLI):

```json
{
  "mcpServers": {
    "steel": {
      "command": "node",
      "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
      "env": {
        "BROWSER_MODE": "steel",
        "STEEL_BASE_URL": "http://10.1.1.1:3000",
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
