// -----------------------------------------------------------------------------
// Tool registration wrapper + toolset gating (MCP best practices).
//
// Provides a type-safe registrar that wraps server.registerTool() with
// toolset filtering, annotations, optional outputSchema + structuredContent.
// -----------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Frame, Page } from "patchright";
import { z } from "zod";
import type { Env } from "../manager.js";
import {
  buildRadioSelector,
  detectFieldKind,
  detectFieldsInPage,
  interpretCheckboxValue,
} from "../helpers.js";
import { afterAction } from "../utils.js";
import { fenceToolResult } from "../untrusted.js";
import { LaneRuntime, type LaneOptions } from "../lanes.js";
import type { BrowserManager } from "../manager.js";
import { policyErrorResult } from "../site-policy.js";

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

export type Toolset =
  | "core"
  | "tabs"
  | "extract"
  | "media"
  | "network"
  | "auth"
  | "debug"
  | "ai"
  | "intercept";

export const ALL_TOOLSETS: readonly Toolset[] = [
  "core",
  "tabs",
  "extract",
  "media",
  "network",
  "auth",
  "debug",
  "ai",
  "intercept",
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

export type ToolRegistrar = ((spec: ToolSpec) => void) & {
  signin?: { store: Promise<import("../signin.js").SigninStore>; getCaller: () => string };
};

export interface RegistrarHandle {
  register: ToolRegistrar;
  manager?: BrowserManager;
  close?: () => Promise<void>;
  getCaller(): string;
  applyProfileUpdated(profile: string): Promise<boolean>;
  /** Number of tools actually registered (post-filter). */
  toolCount(): number;
}

export function makeRegistrar(
  server: McpServer,
  activeToolsets: ReadonlySet<Toolset>,
  lanes?: LaneOptions,
): RegistrarHandle {
  let count = 0;
  const runtime = lanes && lanes.env.STEEL_LANES === "on" ? new LaneRuntime(lanes) : undefined;

  const register = (spec: ToolSpec): void => {
    // "core" tools are always active; others are gated by the active set.
    if (spec.toolset !== "core" && !activeToolsets.has(spec.toolset)) return;

    const laneDescriptions: Record<string, string> = {
      new_tab:
        "Open a new tab in the caller's lane and return its global tab ID. owner is an optional label. A profile loads saved state into the lane's existing context. First binding requires a fresh context before browsing or stateful calls; otherwise lane_not_fresh. Empty about:blank tabs are allowed. Use close_lane, then open the profile first. One profile name per lane context; a different name returns lane_profile_conflict.",
      stop_browser:
        "Refuse while another lane is active. Otherwise close only the caller's lane, not the shared Steel session or operator context. force is accepted and ignored with a NOTE line.",
      create_profile:
        "Create a named profile in the caller's lane, take its exclusive lease, and restore saved cookies and localStorage. Return the initial tab ID. First binding requires a fresh context before browsing or stateful calls; otherwise lane_not_fresh. Empty about:blank tabs are allowed. Use close_lane, then open the profile first. One profile name per lane context; a different name returns lane_profile_conflict.",
      delete_profile:
        "Close the named profile's tabs in the caller's lane. Keep the lane context, live cookies/storage, and lease until lane closure. A successful delete disables autosave for that lease. removeSaved requires the caller's own lease: profile_busy for a different holder, profile_lease_required if no holder exists. Delete does not clear the lane's live context.",
      get_console:
        "Read console messages from the caller's lane. Filter by level, tabId, or owner label. clear removes only this lane's captured entries up to the read, regardless of filter. Maximum 500 buffered messages; default 50 returned.",
    };
    const descriptions: Record<string, string> = {
      owner: "Optional tab label in your lane. It grants no access to another lane.",
      tabId:
        "Global numeric tab ID in your lane. Omit for your lane's current tab. Foreign tabs return not_in_lane; closed or unknown IDs return lane_closed.",
      force: "Accepted and ignored in lane mode, with a NOTE line. Cannot bypass lane isolation.",
      profile:
        spec.name === "request_signin"
          ? "Saved state target. The request does not open a browser lane."
          : "Saved profile name. Loads state into the caller's lane context; all tabs in this lane share its storage.",
    };
    const inputSchema = runtime
      ? Object.fromEntries(
          Object.entries(spec.inputSchema).map(([key, schema]) => [
            key,
            descriptions[key] ? schema.describe(descriptions[key]) : schema,
          ]),
        )
      : spec.inputSchema;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: runtime ? (laneDescriptions[spec.name] ?? spec.description) : spec.description,
        inputSchema,
        outputSchema: spec.outputSchema,
        annotations: {
          title: spec.title,
          ...spec.annotations,
        },
      },
      // Handler type is intentionally loose — the SDK validates args at
      // runtime against inputSchema; compile-time narrowing would need
      // per-tool generics that defeat the wrapper's purpose.
      (async (args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) =>
        fenceToolResult(
          runtime
            ? await runtime.run(spec.name, args, extra?._meta, () => spec.handler(args))
            : (policyErrorResult(lanes?.manager.takePolicyError?.()) ??
                (await (async () => {
                  const result = await spec.handler(args);
                  await lanes?.manager.waitForPopups?.();
                  return policyErrorResult(lanes?.manager.takePolicyError?.()) ?? result;
                })())),
          spec.name,
        )) as Parameters<McpServer["registerTool"]>[2],
    );
    count++;
  };

  if (runtime) {
    register({
      name: "use_profile",
      title: "Use Profile",
      description:
        "Take an exclusive profile lease and restore saved cookies and storage into your lane. First binding requires a fresh context before browsing, cookie writes, scripts, uploads, downloads, or other stateful calls. Empty about:blank tabs are allowed. lane_not_fresh keeps current state: use close_lane, then open the profile first. The same bound name may continue. A different name returns lane_profile_conflict before lease admission. A busy profile returns its holder label and lease age. Close releases without saving unless autosave is true. delete_profile keeps the live context and lease.",
      toolset: "auth",
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        wait: z.number().min(0).max(120).optional(),
        autosave: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async ({ name }) => {
        const { tabId } = await runtime.manager.newTab(undefined, undefined, name);
        return { content: [{ type: "text", text: `Profile lease acquired. Tab ID: ${tabId}` }] };
      },
    });
    for (const name of ["list_lanes", "close_lane"] as const) {
      register({
        name,
        title: name === "list_lanes" ? "List Lanes" : "Close Lane",
        description:
          name === "list_lanes"
            ? "List lane callers, ages and tab counts. No page URLs are disclosed."
            : "Close your lane's tabs and context. Other lanes and the operator context remain open.",
        toolset: "core",
        inputSchema: {},
        ...(name === "list_lanes"
          ? {
              outputSchema: {
                lanes: z.array(
                  z.object({ caller: z.string(), ageSeconds: z.number(), tabCount: z.number() }),
                ),
              },
            }
          : {}),
        annotations: {
          readOnlyHint: name === "list_lanes",
          destructiveHint: name === "close_lane",
          idempotentHint: true,
          openWorldHint: false,
        },
        handler: () => runtime.control(name),
      });
    }
  }
  return {
    register,
    toolCount: () => count,
    getCaller: () => {
      if (!runtime) return "single-process";
      const caller = runtime.getCaller();
      return caller ?? "";
    },
    applyProfileUpdated: (profile) =>
      runtime
        ? runtime.applyProfileUpdated(profile)
        : (lanes?.manager.applyProfileUpdated(profile) ?? Promise.resolve(false)),
    ...(runtime ? { manager: runtime.manager, close: () => runtime.close() } : {}),
  };
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

  if (/^\d+$/.test(frame)) {
    const idx = parseInt(frame, 10);
    if (idx >= 0 && idx < frames.length) return frames[idx];
  } else {
    const byUrl = frames.find((f) => f.url().includes(frame));
    if (byUrl) return byUrl;
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
    // Strip leading "@" — compact snapshot format emits @eN; bare eN also accepted.
    const ref = args.ref!.startsWith("@") ? args.ref!.slice(1) : args.ref!;
    if (!/^(?:f\d+)?e\d+$/.test(ref)) {
      throw new Error(
        `Invalid ref "${args.ref}" — expected format e<digits> or @e<digits> (e.g. "e5" or "@e5").`,
      );
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

// ---------------------------------------------------------------------------
// Shared element executors — used by interaction tools and the act agent.
//
// Each function resolves ref/selector, performs the Playwright action on the
// resolved context, and calls afterAction() so the page is settled before the
// next observation. Errors bubble up to callers, which should decorate them
// for agent consumption.
// ---------------------------------------------------------------------------

export async function execClick(
  page: Page,
  env: Env,
  opts: { ref?: string; selector?: string; frame?: string; timeout?: number },
): Promise<void> {
  const sel = toSelector({ selector: opts.selector, ref: opts.ref });
  const ctx = resolveFrame(page, opts.frame);
  await ctx.locator(sel).click({ timeout: opts.timeout ?? 10000 });
  await afterAction(page, env);
}

export async function execFillField(
  page: Page,
  env: Env,
  opts: {
    ref?: string;
    selector?: string;
    value: string;
    frame?: string;
    timeout?: number;
    kind?: "text" | "check" | "radio" | "select" | "selectLabel" | "selectIndex";
    settle?: boolean;
  },
): Promise<void> {
  const sel = toSelector({ selector: opts.selector, ref: opts.ref });
  const ctx = resolveFrame(page, opts.frame);
  const timeout = opts.timeout ?? 10000;

  let kind = opts.kind;
  if (!kind) {
    // For CSS selectors, batch kind-detection via page.evaluate; aria-ref is
    // an internal Playwright engine, so inspect the element handle instead.
    let info: { tag: string; type: string } | null;
    if (sel.startsWith("aria-ref=")) {
      const handle = await ctx.locator(sel).elementHandle({ timeout });
      try {
        info = handle
          ? await handle.evaluate((el: Element) => ({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || "",
            }))
          : null;
      } finally {
        if (handle) await handle.dispose().catch(() => {});
      }
    } else {
      const map = await ctx.evaluate(detectFieldsInPage, [sel]);
      info = map[sel];
    }

    if (!info) {
      throw new Error(`Element not found: ${sel}`);
    }

    kind = detectFieldKind(info.tag, info.type);
  }

  switch (kind) {
    case "select":
      await ctx.locator(sel).selectOption(opts.value, { timeout });
      break;
    case "selectLabel":
      await ctx.locator(sel).selectOption({ label: opts.value }, { timeout });
      break;
    case "selectIndex": {
      const idx = parseInt(opts.value, 10);
      if (Number.isNaN(idx)) {
        throw new Error(`selectIndex expects numeric value, got "${opts.value}"`);
      }
      await ctx.locator(sel).selectOption({ index: idx }, { timeout });
      break;
    }
    case "check": {
      const intent = interpretCheckboxValue(opts.value);
      if (intent === "check") {
        await ctx.locator(sel).check({ timeout });
      } else if (intent === "uncheck") {
        await ctx.locator(sel).uncheck({ timeout });
      } else {
        const fullSel = buildRadioSelector(sel, opts.value);
        await ctx.locator(fullSel).check({ timeout });
      }
      break;
    }
    case "radio": {
      const fullSel = buildRadioSelector(sel, opts.value);
      await ctx.locator(fullSel).click({ timeout });
      break;
    }
    default:
      await ctx.locator(sel).fill(opts.value, { timeout });
  }

  if (opts.settle !== false) {
    await afterAction(page, env);
  }
}

export async function execPressKey(
  page: Page,
  env: Env,
  opts: { ref?: string; selector?: string; key: string; frame?: string },
): Promise<void> {
  const sel =
    opts.selector || opts.ref ? toSelector({ selector: opts.selector, ref: opts.ref }) : undefined;
  if (sel) {
    const ctx = resolveFrame(page, opts.frame);
    await ctx.locator(sel).focus({ timeout: 5000 });
  }
  await page.keyboard.press(opts.key);
  await afterAction(page, env);
}

export interface ScrollResult {
  before: number;
  after: number;
  pageHeight: number;
  viewportHeight: number;
}

export async function execScroll(
  page: Page,
  env: Env,
  opts: {
    ref?: string;
    selector?: string;
    direction: "up" | "down";
    pixels?: number;
    frame?: string;
  },
): Promise<ScrollResult> {
  const sel =
    opts.selector || opts.ref ? toSelector({ selector: opts.selector, ref: opts.ref }) : null;
  const ctx = resolveFrame(page, opts.frame);
  const dy = opts.direction === "up" ? -(opts.pixels ?? 500) : (opts.pixels ?? 500);

  let result: ScrollResult;
  if (sel && sel.startsWith("aria-ref=")) {
    result = await ctx.locator(sel).evaluate(
      (el, { yDelta }) => {
        const before = el.scrollTop;
        el.scrollBy({ left: 0, top: yDelta, behavior: "instant" as ScrollBehavior });
        return {
          before,
          after: el.scrollTop,
          pageHeight: el.scrollHeight,
          viewportHeight: el.clientHeight,
        };
      },
      { yDelta: dy },
    );
  } else {
    result = await ctx.evaluate(
      ({ yDelta, scrollSelector }: { yDelta: number; scrollSelector: string | null }) => {
        if (scrollSelector) {
          const el = document.querySelector(scrollSelector);
          if (!el) throw new Error(`Scroll target "${scrollSelector}" not found`);
          const before = el.scrollTop;
          el.scrollBy({ left: 0, top: yDelta, behavior: "instant" as ScrollBehavior });
          return {
            before,
            after: el.scrollTop,
            pageHeight: el.scrollHeight,
            viewportHeight: el.clientHeight,
          };
        }
        const before = window.scrollY;
        window.scrollBy({ left: 0, top: yDelta, behavior: "instant" as ScrollBehavior });
        return {
          before,
          after: window.scrollY,
          pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
          viewportHeight: window.innerHeight,
        };
      },
      { yDelta: dy, scrollSelector: sel },
    );
  }

  await afterAction(page, env);
  return result;
}

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
