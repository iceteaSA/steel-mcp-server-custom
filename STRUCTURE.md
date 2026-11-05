# Source structure

| Path | Responsibility |
|---|---|
| `src/index.ts` | Environment, registration, transport, and process lifecycle |
| `src/manager.ts` | Browser lifecycle, owner-tagged tabs, profiles, listeners, and recovery |
| `src/lanes.ts` | Caller contexts, queues for each tab, and bounded closure |
| `src/hidden-text.ts` | Read-path visibility policy and frame checks |
| `src/signin.ts` | Sign-in requests, grants, audit, and notifications |
| `src/handoff.ts` | Browser-wide handoff states, call scopes, viewer claim, and notifications |
| `src/tools/handoff.ts` | Agent request and bounded wait tools |
| `src/profile-store.ts` | Shared schema, queue for each file, merge, and atomic JSON writes |
| `src/untrusted.ts` | Output fences and unsafe-control removal |
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
| `scripts/` | Actual MCP tool-list dump and compatibility checks |
| `skill/SKILL.md` | Agent entry instructions |
| `skill/references/workflows.md` | Browser workflow instructions |
| `extension/` | Browser extension for cookie push |
| `docker/` | Container configuration and browser patches |
| `dist/` | Ignored build output with native sidecars |

Local TypeScript imports use `.js` extensions. Tool modules export `register` through `src/tools/index.ts`. This also applies to sign-in tools.
New tools use the shared registrar. The lane runtime adds its two control tools through that same registrar.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the settle path and ownership model.
