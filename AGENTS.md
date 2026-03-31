# AGENTS.md — Steel MCP Server (Custom Fork)

Custom fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server) adding
context-budget awareness, configurable data limits, output routing, and reliability fixes for
self-hosted Steel Browser. See `steel-mcp-changes.md` for the original customisation spec.

---

## Build / Run Commands

```bash
# Install dependencies (pnpm is required — this project uses pnpm workspaces)
pnpm install

# Compile TypeScript to dist/index.cjs
pnpm build

# Type-check without emitting (run this before committing)
pnpm exec tsc --noEmit

# Watch mode (rebuilds on file changes via tsup)
pnpm watch

# Run the built server directly (requires env vars — see below)
node dist/index.cjs

# Run with local Steel instance
BROWSER_MODE=local ANTHROPIC_API_KEY=xxx node dist/index.cjs

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
| `BROWSER_MODE` | `"steel"` | `"steel"` for Steel Cloud/self-hosted; `"local"` for a plain browser |
| `MCP_MODE` | `"both"` | `"agent"` (only agent_prompt), `"toolset"` (only browser tools), `"both"` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required unless OPENAI_API_KEY is set) |
| `OPENAI_API_KEY` | — | OpenAI API key (required unless ANTHROPIC_API_KEY is set) |
| `MODEL_NAME` | `"gpt-4o"` / `"claude-3-7-sonnet-20250219"` | LLM model name for the beam agent |
| `STEEL_API_KEY` | — | Required when `BROWSER_MODE=steel` AND `STEEL_BASE_URL` is not set (Steel Cloud) |
| `STEEL_BASE_URL` | `wss://connect.steel.dev` (cloud) | Override to point at a self-hosted Steel instance (e.g. `http://10.1.1.1:3000`). When set, `STEEL_API_KEY` is optional. |
| `MAX_INLINE_BYTES` | `512000` (500 KB) | Threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100); PNG ignores this |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Default viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Default viewport height in px |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action tool (go_to_url, scroll, etc.) for slow pages |

### mcporter config example (self-hosted Steel)

```json
"steel": {
  "command": "node",
  "args": ["/path/to/steel-mcp-server-custom/dist/index.cjs"],
  "env": {
    "BROWSER_MODE": "steel",
    "STEEL_BASE_URL": "http://10.1.1.1:3000",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "GLOBAL_WAIT_SECONDS": "2",
    "OUTPUT_DIR": "/home/user/.openclaw/workspace/steel-output"
  }
}
```

Note: `STEEL_API_KEY` is omitted above — it is not required for self-hosted Steel instances.

---

## Architecture

Two source files: `src/index.ts` (~650 lines) + `src/env.ts` (Zod env schema).
`src/_old.ts` is the archived original Puppeteer-based implementation (do not edit).

**Key class — `BeamClass`:**
- `initialize()` creates a Steel or local browser session and a `Beam` agent instance.
  Uses the module-level `env` (not re-parsed). Sets up console log capture.
- `stop()` releases the Steel session (if any), closes the browser, resets state.
- `sessionId` — stored on the class so `stop()` can call `steelClient.sessions.release()`.
- `consoleLogs` — ring buffer (max 500) of `{ level, text, timestamp }` captured from the page.
- `debugUrl` — Steel session debug URL returned by `start_browser`.

**Browser layer:** The `beam` library wraps **Playwright** (not Puppeteer). All direct page
interactions must use the Playwright API:
- `page.viewportSize()` / `page.setViewportSize({ width, height })` — not `page.viewport()` / `page.setViewport()`
- `page.screenshot(options)` — Playwright `PageScreenshotOptions`; `scale` is `'css'|'device'` (string), not numeric
- `page.waitForSelector(selector, { timeout })` — returns a Locator
- `page.waitForFunction(fn, arg, { timeout })` — evaluates a predicate in the browser
- `page.evaluate(fn, arg)` — same as Puppeteer

