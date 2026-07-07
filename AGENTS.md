# AGENTS.md — Steel MCP Server (Custom Fork)

Custom fork of [steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server) for
self-hosted Steel Browser. Provides direct Playwright browser tools for LLM agents — no internal
LLM required. See `IMPROVEMENTS.md` for the prioritized improvement plan and `CHANGELOG.md`
for what diverged from upstream.

---

## Build / Run Commands

```bash
# Install dependencies (bun is required)
bun install

# Compile TypeScript to dist/index.cjs
bun run build

# Run from source without building (bun --watch)
bun run dev

# Type-check without emitting (run before committing)
bun x tsc --noEmit

# Run the built server directly
BROWSER_MODE=steel STEEL_BASE_URL=http://your-steel-host:3000 node dist/index.cjs

# Local mode (plain Chromium, no Steel)
BROWSER_MODE=local node dist/index.cjs

# Inspect tools via MCP inspector
bun run inspector

# Lint / format (oxlint + oxfmt, NOT eslint/prettier)
bun run lint
bun run format:check   # or `bun run format` to write

# Run tests (bun test — src/__tests__/ only)
bun run test
```

**Tests:** `bun test` runs over `src/__tests__/*.test.ts` only (18 files; 465 passed
+ 12 skipped). The root `test/` directory has been deleted (stale leftover from an
earlier version). Full browser flows are still validated manually via mcporter or
the MCP inspector.

**Deploy (homelab):**

```bash
# 1. On the build host (where bun is installed)
bun install
bun run build
#  → dist/index.cjs + dist/*.linux-x64-{gnu,musl}.node
#    (patchright is external — must ship node_modules alongside dist/)

# 2. Sync the dist/ folder to the LXC deploy dir
rsync -av --delete ./dist/ openclaw:~/mcp-servers/steel-mcp-server-custom/dist/

# 3. Ship patchright + patchright-core (the only runtime deps not bundled)
rsync -av ./node_modules/patchright ./node_modules/patchright-core \
  openclaw:~/mcp-servers/steel-mcp-server-custom/node_modules/

# 4. Run the artifact on the LXC
cd ~/mcp-servers/steel-mcp-server-custom
node dist/index.cjs

# 5. Copy the agent-facing skill
cp skill/SKILL.md ~/.agents/skills/steel-browser/SKILL.md
```

The artifact runs under `node` on the LXC — bun is not needed at runtime. The `skill/`
directory holds the agent-facing usage skill — keep it in sync with tool changes.

**Build — patchright is external.** `bun build --outdir dist --target=node --format=cjs
--external patchright --external patchright-core` bundles all JS deps EXCEPT patchright
into `dist/index.cjs`. The two napi `.node` files (`@napi-rs/image`, `impit`) are
emitted as sidecars next to it. **patchright is external because it reads its own
package.json at runtime via `__dirname` — the bundler would hardcode the build host's
absolute path, making the artifact unreproducible across machines. `--compile`
single-binary is also ruled out (patchright's bundled ws hangs on the Steel CDP
WebSocket under bun compile).** The deploy target needs `node` + `dist/` +
`node_modules/patchright{,-core}` — no `bun install --production`, no full
`node_modules`. Both gnu and musl `.node` variants are shipped; `node` picks the
right one at load time.

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
| `OUTPUT_ROOT` | `$OUTPUT_DIR` | Containment root for `outputPath` args (get_screenshot, evaluate, get_network, download_file, get_page_text file mode). Realpath-resolved; paths outside this root are rejected. Set to `*` to disable the check (escape hatch — service account can write anywhere). |
| `UPLOAD_ROOT` | `$OUTPUT_DIR` | Containment root for `upload_file` source paths. Realpath-resolved; paths outside this root are rejected (defeats `/etc/passwd` exfiltration through any upload form on the open web). Set to `*` to disable. |
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
| `RELAY_BIND_ADDR` | `127.0.0.1` | Address the relay HTTP server binds to. Use `0.0.0.0` to accept external connections (only when behind a reverse proxy or firewall). |
| `SETTLE_TIMEOUT_MS` | `5000` | Max time to wait for network idle + DOM quiet after action tools. `0` disables settle detection entirely. |
| `NETWORK_BUFFER_SIZE` | `500` | Max request/response events kept for `get_network`. `0` disables capture (no listeners, empty results). |
| `TOOLSETS` | all | Comma-separated toolset groups to activate: `core,tabs,extract,media,network,auth,debug,ai`. `core` is always active. Overridden by the `--toolsets` CLI flag. |
| `ACT_LLM_BASE_URL` | — | OpenAI-compatible endpoint for `act` / `extract_ai`. Base URL is used as-is; append `/v1` yourself if the provider expects it. Required to enable those tools. |
| `ACT_LLM_MODEL` | — | Model name sent to the LLM endpoint (e.g. `gemma3`, `qwen2.5`). Required to enable `act` / `extract_ai`. |
| `ACT_LLM_API_KEY` | — | Optional API key for the LLM endpoint. When unset, no `Authorization` header is sent (ollama-style). |

