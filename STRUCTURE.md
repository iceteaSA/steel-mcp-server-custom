# Source structure

| Path | Responsibility |
|---|---|
| `src/index.ts` | Environment, registration, transport, and process lifecycle |
| `src/manager.ts` | Browser lifecycle, owner-tagged tabs, profiles, listeners, and recovery |
| `src/env.ts` | Validated environment schema and derived paths |
| `src/tools/` | Tool groups and the shared registrar, ref resolver, and frame resolver |
| `src/snapshot.ts` | Accessibility capture, filtering, baseline storage, and diffs |
| `src/settle.ts` | Settle counter script and bounded polling |
| `src/utils.ts` | Post-action waits, feedback, temporary tabs, and file output |
| `src/helpers.ts` | Extraction, detection, validation, and path-containment helpers |
| `src/llm.ts` | Optional LLM client |
| `src/relay.ts` | Authenticated cookie relay |
| `src/crypto.ts`, `src/credentials-store.ts` | Credential storage and encryption |
| `src/__tests__/` | Bun unit tests and local regression tests |
| `scripts/` | Actual MCP tool-list dump and compatibility comparison |
| `skill/SKILL.md` | Agent entry instructions |
| `skill/references/workflows.md` | Detailed browser workflows |
| `extension/` | Browser extension for cookie push |
| `docker/` | Container configuration and browser patches |
| `dist/` | Ignored build output, including native sidecars |

Local TypeScript imports use `.js` extensions. Tool modules export registration functions through `src/tools/index.ts`. New tools use the shared registrar.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the settle path and ownership model.