**Tool registration:** Use `server.tool(name, description, zodSchema, handler)` from `McpServer`.
Every tool handler must call `await mcpBeam.initialize()`, check `if (!mcpBeam.context)`, then get the page.

**Tool mode toggle:** Tools are enabled/disabled based on `MCP_MODE` at startup.
Add new tools to either `agentTools` or `browserTools` arrays at the bottom of `src/index.ts`.

**Available tools:**

| Tool | Mode | Description |
|---|---|---|
| `agent_prompt` | agent | LLM-driven multi-step browser task |
| `get_screenshot` | toolset | Screenshot with outputMode, format, scale, clip, quality |
| `get_page_text` | toolset | Page text with selector, maxChars, outputMode, includeLinks |
| `wait_for` | toolset | Async condition polling (selector/text appear or disappear) |
| `console_log` | toolset | Browser console messages, filterable by level |
| `scroll_down` | toolset | Scroll down by pixels |
| `scroll_up` | toolset | Scroll up by pixels |
| `go_back` | toolset | Browser history back |
| `go_forward` | toolset | Browser history forward |
| `refresh` | toolset | Reload current page |
| `google_search` | toolset | Navigate to Google search results |
| `go_to_url` | toolset | Navigate to a URL |
| `start_browser` | toolset | Start browser, returns Steel debug URL |
| `stop_browser` | toolset | Stop browser and release Steel session |

---

## Code Style

### TypeScript
- `strict: true`, target `ES2022`, module system `ESNext` with `moduleResolution: "bundler"` (tsup bundles to `.cjs`)
- **No `.js` extension** on local imports (bundler mode resolves them)
- `any` is acceptable only on `args` parameters of tool handlers; prefer Zod inference (`z.infer<typeof schema>`) elsewhere
- Cast caught errors: `const error = err as Error` — do not use `instanceof Error` checks

### Imports
Order: Node built-ins → third-party → local. No blank-line grouping required.

```typescript
import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { EnvSchema } from "./env";
```

### Naming
- `camelCase` for variables, functions, class fields
- `PascalCase` for classes and types
- Tool name strings: `snake_case` (e.g. `"get_screenshot"`, `"go_to_url"`)
- Tool handler variables: `camelCase` with `Tool` suffix (e.g. `getScreenshotTool`)

### Tool handler pattern

```typescript
const myTool = server.tool(
  "tool_name",
  `Description.

CONTEXT BUDGET — one sentence about output size risk.
Use outputMode: 'file' when [condition]. Use 'inline' when [condition].`,
  {
    param: z.string().optional().describe("Description."),
  },
  async ({ param }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      // ... do work ...
      await globalWait(); // call in action tools, not in read-only tools
      return { content: [{ type: "text", text: "Result." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);
```

### Error handling
- Tool handlers always return `{ isError: true, content: [...] }` — never throw to the caller
- Use `try/catch` with `const error = err as Error`
- Log to `stderr` only: `console.error(...)` — stdout is the MCP transport
- Use `try/finally` when resources must be restored (e.g. viewport after scale change)

### Context budget (outputMode pattern)
Tools that produce large output (`get_screenshot`, `get_page_text`) support `outputMode`:
- `"inline"` — return data in the MCP response; auto-downgrade to `"file"` if `buffer.length > maxInlineBytes`
- `"file"` — write to `OUTPUT_DIR` and return only the file path

Use the `writeToFile(data, defaultName, outputPath?)` helper. It calls
`fs.mkdir(path.dirname(filePath), { recursive: true })` so any parent directory is created.

### Global wait
Call `await globalWait()` at the end of every action tool (navigation, scroll, back/forward,
refresh, agent_prompt). Do **not** call it in read-only tools (get_screenshot, get_page_text,
console_log, wait_for, start_browser). Controlled by the `GLOBAL_WAIT_SECONDS` env var (default 0).

### Section comments
Use 80-character dash banners to divide `src/index.ts` into logical sections:
```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