### `--toolsets` — Toolset Filtering

Tools are grouped into 8 sets; pass any subset to trim the tool surface for
context-budget-constrained agents:

| Group    | Includes                                                          |
|----------|-------------------------------------------------------------------|
| `core`   | Always active. `go_to_url`, `history`, `click`, `fill`, `scroll`, `wait_for`, `press_key`, `handle_dialog`, `upload_file`, `snapshot`, `get_page_text`, `start_browser`, `stop_browser`. |
| `tabs`   | `list_tabs`, `new_tab`, `close_tabs`.                              |
| `extract`| `get_links`, `get_attrs`, `evaluate`, `extract`, `fetch_urls`.     |
| `media`  | `get_screenshot`, `download_file`.                                 |
| `network`| `cookies`, `get_network`.                                         |
| `auth`   | `create_profile`, `list_profiles`, `save_profile`, `delete_profile`, `credentials`, `use_credential`. |
| `debug`  | `smoke_test`, `get_console`, `captcha_status`.                     |
| `ai`     | `act`, `extract_ai` — only registered when `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL` are set. |

Precedence: `--toolsets a,b` CLI flag > `TOOLSETS` env var > all toolsets.
Unknown names fail startup with a list of valid values.

By default all 8 toolsets are active (34 tools); the `ai` toolset is gated on
`ACT_LLM_BASE_URL` + `ACT_LLM_MODEL` — without those env vars, `act` and
`extract_ai` are not registered, even if `--toolsets=ai` is passed.

### Concurrency — multi-agent sessions

This server is safe for multiple concurrent agents sharing one browser session.
The design principles:

- **Owner-tagged tabs.** `new_tab(url, owner)` records an owner string on the
  tab. Agents use their own unique owner (e.g. `agent:<id>-<timestamp>`).
- **Tab-scoped operations.** All page-interacting tools accept an optional
  `tabId`. Agents pass their own tab ID on every call so another agent's tab
  activity doesn't pull the active-tab pointer out from under them.
- **Scoped cleanup.** `close_tabs({ owner })` closes only that agent's tabs.
  `stop_browser` destroys the whole session — do not use for per-agent
  cleanup.
- **Idle sweeper.** Every page-targeted call refreshes the tab's
  `lastActivity` timestamp. Tabs untouched for `TAB_IDLE_TIMEOUT_MS` are
  auto-closed. Safety net for abandoned tabs — not a substitute for
  `close_tabs({ owner })`.
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
  __tests__/             # 17 test files, 146+ passed
