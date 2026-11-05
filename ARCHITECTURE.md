# Architecture

## Browser and tool ownership

The server supplies MCP tools through stdio. `src/index.ts` parses the environment, makes `BrowserManager`, and connects the tools and transport.

`BrowserManager` owns tabs, named state, dialog policy, network capture, console messages, request routes, and crash recovery.
`LaneRuntime` selects a caller context from `params._meta["ai.opencode/sessionID"]`. Lane mode is the default.
Tabs have global integer IDs. IDs from different lanes give an error before page access. Named `profile` values share the caller's context.
Compatibility mode (`STEEL_LANES=off`) keeps owner-tagged tabs and isolated contexts for named state.

`src/tools/shared.ts` controls toolset registration and shared targeting. The `core` toolset is always active. An LLM endpoint and model are necessary for the two AI tools.

`src/lanes.ts` orders calls for each tab and serializes named-state changes on queue key `0`.
Automatic and explicit closure use a bounded drain. Lane closure does not stop the shared browser or operator context.
Caller identity is necessary for credential mutations. `list_profiles` reports active use only for the caller.

## Sign-in state

`src/index.ts` makes one `SigninStore` for the MCP tools and HTTP server.
The caller uses `request_signin` when site sign-in state is necessary for a permitted task. The operator gives approval through Cookie Push.
The extension pushes only the approved request's site scope into its target `profile`. Results contain status and counts, not state values.

`src/profile-store.ts` owns the file schema, queue for each file, merge, and atomic JSON writer.
All saved-state writers use that queue. A stale browser snapshot cannot replace newer pushed values.
After persistence, live apply selects only lanes that hold the target `profile`. If none hold it, the next load reads the file.
Shutdown cancels pending requests, flushes state, and closes HTTP and WebSocket connections in the drain bound.

## Browser handoff

`src/handoff.ts` owns one browser-wide state machine and the current viewer claim.
The registrar stops admission before lane selection and suppresses late results from cancelled calls.
An async call scope records each operation's pages. After a 130-second drain, only unfinished operations' pages close.
Cancelled scopes cannot start more manager operations. A bounded operation keeps its page.

The lane sweeper stops when the handoff state is not `AGENT`.
The lane runtime sets each lane's last-activity time when `AGENT` resumes.

Steel's primary tab stays open in compatibility mode. CDP stops its active execution, and `fenced_not_closed` records that tab.

The HTTP server supplies an ownership token only from `/handoff/take`. Heartbeat and handback use that token and HTTP authentication.
`/handoff/take` supplies its result immediately in `DRAINING`. Authenticated WebSocket snapshots and `GET /handoff` report the change to `HUMAN`.
Heartbeat disconnection changes the state to `PAUSED`. Timers cannot give control to agents.

Handback ends the claim before CDP input release and cache removal in `RESYNC`.
All lane managers release only keys and buttons held through the server's input APIs.
The `releaseHumanInput` viewer hook has a five-second bound and a no-op default. The viewer lane must supply X-server input release.
The shared extraction store removes continuation captures.
The registrar checks for a new snapshot before ref use on each tab.

The future viewer adapter must check state and claim ownership. The server does not supply a viewer transport or image.

## Settle path

1. Tab allocation attaches a `domcontentloaded` listener to each page.
2. The listener runs `SETTLE_INIT_SCRIPT` in the main JavaScript world. It does not call `addInitScript`.
3. The script sets `window.__steelSettle`, counts fetch/XHR operations, and monitors DOM mutations.
4. Interaction tools call `afterAction`, which calls `waitForSettled` and then `globalWait`.
5. `waitForSettled` probes the main world. If the counter is missing, it runs the script there and probes again.
6. `waitForFunction` polls for 0 in-flight requests and a minimum of 300 ms without DOM mutations.
7. The timeout is `SETTLE_TIMEOUT_MS`. A value of 0 disables this check. The helper catches navigation errors and timeouts.

Patchright runs init scripts through document interception. That path can break page WebSocket upgrades. Thus, the settle path uses `evaluate` after document load. The script and polling use the same world. The local headless WebSocket regression checks two document loads and echo messages.

The settle check is best-effort. It does not guarantee application readiness or count requests that finish before the script starts.

## Snapshot and output path

`src/snapshot.ts` captures accessibility trees and changes refs to `@eN`. It stores per-tab baselines for ref-insensitive interaction diffs. Extraction tools can target a frame through `resolveFrame`.

`writeToFile` applies the configured output-root check. Large outputs can use file mode. JSON tools supply output schemas and structured results where available.

`PageTextStore` supplies opt-in literal search and cursor continuation for snapshots and text. Each token has a tool, tab, owner, URL, frame, selector, and query scope. Continuation uses a stored capture, so page changes do not move the text between chunks. The cache has a five-minute lifetime, a 32-token limit, and a 1,000,000-character limit for each capture.

The registrar fences each MCP text block through `fenceToolResult`. It removes invisible control characters and changes forged fence delimiters to text. Text and serialized structured data share one budget, with fences and truncation notices. Structured data keeps its schema and has untrusted provenance in `_meta`.

`src/hidden-text.ts` checks document and frame visibility for the read path.
`STEEL_HIDDEN_TEXT=drop` removes hidden text, `flag` marks it, and `off` disables that filter.
The guard does not change the page. `src/untrusted.ts` fences output and calls `stripUnsafeControls` in each mode.

All JSON-producing tools declare output schemas. The SDK validates structured results. Interception tests also check error shapes and send a malformed transport result to prove that the client rejects a schema mismatch. Arbitrary JSON from `evaluate` and `extract_ai` uses a `result` field. File mode reports a path without duplicating the large value inline.

Safety annotations give the hints for all modes of each tool. A tool with a file-writing or log-clearing mode is not read-only. Browser operations use conservative destructive hints because page code can change remote state.

## Boundaries

The server uses Patchright directly for browser operations. Steel mode connects through CDP. Local mode launches a browser. Optional AI tools call an OpenAI-compatible endpoint. The cookie relay uses a different transport from stdio.
