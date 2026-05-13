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

# Lint source files
npx oxlint src/

# Check formatting
npx oxfmt --check src/
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
| `PROFILES_DIR` | `$OUTPUT_DIR/profiles` | Directory for persistent profile state (cookies, localStorage). |
| `CREDENTIALS_FILE` | `$OUTPUT_DIR/credentials.json` | Path to credentials store (JSON or encrypted). |
| `CREDENTIALS_PASSPHRASE` | — | Passphrase for encrypting credentials at rest (AES-256-GCM). Plain JSON if unset. |
| `RELAY_PORT` | `3001` | Port for the HTTP relay server (receives cookies from browser extension). `0` disables. |
| `RELAY_SECRET` | — | Shared secret for relay auth (Bearer token). Required when `RELAY_PORT > 0`. |
| `RELAY_PUBLIC_URL` | — | Public URL for the relay (e.g. `http://your-host:3001`). Shown in `start_browser` output. Defaults to `http://localhost:<RELAY_PORT>`. |

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

Source files:

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
```

**Key class — `BrowserManager`** (in `src/manager.ts`):
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
| `list_tabs` | List tabs (filter by owner/profile/tabId). Replaces get_current_url |
| `new_tab` | Open a new tab (optional URL, owner, profile) |
| `close_tabs` | Close by tabId, owner, or both. Replaces close_tab + close_tabs_by_owner |
| `go_to_url` | Navigate + optional waitFor. `readPage` extracts content in same call. `disableMedia` blocks images/fonts/CSS. CAPTCHA wait-and-retry (15s CapSolver poll). Auto-detects bot walls + error loops |
| `click` | Click element + optional waitFor/waitForText. Reports navigation |
| `fill` | Fill 1+ form fields. Auto-detects type. Replaces type + select |
| `scroll` | Scroll up/down. `readAfterScroll` returns visible text in same call |
| `history` | Back, forward, or reload. Reports URL + title |
| `wait_for` | Wait for selector/text/textGone. Timeout shows page context |
| `get_page_text` | Extract text (auto-selects main content area). `extractContent` for Readability article extraction. `format: "markdown"` via turndown. `matchAll` for lists. Default maxChars: 5K |
| `get_links` | Extract [{text, href}] with optional urlPattern filter |
| `get_attrs` | Extract specific attributes from matched elements |
| `get_screenshot` | Screenshot (webp/jpeg/png, selector/clip/fullPage). Default outputMode: "file". Post-capture resize via @napi-rs/image (maxWidth, maxHeight, maxFileBytes) |
| `evaluate` | Run JS in page context, return JSON. maxChars cap (default 10K). outputMode: "file" for large output |
| `get_console` | Browser console messages (filter by level) |
| `fetch_urls` | Batch-fetch 1–10 URLs in parallel with Readability extraction |
| `extract` | Declarative structured extraction: CSS selector + field map → JSON |
| `download_file` | Download URL to disk (handles attachments + inline binaries) |
| `cookies` | Get or set browser cookies. Filter by domain |
| `credentials` | List/store/update/delete credentials (no args = list) |
| `use_credential` | Retrieve or auto-fill login form with stored credential |
| `captcha_status` | CapSolver balance + availability |
| `create_profile` | Create isolated BrowserContext. Auto-restores saved state |
| `list_profiles` | Active + saved profiles |
| `save_profile` | Persist cookies + localStorage to disk |
| `delete_profile` | Close profile context + tabs |
| `smoke_test` | Self-test: navigate, fingerprint, stealth, CapSolver checks |
| `start_browser` | Start browser, get Session Viewer + Interactive + Relay URLs |
| `stop_browser` | Stop browser (kills all tabs/profiles — use close_tabs for cleanup) |

### Design principles for new tools

- **Budget awareness** — every tool that reads from the page must cap its output. Pick sensible defaults (`maxChars`, `maxEntries`, `limit`). Expose `outputMode: "file"` when size can unbounded-ly grow.
- **Structured over prose** — prefer returning JSON-shaped data over serialized text when the downstream agent will parse it anyway.
- **Dedup + sanitize** — collapse whitespace, strip fragments, first-non-empty-wins across duplicate hrefs (DOM-order yields headlines, not excerpts).
- **One call not N** — if an existing tool takes 3 exec to accomplish a common task, add an option to merge them (`go_to_url` gained `waitFor` for this reason).
- **Fail safely** — auto-detect Cloudflare/bot walls and return `isError: true`, don't swallow the response and let the agent silently scrape an empty page.
- **Search first, never guess URLs** — use extraction tools to discover links; never construct or guess URLs from patterns.
- **Wait for CAPTCHA before failing** — `go_to_url` polls CapSolver for up to 15s on CAPTCHA walls before returning `isError: true`, giving the solver time to complete.

---

## Code Style

### TypeScript
- `strict: true`, target `ES2022`, `moduleResolution: "bundler"` (tsup bundles to `.cjs`)
- Local imports use `.js` extension (required for the ESM module system): `import { foo } from "./helpers.js"`
- Cast caught errors: `const error = err as Error`

### Imports
Node built-ins → third-party → local:

```typescript
import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "playwright";
import { z } from "zod";

import { EnvSchema } from "./env.js";
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
      await globalWait(env); // action tools only; not read-only tools
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

Use `writeToFile(data, defaultName, env, outputPath?)` — takes `env` param, creates parent dirs automatically.

### Global wait
Call `await globalWait(env)` after every action tool (navigation, scroll, click, type, select, etc.).
Do **not** call it in read-only tools (get_screenshot, get_page_text, get_current_url,
console_log, wait_for). Controlled by `GLOBAL_WAIT_SECONDS` env var (default 0).

### Section comments

```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
