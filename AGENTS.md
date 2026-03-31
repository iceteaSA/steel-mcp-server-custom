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
BROWSER_MODE=steel STEEL_BASE_URL=http://10.1.1.1:3000 node dist/index.cjs

# Local mode (plain Chromium, no Steel)
BROWSER_MODE=local node dist/index.cjs

# Inspect tools via MCP inspector
pnpm inspector
```

**There are no automated tests.** Manual testing is done via mcporter or the MCP inspector.

---

## Environment Variables

Parsed and validated at startup via the Zod schema in `src/env.ts`.
Invalid values cause the process to exit with a descriptive error.

| Variable | Default | Description |
|---|---|---|
| `BROWSER_MODE` | `"steel"` | `"steel"` for Steel Cloud/self-hosted; `"local"` for plain Chromium |
| `STEEL_API_KEY` | — | Required when `BROWSER_MODE=steel` AND `STEEL_BASE_URL` is not set (Steel Cloud). Optional for self-hosted. |
| `STEEL_BASE_URL` | Steel Cloud | Override for self-hosted Steel (e.g. `http://10.1.1.1:3000`). When set, `STEEL_API_KEY` is optional. |
| `MAX_INLINE_BYTES` | `512000` (500 KB) | Threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100); PNG ignores this |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Default viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Default viewport height in px |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool for slow-loading pages |

### mcporter config (self-hosted Steel)

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

No LLM API key required — the calling agent provides all reasoning.

---

## Architecture

Two source files: `src/index.ts` (~400 lines) + `src/env.ts` (Zod env schema).
`src/_old.ts` is the archived original Puppeteer-based implementation (do not edit).

**Key class — `BrowserManager`:**
- `initialize()` — creates a Steel session (or local Chromium launch), connects Playwright
  via `chromium.connectOverCDP()`, opens the first page, wires console log capture.
- `getPage()` — returns the current Playwright `Page`, reopening if closed.
- `stop()` — releases the Steel session, closes the browser, resets state.
- `consoleLogs` — ring buffer (max 500) of `{ level, text, timestamp }`.
- `debugUrl` — Steel session debug URL (returned by `start_browser`).

**Browser layer:** Direct **Playwright** — `chromium` from the `playwright` package.
- `page.viewportSize()` / `page.setViewportSize({ width, height })`
- `page.screenshot(options)` — `PageScreenshotOptions`; `scale` is `'css'|'device'` not numeric
- `page.goto(url, { waitUntil: "domcontentloaded" })` — use domcontentloaded not load
- `page.goBack/goForward({ waitUntil: "commit", timeout: 10000 })` — commit fires on URL change
- `page.waitForSelector(sel, { timeout })` / `page.waitForFunction(fn, arg, { timeout })`
- `page.evaluate(fn, arg)` — runs in browser context

**Tool registration:** `server.tool(name, description, zodSchema, handler)` from `McpServer`.
Every handler calls `await mgr.getPage()` (which auto-initialises) then works with the page.

**Available tools:**

| Tool | Description |
|---|---|
| `get_screenshot` | Screenshot with outputMode, format, scale, clip, quality |
| `get_page_text` | Page text with selector, maxChars, outputMode, includeLinks |
| `wait_for` | Async condition polling (selector/text appear or disappear) |
| `console_log` | Browser console messages, filterable by level |
| `scroll_down` | Scroll down by pixels |
| `scroll_up` | Scroll up by pixels |
| `go_back` | Browser history back |
| `go_forward` | Browser history forward |
| `refresh` | Reload current page |
| `google_search` | Navigate to Google search results |
| `go_to_url` | Navigate to a URL |
| `start_browser` | Start browser, returns Steel debug URL |
| `stop_browser` | Stop browser and release Steel session |

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
Call `await globalWait()` after every action tool (navigation, scroll, back/forward, refresh).
Do **not** call it in read-only tools (get_screenshot, get_page_text, console_log, wait_for).

### Section comments

```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
