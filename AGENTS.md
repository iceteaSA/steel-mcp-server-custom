# AGENTS.md — Steel MCP Server (Custom Fork)

Custom fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server) adding
context-budget awareness, configurable data limits, and output routing for self-hosted Steel Browser.
See `steel-mcp-changes.md` for the full customisation spec.

---

## Build / Run Commands

```bash
# Install dependencies (pnpm is required — this project uses pnpm workspaces)
pnpm install

# Compile TypeScript to dist/index.cjs
pnpm build

# Type-check without emitting (use this to verify types before committing)
pnpm exec tsc --noEmit

# Watch mode (rebuilds on file changes)
pnpm watch

# Run the built server directly (requires env vars — see below)
node dist/index.cjs

# Run with local Steel instance
BROWSER_MODE=local ANTHROPIC_API_KEY=xxx node dist/index.cjs

# Inspect tools via MCP inspector
pnpm inspector
```

**There are no automated tests.** Manual testing is done via mcporter or the MCP inspector.
To test with a local Steel instance, configure mcporter with the env vars shown below.

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
| `STEEL_API_KEY` | — | Required when `BROWSER_MODE=steel` |
| `STEEL_BASE_URL` | `wss://connect.steel.dev` (cloud) | Override to point at a self-hosted Steel instance (e.g. `http://10.1.1.1:3000`) |
| `MAX_INLINE_BYTES` | `512000` (500 KB) | Threshold above which inline output auto-downgrades to file mode |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs (screenshots, page text) |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | Default JPEG quality (1–100); PNG ignores this |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Default viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Default viewport height in px |
| `GLOBAL_WAIT_SECONDS` | `0` | Seconds to wait after each action (for slow pages) |

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

---

## Architecture

Single-file server: `src/index.ts` (~550 lines) + `src/env.ts` (Zod env schema).
`src/_old.ts` is the archived original Puppeteer-based implementation (do not edit).

**Key classes:**
- `BeamClass` — wraps browser lifecycle. `initialize()` creates a Steel or local browser session and a `Beam` agent instance. `stop()` tears everything down. Call `mcpBeam.initialize()` at the start of every tool handler.
- `BeamClass.context` — `BrowserContext` from the `beam` package. Use `await mcpBeam.context.getCurrentPage()` to get the current Playwright `Page`.

**Browser layer:** The `beam` library wraps **Playwright** (not Puppeteer). All direct page interactions must use the Playwright API:
- `page.viewportSize()` / `page.setViewportSize({ width, height })` — not `page.viewport()` / `page.setViewport()`
- `page.screenshot(options)` — Playwright `PageScreenshotOptions` (type, quality, fullPage, clip, scale)
- `page.evaluate(fn, arg)` — same as Puppeteer

**Tool registration:** Use `server.tool(name, description, zodSchema, handler)` from `McpServer`.
Every tool handler must: call `await mcpBeam.initialize()`, check `if (!mcpBeam.context)`, then get the page.

**Tool mode toggle:** Tools are enabled/disabled based on `MCP_MODE` at startup. Add new tools to either `agentTools` or `browserTools` arrays at the bottom of `src/index.ts`.

---

## Code Style

### TypeScript
- `strict: true`, target `ES2022`, module system `ESNext` with `moduleResolution: "bundler"` (tsup bundles)
- **No `.js` extension** on local imports (bundler mode resolves them)
- `any` is acceptable only on `args` parameters of tool handlers; prefer Zod inference (`z.infer<typeof schema>`) elsewhere
- Cast caught errors: `const error = err as Error` — do not use `instanceof Error` checks
- Use `(error as Error).message` / `(error as Error).stack`

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
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` only for true module-level constants (e.g. `TOOLS` array in old code — not used in new style)
- Tool names: `snake_case` strings (e.g. `"get_screenshot"`, `"go_to_url"`)
- Handler variables: `camelCase` with `Tool` suffix (e.g. `getScreenshotTool`, `agentPromptTool`)

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
- Process-exit errors use `process.exit(1)` in `runServer().catch()`

### Context budget (outputMode pattern)
Tools that produce large output (`get_screenshot`, `get_page_text`) support `outputMode`:
- `"inline"` — return data in the MCP response; auto-downgrade to `"file"` if `buffer.length > maxInlineBytes`
- `"file"` — write to `OUTPUT_DIR` and return only the file path

Use the shared `writeToFile(data, defaultName, outputPath?)` helper. Always `await fs.mkdir(dir, { recursive: true })` before writing.

### Strings
- Template literals for all interpolation
- `+` concatenation only for multi-line prose strings that don't need interpolation
- `console.error(...)` for all logging (never `console.log`)

### Section comments
Use 80-character dash banners to divide `src/index.ts` into logical sections:
```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
