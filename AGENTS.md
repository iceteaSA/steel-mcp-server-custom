# AGENTS.md — Steel MCP Server (Custom Fork)

Custom fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server) for
self-hosted Steel Browser. Provides direct Playwright browser tools for LLM agents — no internal
LLM required. See `steel-mcp-changes.md` for the original customisation spec.

---

## Build / Run Commands

```bash
# Install dependencies (pnpm is required)
pnpm install

# Compile TypeScript to dist/index.cjs
pnpm build

# Type-check without emitting (run before committing)
pnpm exec tsc --noEmit

# Watch mode (rebuilds on file changes via tsup)
pnpm watch

# Run the built server directly
BROWSER_MODE=steel STEEL_BASE_URL=http://your-steel-host:3000 node dist/index.cjs

# Local mode (plain Chromium, no Steel)
BROWSER_MODE=local node dist/index.cjs

# Inspect tools via MCP inspector
pnpm inspector
```

**Tests:** `pnpm test` runs vitest (`test/*.test.ts`) — covers the pure helpers shared by
`get_page_text(matchAll)`, `get_links`, `get_attrs`, and the bot-check detector. Full
browser flows are still validated manually via mcporter or the MCP inspector.

---

## Environment Variables

Parsed and validated at startup via the Zod schema in `src/env.ts`.
Invalid values cause the process to exit with a descriptive error.

| Variable | Default | Description |
|---|---|---|
| `BROWSER_MODE` | `"steel"` | `"steel"` for Steel Cloud/self-hosted; `"local"` for plain Chromium |
| `STEEL_API_KEY` | — | Required when `BROWSER_MODE=steel` AND `STEEL_BASE_URL` is not set (Steel Cloud). Optional for self-hosted. |
| `STEEL_BASE_URL` | Steel Cloud | Override for self-hosted Steel (e.g. `http://your-steel-host:3000`). When set, `STEEL_API_KEY` is optional. |
| `MAX_INLINE_BYTES` | `512000` (500 KB) | Threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100); PNG ignores this |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Default viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Default viewport height in px |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool for slow-loading pages |
| `SESSION_TIMEOUT_MS` | `300000` (5 min) | Steel session auto-release timeout in ms. Safety net if `stop_browser` is never called. |
| `OPTIMIZE_BANDWIDTH` | `false` | When `true`, blocks images/fonts/CSS for faster text-only scraping. |
| `STEEL_PUBLIC_URL` | — | Public-facing Steel URL (e.g. `https://steel.example.com`). Rewrites debug/interactive/viewer URLs in `start_browser` output so they are accessible remotely. Does **not** affect the CDP WebSocket connection. |
| `TAB_IDLE_TIMEOUT_MS` | `300000` (5 min) | Auto-close tabs with no tool activity for this long. `0` disables the sweeper. |
| `TAB_IDLE_SWEEP_INTERVAL_MS` | `60000` (60 s) | How often the idle sweeper checks for stale tabs. |

### Concurrency — multi-agent sessions

This server is safe for multiple concurrent agents sharing one browser session.
The design principles:

- **Owner-tagged tabs.** `new_tab(url, owner)` records an owner string on the
  tab. Agents use their own unique owner (e.g. `agent:<id>-<timestamp>`).
- **Tab-scoped operations.** All page-interacting tools accept an optional
  `tabId`. Agents pass their own tab ID on every call so another agent's
  `switch_tab` doesn't pull the active-tab pointer out from under them.
- **Scoped cleanup.** `close_tabs_by_owner(owner)` closes only that agent's
  tabs. `stop_browser` destroys the whole session — do not use for per-agent
  cleanup.
- **Idle sweeper.** Every page-targeted call refreshes the tab's
  `lastActivity` timestamp. Tabs untouched for `TAB_IDLE_TIMEOUT_MS` are
  auto-closed. Safety net for abandoned tabs — not a substitute for
  `close_tabs_by_owner`.
- **Browser-closed retry.** `newTab` / `getPage` catch Playwright
  "Target/context/browser has been closed" errors, soft-reset, wait 2 s,
  retry once. Fixes the race between `start_browser` returning and the
  context becoming ready.

### mcporter config (self-hosted Steel)

```json
"steel": {
  "command": "node",
  "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
  "lifecycle": { "mode": "keep-alive" },
  "env": {
    "BROWSER_MODE": "steel",
    "STEEL_BASE_URL": "http://your-steel-host:3000",
    "STEEL_PUBLIC_URL": "https://your-public-steel-url",
    "SESSION_TIMEOUT_MS": "300000",
    "GLOBAL_WAIT_SECONDS": "2",
    "OUTPUT_DIR": "/home/user/.mcporter/steel-output"
  }
}
```

No LLM API key required — the calling agent provides all reasoning.

---

## Architecture

Two source files: `src/index.ts` (tool registrations; shared pure helpers for sanitization, dedup, bot detection live at top of file) + `src/env.ts` (Zod env schema).

**Key class — `BrowserManager`:**
- `initialize()` — creates a Steel session (or local Chromium launch), connects Playwright
  via `chromium.connectOverCDP()`, opens the first page, wires console log capture.
- `getPage()` — returns the current Playwright `Page`, reopening if closed. Re-attaches
  the console listener via a `WeakSet` guard so each page is only listened to once.
- `stop()` — releases the Steel session, closes the browser, resets state.
- `consoleLogs` — ring buffer (max 500) of `{ level, text, timestamp }`.
- `debugUrl` — Steel session debug URL (returned by `start_browser`).

