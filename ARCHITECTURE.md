# Architecture

## Browser and tool ownership

The server provides MCP tools through stdio. `src/index.ts` parses the environment, makes `BrowserManager`, and connects the tools and transport.

`BrowserManager` owns tabs, browser profiles, dialog policy, network capture, console messages, request routes, and crash recovery. Tabs have integer IDs and optional owners. Page tools resolve these IDs through the ownership guard. Browser profiles use isolated browser contexts.

`src/tools/shared.ts` controls toolset registration and shared targeting. The `core` toolset is always active. The two AI tools also need an LLM endpoint and model.

## Settle path

1. Tab allocation attaches a `domcontentloaded` listener to each page.
2. The listener runs `SETTLE_INIT_SCRIPT` in the main JavaScript world. It does not call `addInitScript`.
3. The script sets `window.__steelSettle`, counts fetch/XHR operations, and monitors DOM mutations.
4. Action tools call `afterAction`, which calls `waitForSettled` and then `globalWait`.
5. `waitForSettled` probes the main world. If the counter is missing, it runs the script there and probes again.
6. `waitForFunction` polls for 0 in-flight requests and a minimum of 300 ms without DOM mutations.
7. The timeout is `SETTLE_TIMEOUT_MS`. A value of 0 disables this check. The helper catches navigation errors and timeouts.

Patchright runs init scripts through document interception. That path can break page WebSocket upgrades. Thus, the settle path uses `evaluate` after document load. The script and polling use the same world. The local headless WebSocket regression checks two document loads and echo messages.

The settle check is best-effort. It does not guarantee application readiness or count requests that finish before the script starts.

## Snapshot and output path

`src/snapshot.ts` captures accessibility trees and changes refs to `@eN`. It stores per-tab baselines for ref-insensitive action diffs. Extraction tools can target a frame through `resolveFrame`.

`writeToFile` applies the configured output-root check. Large outputs can use file mode. JSON tools provide output schemas and structured results where supported.

`PageTextStore` provides opt-in literal search and cursor continuation for snapshots and text. Tokens bind to the tool, tab, owner, URL, frame, selector, and query options. Continuation uses a stored capture, so page changes do not move the text between chunks. The cache has a five-minute lifetime, a 32-token limit, and a 1,000,000-character limit per capture.

The registrar fences every MCP text block through `fenceToolResult`. It removes invisible control characters and escapes forged fence delimiters. The aggregate text budget includes the fence and truncation notice. Structured data keeps its schema and carries untrusted provenance in `_meta`.

## Boundaries

The server uses Patchright directly for browser operations. Steel mode connects through CDP. Local mode launches a browser. Optional AI tools call an OpenAI-compatible endpoint. The cookie relay uses a different transport from stdio.
