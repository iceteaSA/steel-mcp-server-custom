// -----------------------------------------------------------------------------
// Tool registration wrapper + toolset gating (MCP best practices A8 + A9).
//
// Provides a type-safe registrar that wraps server.registerTool() with
// toolset filtering, annotations, optional outputSchema + structuredContent.
// -----------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Frame, Page } from "patchright";
import { z } from "zod";

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
        annotations: {
          title: spec.title,
          ...spec.annotations,
        },
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
// Shared tab-targeting zod fragments
//
// Read-only tools spread `tabTarget`; action tools spread `tabTargetForce`
// (which adds the `force` ownership-override flag). Each page-interacting
// tool passes these through to mgr.getPage({tabId, owner, force}).
// -----------------------------------------------------------------------------

export const tabTarget = {
  tabId: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Target tab id. Omit to use your owner's last-used tab (or the global active tab if no owner given).",
    ),
  owner: z
    .string()
    .optional()
    .describe(
      "Your agent identity (same string you passed to new_tab). Scopes tab resolution and ownership checks.",
    ),
};

export const tabTargetForce = {
  ...tabTarget,
  force: z.boolean().optional().describe("Override the tab-ownership guard."),
};

// -----------------------------------------------------------------------------
// resolveToolsets — CLI + env → validated Set<Toolset>
//
// Precedence: --toolsets a,b  >  TOOLSETS env  >  all toolsets.
// "core" is always force-included.
// Unknown names throw with the list of valid names.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// toSelector — resolve {selector, ref} to a CSS selector string.
//
// Exactly one of selector or ref must be provided.  ref format: e<digits>
// (e.g. "e5").  Returns aria-ref=${ref} or the raw selector unchanged.
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveFrame — pick a frame by name, URL substring, or child-frame index
// ---------------------------------------------------------------------------

export function resolveFrame(page: Page, frame?: string): Frame | Page {
  if (frame === undefined) return page;

  const frames = page.frames().slice(1);

  // (a) exact name match
  const byName = frames.find((f) => f.name() === frame);
  if (byName) return byName;

  // (b) URL substring match
  const byUrl = frames.find((f) => f.url().includes(frame));
  if (byUrl) return byUrl;

  // (c) child-frame index (0-based, excludes main frame)
  if (/^\d+$/.test(frame)) {
    const idx = parseInt(frame, 10);
    if (idx >= 0 && idx < frames.length) return frames[idx];
  }

  const list = frames.map((f, i) => `[${i}] name="${f.name()}" url=${f.url()}`).join("\n");
  throw new Error(`No frame matches "${frame}". Available frames:\n${list || "(none)"}`);
}

// Shared zod fragment for the frame param used by page-interacting tools.
export const frameTarget = {
  frame: z
    .string()
    .optional()
    .describe(
      "Target an iframe by name, URL substring, or child-frame index (0-based, excludes the main frame). Omit for the main page.",
    ),
};

export function toSelector(args: { selector?: string; ref?: string }): string {
  const hasSelector = args.selector !== undefined && args.selector !== "";
  const hasRef = args.ref !== undefined && args.ref !== "";

  if (!hasSelector && !hasRef) {
    throw new Error("Pass selector or ref (from snapshot).");
  }
  if (hasSelector && hasRef) {
    throw new Error("Pass selector OR ref, not both.");
  }

  if (hasRef) {
    const ref = args.ref!;
    if (!/^e\d+$/.test(ref)) {
      throw new Error(`Invalid ref "${ref}" — expected format e<digits> (e.g. "e5").`);
    }
    return `aria-ref=${ref}`;
  }

  return args.selector!;
}

// -----------------------------------------------------------------------------
// decorateRefError — append a "stale ref" hint when an aria-ref query fails.
// -----------------------------------------------------------------------------

const ARIA_REF_PREFIX = "aria-ref=";

export function decorateRefError(err: unknown, usedSelector: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (!usedSelector.startsWith(ARIA_REF_PREFIX)) return raw;

  const isTimeoutOrNotFound = /timeout|not found|not exist|not visible|not attached|waiting/i.test(
    raw,
  );

  if (isTimeoutOrNotFound) {
    return raw + " Ref may be stale — take a fresh snapshot.";
  }
  return raw;
}

// -----------------------------------------------------------------------------
// resolveToolsets — CLI + env → validated Set<Toolset>
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