**Browser layer:** Direct **Playwright** — `chromium` from the `playwright` package.
- `page.viewportSize()` / `page.setViewportSize({ width, height })`
- `page.screenshot(options)` — `PageScreenshotOptions`; `scale` is `'css'|'device'` not numeric
- `page.goto(url, { waitUntil: "domcontentloaded" })` — use domcontentloaded not load
- `page.goBack/goForward({ waitUntil: "commit", timeout: 10000 })` — commit fires on URL change
- `page.waitForSelector(sel, { timeout })` / `page.waitForFunction(fn, arg, { timeout })`
- `page.click(sel, { timeout })` / `page.fill(sel, text)` / `page.type(sel, text)`
- `page.selectOption(sel, { value|label|index })` / `page.press(sel, key)`
- `page.evaluate(fn, arg)` — runs in browser context

**Tool registration:** `server.tool(name, description, zodSchema, handler)` from `McpServer`.
Every handler calls `await mgr.getPage()` (which auto-initialises) then works with the page.

**Available tools:**

All page-interacting tools accept an optional `tabId` parameter (omit for
current-active-tab behaviour; pass for concurrent-agent safety).

| Tool | Description |
|---|---|
| `list_tabs` | List all open tabs with ID, URL, title, active state, and owner tag |
| `new_tab` | Open a new tab (optional URL + `owner` tag), returns tab ID |
| `switch_tab` | Switch active tab by ID — **discouraged** for concurrent workflows; pass `tabId` to each tool instead |
| `close_tab` | Close a tab by ID (default: current); auto-switches to next remaining |
| `close_tabs_by_owner` | Close all tabs matching an owner tag — scoped cleanup for one agent without affecting others |
| `get_current_url` | Returns current page URL and title |
| `get_screenshot` | Screenshot with outputMode, format, scale, clip, quality |
| `get_page_text` | Page text with selector, maxChars, outputMode, includeLinks. `matchAll: true` returns JSON array per-element `{text, title, primaryLink, links}` — preferred for list-page scraping |
| `get_links` | URL-only extraction from anchors under selector; optional `urlPattern` regex filter |
| `get_attrs` | Per-element attribute extraction; pass `attrs: [...]` to get structured JSON per match |
| `click` | Click an element by CSS selector |
| `type` | Type text into an input (clear, submit options) |
| `select` | Select a dropdown option by value, label, or index |
| `evaluate` | Run JavaScript in the page context, return JSON result |
| `wait_for` | Async condition polling (selector/text appear or disappear) |
| `console_log` | Browser console messages, filterable by level |
| `scroll` | Scroll the page — `direction: "up"`\|`"down"`, `pixels?` (default 500) |
| `history` | Browser history op — `action: "back"`\|`"forward"`\|`"reload"` |
| `go_to_url` | Navigate to a URL. Optional `waitFor` selector + `waitTimeout` — merges nav + wait. Auto-detects Cloudflare/bot walls, returns `isError` on hit |
| `start_browser` | Start browser, returns Steel debug URL |
| `stop_browser` | Stop browser and release Steel session (shared state — prefer `close_tabs_by_owner` for per-agent cleanup) |

### Design principles for new tools

- **Budget awareness** — every tool that reads from the page must cap its output. Pick sensible defaults (`maxChars`, `maxEntries`, `limit`). Expose `outputMode: "file"` when size can unbounded-ly grow.
- **Structured over prose** — prefer returning JSON-shaped data over serialized text when the downstream agent will parse it anyway.
- **Dedup + sanitize** — collapse whitespace, strip fragments, first-non-empty-wins across duplicate hrefs (DOM-order yields headlines, not excerpts).
- **One call not N** — if an existing tool takes 3 exec to accomplish a common task, add an option to merge them (`go_to_url` gained `waitFor` for this reason).
- **Fail safely** — auto-detect Cloudflare/bot walls and return `isError: true`, don't swallow the response and let the agent silently scrape an empty page.

---

## Code Style

### TypeScript
- `strict: true`, target `ES2022`, `moduleResolution: "bundler"` (tsup bundles to `.cjs`)
- No `.js` extension on local imports
- Cast caught errors: `const error = err as Error`

### Imports
Node built-ins → third-party → local:

```typescript
import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "playwright";
import { z } from "zod";

import { EnvSchema } from "./env";
```

### Tool handler pattern

```typescript
server.tool(
  "tool_name",
  `Description.

CONTEXT BUDGET — one sentence about output size risk.`,
  { param: z.string().optional().describe("Description.") },
  async ({ param }) => {
    try {
      const page = await mgr.getPage();
      // ... do work ...
      await globalWait(); // action tools only; not read-only tools
      return { content: [{ type: "text", text: "Result." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);
```

### Error handling
- Always return `{ isError: true, content: [...] }` — never throw to the caller
- `console.error(...)` only — stdout is the MCP transport

### Context budget (outputMode pattern)
- `"inline"` — return data directly; auto-downgrades to `"file"` if `buffer.length > maxInlineBytes`
- `"file"` — write to `OUTPUT_DIR`, return file path only

Use `writeToFile(data, defaultName, outputPath?)` — creates parent dirs automatically.

### Global wait
Call `await globalWait()` after every action tool (navigation, scroll, click, type, select, etc.).
Do **not** call it in read-only tools (get_screenshot, get_page_text, get_current_url,
console_log, wait_for). Controlled by `GLOBAL_WAIT_SECONDS` env var (default 0).

### Section comments

```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