```

**Key class — `BrowserManager`** (in `src/manager.ts`):
- `initialize()` — creates a Steel session (or local Chromium launch), connects Patchright
  via `chromium.connectOverCDP()`, opens the first page, wires console + network listeners.
- `getPage()` — returns the current Playwright `Page`, reopening if closed. Re-attaches
  the console listener via a `WeakSet` guard so each page is only listened to once.
  Auto-recovers from "browser has been closed" with a soft-reset + one retry.
- `stop()` — releases the Steel session, closes the browser, resets state.
- `consoleLogs` — ring buffer (max 500) of `{ level, text, timestamp, tabId, location? }`.
- `debugUrl` — Steel session debug URL (returned by `start_browser`).
- `dialogPolicy` / `lastDialog` — per-tab pre-arming for `handle_dialog`.
- `networkEvents` — ring buffer (size `NETWORK_BUFFER_SIZE`) consumed by `get_network`.

**Browser layer:** Direct **Patchright** — `chromium` from the `patchright` package (a
patched Playwright build that bypasses the `Runtime.enable` stealth fingerprint). All
page APIs match standard Playwright.

**Stealth config — STEEL vs LOCAL mode.** In STEEL mode the browser runs inside the Steel
container; UA/platform mismatches (e.g. UA claiming macOS on a Linux host) are Steel-side
config, not the MCP layer. Patchright guidance (channel:"chrome", headless:false, no custom
UA) can only be applied to Steel's own browser launch. In LOCAL mode the MCP launches
Chromium directly and now prefers `channel:"chrome"` (system Chrome) when available, falling
back to the bundled Chromium.
- `page.viewportSize()` / `page.setViewportSize({ width, height })`
- `page.screenshot(options)` — `PageScreenshotOptions`; `scale` is `'css'|'device'` not numeric
- `page.goto(url, { waitUntil: "domcontentloaded" })` — use domcontentloaded not load
- `page.goBack/goForward({ waitUntil: "commit", timeout: 10000 })` — commit fires on URL change
- `page.waitForSelector(sel, { timeout })` / `page.waitForFunction(fn, arg, { timeout })`
- `page.click(sel, { timeout })` / `page.fill(sel, text)` / `page.type(sel, text)`
- `page.selectOption(sel, { value|label|index })` / `page.press(sel, key)`
- `page.evaluate(fn, arg)` — runs in browser context
- `page.on("dialog", ...)` — caught + auto-resolved by `handle_dialog` policy

**Tool registration:** `server.registerTool(name, {title, description, inputSchema, outputSchema?, annotations}, handler)` from `McpServer`.
Each call goes through the gated registrar in `src/tools/shared.ts`:
- `core` is always registered; other toolsets are gated by `--toolsets` / `TOOLSETS`.
- Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) per MCP best practice.
- JSON-returning tools include `outputSchema` → `structuredContent` for typed clients.
Every handler calls `await mgr.getPage()` (which auto-initialises) then works with the page.

**Available tools:**

All page-interacting tools accept an optional `tabId` parameter (omit for
current-active-tab behaviour; pass for concurrent-agent safety).

| Tool | Description |
|---|---|
| `list_tabs` | List tabs (filter by owner/profile/tabId). Replaces get_current_url. `idleSeconds` per tab |
| `new_tab` | Open a new tab (optional URL, owner, profile) |
| `close_tabs` | Close by tabId, owner, or both. Replaces close_tab + close_tabs_by_owner |
| `go_to_url` | Navigate + optional waitFor. `readPage` extracts content in same call. `disableMedia` blocks images/fonts/CSS. CAPTCHA wait-and-retry (15s CapSolver poll). Auto-detects bot walls + error loops |
| `click` | Click by `selector` or `ref` (snapshot eN). Optional `waitFor`/`waitForText`. `frame` targets an iframe. Reports navigation + snapshot-diff feedback |
| `fill` | Fill 1+ form fields by `selector` or `ref`. Auto-detects type (text/select/checkbox/radio). `frame` targets an iframe |
| `scroll` | Scroll up/down by `selector` or `ref`. `readAfterScroll` returns visible text in same call |
| `history` | Back, forward, or reload. Reports URL + title |
| `wait_for` | Wait for selector/text/textGone. Timeout shows page context. Accepts `ref` |
| `press_key` | Press a key or combo (Enter, Escape, Control+A). Optional `selector`/`ref` to focus first |
| `handle_dialog` | Pre-arm the dialog policy (`accept`/`dismiss`, optional `promptText`) before an action that triggers alert/confirm/prompt. Omit `action` to inspect current policy + last dialog |
| `upload_file` | Upload files via `<input type=file>` or a custom upload button (`viaChooser: true`). Absolute host paths only |
| `snapshot` | Page accessibility tree with `[ref=eN]` tokens. The preferred first look — refs feed `click`/`fill`/`get_attrs`/`extract` directly. `frame` targets an iframe; output appends a frames section. Default maxChars: 8K |
| `get_page_text` | Extract text (auto-selects main content area). `extractContent` for Readability article extraction. `format: "markdown"` via turndown. `matchAll` for lists. Default maxChars: 5K |
| `get_links` | Extract [{text, href}] with optional urlPattern filter. Accepts `ref` |
| `get_attrs` | Extract specific attributes from matched elements (by `selector` or `ref`) |
| `get_screenshot` | Screenshot (webp/jpeg/png, selector/clip/fullPage). Default outputMode: "file". Post-capture resize via @napi-rs/image (maxWidth, maxHeight, maxFileBytes) |
| `evaluate` | Run JS in page context, return JSON. maxChars cap (default 10K). outputMode: "file" for large output. `frame` targets an iframe |
| `get_console` | Browser console messages (filter by level) |
| `fetch_urls` | Batch-fetch 1–10 URLs in parallel. `mode: "auto"|"browser"|"http"` (impit TLS-impersonated fast-path with auto-escalation). Readability article extraction per URL |
| `extract` | Declarative structured extraction: CSS selector + field map → JSON. Accepts `ref` |
| `download_file` | Download URL to disk (handles attachments + inline binaries) |
| `cookies` | Get or set browser cookies. Filter by domain |
| `get_network` | Inspect request/response traffic (filter by urlPattern/resourceType/status). `body: true` or `requestId` fetches a single response body. Default limit: 30 |
| `credentials` | List/store/update/delete credentials (no args = list) |
| `use_credential` | Retrieve or auto-fill login form with stored credential |
| `captcha_status` | CapSolver balance + availability |
| `create_profile` | Create isolated BrowserContext. Auto-restores saved state |
| `list_profiles` | Active + saved profiles |
| `save_profile` | Persist cookies + localStorage to disk |
| `delete_profile` | Close profile context + tabs |
| `smoke_test` | Self-test: navigate, fingerprint, stealth, CapSolver checks. Headless-detection probe (sannysoft) |
| `start_browser` | Start browser, get Session Viewer + Interactive + Relay URLs |
| `stop_browser` | Stop browser (kills all tabs/profiles). `owner`+`force` override the multi-agent safety check |
| `act` | LLM-driven bounded micro-loop over a snapshot (1–5 steps). Gated on `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL` |
| `extract_ai` | LLM structured extraction from the current page (text or html, optional JSON Schema). Gated on `ACT_LLM_BASE_URL` + `ACT_LLM_MODEL` |

**Ref targeting.** `click`, `fill`, `scroll`, `wait_for`, `press_key`,
`get_attrs`, `extract`, and `upload_file` accept `ref: "eN"` in place of
`selector`. Refs come from `snapshot` and expire on navigation or page mutation —
take a fresh snapshot after either. Pass exactly one of `selector` or `ref`.
(`handle_dialog` accepts `tabId` + `owner` only — it has no `ref` or `force`.)

**Frame targeting.** `click`, `fill`, `scroll`, `wait_for`, `evaluate`, and `snapshot`
accept `frame: "<name>" | "<url-substring>" | "<0-based index>"` to target an iframe.
Child frames exclude the main frame; the index is 0-based within the child list. Use
`snapshot` (no selector) to enumerate available frames.

### Design principles for new tools

- **Budget awareness** — every tool that reads from the page must cap its output. Pick sensible defaults (`maxChars`, `maxEntries`, `limit`). Expose `outputMode: "file"` when size can unbounded-ly grow.
- **Structured over prose** — prefer returning JSON-shaped data over serialized text when the downstream agent will parse it anyway.
- **Dedup + sanitize** — collapse whitespace, strip fragments, first-non-empty-wins across duplicate hrefs (DOM-order yields headlines, not excerpts).
- **One call not N** — if an existing tool takes 3 exec to accomplish a common task, add an option to merge them (`go_to_url` gained `waitFor` for this reason).
- **Fail safely** — auto-detect Cloudflare/bot walls and return `isError: true`, don't swallow the response and let the agent silently scrape an empty page.
- **Search first, never guess URLs** — use extraction tools to discover links; never construct or guess URLs from patterns.
- **Wait for CAPTCHA before failing** — `go_to_url` polls CapSolver for up to 15s on CAPTCHA walls before returning `isError: true`, giving the solver time to complete.

---

### Snapshot-first interaction paradigm

The preferred read is `snapshot`, not `get_page_text`. Snapshot returns the
accessibility tree with stable `[ref=eN]` tokens; that structure is both
cheaper (no layout/walk costs) and more actionable — refs feed
`click`/`fill`/`scroll`/`wait_for`/`get_attrs`/`extract`/`press_key` directly.
Use `get_page_text` only when the agent needs the actual prose content of
an article (then `extractContent: true` + `format: "markdown"`).

Action tools emit a snapshot-diff line on success ("3 elements changed")
so the agent sees whether the click landed.

---

## Code Style

### TypeScript
- `strict: true`, target `ES2022`, `moduleResolution: "bundler"` (bun bundles to `.cjs`)
- Local imports use `.js` extension (required for the ESM module system): `import { foo } from "./helpers.js"`
- Cast caught errors: `const error = err as Error`

### Imports
Node built-ins → third-party → local:

```typescript
import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "patchright";
import { z } from "zod";

import { EnvSchema } from "./env.js";
```

### Tool handler pattern

```typescript
// All tools go through the gated registrar in src/tools/shared.ts. It wraps
// server.registerTool() with toolset filtering, annotations, optional
// outputSchema + structuredContent.
register({
  name: "tool_name",
  title: "Tool Name",
  toolset: "core",
  description: `Description.

CONTEXT BUDGET — one sentence about output size risk.`,
  inputSchema: { param: z.string().optional().describe("Description.") },
  outputSchema: { result: z.string().optional() },         // optional; enables structuredContent
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ param }) => {
    try {
      const page = await mgr.getPage();
      // ... do work ...
      await globalWait(env); // action tools only; not read-only tools
      return { content: [{ type: "text", text: "Result." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  },
});
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
Do **not** call it in read-only tools (get_screenshot, get_page_text, get_links,
get_console, wait_for). Controlled by `GLOBAL_WAIT_SECONDS` env var (default 0).

### Section comments

```typescript
// -----------------------------------------------------------------------------
// Section Name
// -----------------------------------------------------------------------------
```
