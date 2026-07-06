// -----------------------------------------------------------------------------
// Tool registration wrapper + toolset gating (MCP best practices A8 + A9).
//
// Provides a type-safe registrar that wraps server.registerTool() with
// toolset filtering, annotations, optional outputSchema + structuredContent.
// -----------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

// Re-exported because @modelcontextprotocol/sdk 1.29 doesn't re-export
// ToolAnnotations from the server/mcp module.
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// -----------------------------------------------------------------------------
// Toolsets
// -----------------------------------------------------------------------------

export type Toolset = "core" | "tabs" | "extract" | "media" | "network" | "auth" | "debug";

export const ALL_TOOLSETS: readonly Toolset[] = [
  "core",
  "tabs",
  "extract",
  "media",
  "network",
  "auth",
  "debug",
] as const;

// -----------------------------------------------------------------------------
// ToolSpec — the shape each tool registration must provide
// -----------------------------------------------------------------------------

export interface ToolSpec {
  /** SDK tool name (snake_case verb_noun). */
  name: string;
  /** Human-readable title shown in tool listings. */
  title: string;
  /** Description — what / when to use / what it returns / when NOT to use. */
  description: string;
  /** Logical toolset group for --toolsets filtering. */
  toolset: Toolset;
  /** Raw Zod shape for input parameters (e.g. `{ url: z.string() }`). */
  inputSchema: Record<string, z.ZodType>;
  /** Optional output schema for structuredContent tools. */
  outputSchema?: Record<string, z.ZodType>;
  /** Tool annotations (readOnlyHint, destructiveHint, etc.). */
  annotations: ToolAnnotations;
  /** Async handler. Receives validated input args; returns CallToolResult. */
  handler: (args: any) => Promise<any>;
}

// -----------------------------------------------------------------------------
// makeRegistrar — build a gated registration function from server + active set
// -----------------------------------------------------------------------------

export type ToolRegistrar = (spec: ToolSpec) => void;

export interface RegistrarHandle {
  register: ToolRegistrar;
  /** Number of tools actually registered (post-filter). */
  toolCount(): number;
}

export function makeRegistrar(
  server: McpServer,
  activeToolsets: ReadonlySet<Toolset>,
): RegistrarHandle {
  let count = 0;

  const register = (spec: ToolSpec): void => {
    // "core" tools are always active; others are gated by the active set.
    if (spec.toolset !== "core" && !activeToolsets.has(spec.toolset)) return;

    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: spec.outputSchema,
        annotations: spec.annotations,
      },
      // Handler type is intentionally loose — the SDK validates args at
      // runtime against inputSchema; compile-time narrowing would need
      // per-tool generics that defeat the wrapper's purpose.
      spec.handler as Parameters<McpServer["registerTool"]>[2],
    );
    count++;
  };

  return { register, toolCount: () => count };
}

// -----------------------------------------------------------------------------
// resolveToolsets — CLI + env → validated Set<Toolset>
//
// Precedence: --toolsets a,b  >  TOOLSETS env  >  all toolsets.
// "core" is always force-included.
// Unknown names throw with the list of valid names.
// -----------------------------------------------------------------------------

export function resolveToolsets(
  cliArg: string | undefined,
  envVal: string | undefined,
): Set<Toolset> {
  const raw = cliArg ?? envVal;
  if (!raw) {
    // Default: all toolsets active.
    return new Set(ALL_TOOLSETS);
  }

  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const valid = new Set<string>(ALL_TOOLSETS);
  const invalid = names.filter((n) => !valid.has(n));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid toolset(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLSETS.join(", ")}.`,
    );
  }

  const set = new Set(names) as Set<Toolset>;
  set.add("core"); // always active, regardless of input
  return set;
}
