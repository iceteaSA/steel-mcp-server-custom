import type { BrowserManager, Env } from "../manager.js";
import { z } from "zod";
import { extractPageContent as defaultExtractPageContent } from "../helpers.js";
import { llmJson as defaultLlmJson } from "../llm.js";
import { captureSnapshot as defaultCaptureSnapshot } from "../snapshot.js";
import {
  actionFeedback as defaultActionFeedback,
  writeToFile as defaultWriteToFile,
} from "../utils.js";
import type { ToolRegistrar } from "./shared.js";
import {
  execClick as defaultExecClick,
  execFillField as defaultExecFillField,
  execPressKey as defaultExecPressKey,
  execScroll as defaultExecScroll,
  tabTarget,
} from "./shared.js";

// Dependency-injection seam. Production code uses the defaults; tests pass
// mocks through this object instead of mutating the global module registry
// via bun's mock.module() — which leaks into other test files when they
// share a process. See src/__tests__/act.test.ts for usage.
export interface RunActDeps {
  captureSnapshot?: typeof defaultCaptureSnapshot;
  llmJson?: typeof defaultLlmJson;
  actionFeedback?: typeof defaultActionFeedback;
  execClick?: typeof defaultExecClick;
  execFillField?: typeof defaultExecFillField;
  execPressKey?: typeof defaultExecPressKey;
  execScroll?: typeof defaultExecScroll;
}

export interface RunExtractAiDeps {
  extractPageContent?: typeof defaultExtractPageContent;
  llmJson?: typeof defaultLlmJson;
  writeToFile?: typeof defaultWriteToFile;
}

// reason is optional-but-encouraged. Strict models (e.g. gemma-4) sometimes
// return a valid action without it; making it required breaks act entirely
// for those models on the most common case. Default to "" so downstream
// transcript rendering stays a single string concat.
const ACT_ACTION_SCHEMA = z.object({
  action: z.enum(["click", "fill", "press_key", "scroll", "done", "stuck"]),
  ref: z.string().optional(),
  value: z.string().optional(),
  reason: z.string().default(""),
});

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  register({
    name: "act",
    title: "Act via LLM",
    description: `Execute a natural-language browser instruction through a bounded LLM micro-loop. The model sees an accessibility snapshot of the page and chooses one action per step (click, fill, press_key, scroll). Stops at done/stuck or when maxSteps is reached.

CONTEXT BUDGET — returns a plain-text transcript; each step is one line.`,
    toolset: "ai",
    inputSchema: {
      instruction: z.string().describe("What the agent should accomplish on the current page."),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(1)
        .describe("Maximum number of LLM-chosen actions to execute. Default: 1."),
      ...tabTarget,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const transcript = await runAct(args, mgr, env);
        return { content: [{ type: "text", text: transcript }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  });

  // extract_ai ----------------------------------------------------------------
  register({
    name: "extract_ai",
    title: "Extract via LLM",
    description: `Extract structured data from the current page using an LLM. Provide an optional JSON Schema to constrain the output shape. Reads the page content area (text or HTML) and returns only the requested JSON.

CONTEXT BUDGET — returns JSON inline unless it exceeds MAX_INLINE_BYTES, then it writes to a file and returns the path.`,
    toolset: "ai",
    inputSchema: {
      instruction: z.string().describe("What data to extract from the page."),
      schema: z
        .string()
        .optional()
        .describe("JSON Schema (object) for the output shape. Omit for free-form object."),
      format: z
        .enum(["text", "html"])
        .default("text")
        .describe("Whether to send the page as extracted text or cleaned outerHTML."),
      ...tabTarget,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const { text, structuredContent, filePath } = await runExtractAi(args, mgr, env);
        if (filePath) {
          return {
            content: [{ type: "text", text: `Saved to ${filePath}` }],
            structuredContent,
          };
        }
        return {
          content: [{ type: "text", text }],
          structuredContent,
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  });
}

export async function runAct(
  args: {
    instruction: string;
    maxSteps: number;
    tabId?: number;
    owner?: string;
    force?: boolean;
  },
  mgr: BrowserManager,
  env: Env,
  deps: RunActDeps = {},
): Promise<string> {
  const captureSnapshot = deps.captureSnapshot ?? defaultCaptureSnapshot;
  const llmJson = deps.llmJson ?? defaultLlmJson;
  const actionFeedback = deps.actionFeedback ?? defaultActionFeedback;
  const execClick = deps.execClick ?? defaultExecClick;
  const execFillField = deps.execFillField ?? defaultExecFillField;
  const execPressKey = deps.execPressKey ?? defaultExecPressKey;
  const execScroll = deps.execScroll ?? defaultExecScroll;

  const { instruction, maxSteps, tabId, owner, force } = args;
  const page = await mgr.getPage({ tabId, owner, force });
  const resolvedTabId = mgr.resolveTab({ tabId, owner, force });
  const startedAt = Date.now();
  const WALL_CAP_MS = 60_000;

  const systemPrompt =
    "You drive a browser via an accessibility tree. Each element may have [ref=eN]. Given the user's instruction and the current tree, choose the SINGLE next action. Use the ref of the target element. action=done when the instruction is satisfied; action=stuck if impossible. Only click/fill/press_key/scroll are available. Include a short `reason` string explaining the choice when useful — it is optional but encouraged for transparency.";

  const steps: string[] = [];

  function elapsedMs(): number {
    return Date.now() - startedAt;
  }

  function remainingMs(): number {
    return Math.max(1, WALL_CAP_MS - elapsedMs());
  }

  function checkCap(label: string): void {
    if (elapsedMs() >= WALL_CAP_MS) {
      steps.push(`${label}: reached 60s wall cap`);
      throw new Error([...steps, "Failure: reached 60s wall cap"].join("\n"));
    }
  }

  try {
    for (let step = 1; step <= maxSteps; step++) {
      checkCap(`step ${step}`);

      const snapshot = await captureSnapshot(page, resolvedTabId, { maxChars: 8000 });
      const userPrompt = `${instruction}\n\nCurrent page:\n${snapshot.text}`;

      const decision = await llmJson(env, {
        system: systemPrompt,
        user: userPrompt,
        schema: ACT_ACTION_SCHEMA,
        timeoutMs: remainingMs(),
      });

      if (decision.action === "done" || decision.action === "stuck") {
        steps.push(
          `step ${step}: ${decision.action}${decision.reason ? ` — ${decision.reason}` : ""}`,
        );
        break;
      }

      checkCap(`step ${step}`);
      const valuePart = decision.value !== undefined ? ` "${decision.value}"` : "";
      const reasonPart = decision.reason ? ` — ${decision.reason}` : "";
      const stepLine = `step ${step}: ${decision.action} ${decision.ref ?? ""}${valuePart}${reasonPart}`;
      steps.push(stepLine);
      const actionStart = Date.now();
      switch (decision.action) {
        case "click":
          await execClick(page, env, { ref: decision.ref });
          break;
        case "fill":
          if (decision.value === undefined) throw new Error("fill action requires a value");
          await execFillField(page, env, { ref: decision.ref, value: decision.value });
          break;
        case "press_key":
          if (decision.value === undefined)
            throw new Error("press_key action requires a value (key)");
          await execPressKey(page, env, { ref: decision.ref, key: decision.value });
          break;
        case "scroll": {
          const direction = decision.value === "up" ? "up" : "down";
          await execScroll(page, env, { ref: decision.ref, direction });
          break;
        }
        default:
          throw new Error(`Unknown action: ${decision.action}`);
      }
      const actionElapsed = Date.now() - actionStart;
      steps[steps.length - 1] = `${stepLine} (${actionElapsed}ms)`;

      if (step === maxSteps) {
        steps.push(`reached maxSteps (${maxSteps}) without completing`);
      }
    }

    const feedback = await actionFeedback(page, resolvedTabId);
    if (feedback) steps.push(feedback);

    return steps.join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    // Avoid duplicating the transcript when the error already includes it.
    if (message.includes(steps.join("\n"))) {
      throw err;
    }
    steps.push(`Failure: ${message}`);
    throw new Error(steps.join("\n"));
  }
}

// -----------------------------------------------------------------------------
// extract_ai — LLM structured extraction with optional JSON Schema validation
// -----------------------------------------------------------------------------

/**
 * Convert a small subset of JSON Schema into a Zod type.
 * Supports: object, array, string, number, boolean, nullable unions, nested.
 * Rejects unsupported keywords with a clear error naming the keyword.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
  if (schema === null || typeof schema !== "object") {
    throw new Error("JSON Schema must be an object.");
  }
  const s = schema as Record<string, unknown>;

  const unsupported = new Set([
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "enum",
    "anyOf",
    "oneOf",
    "allOf",
    "$ref",
    "additionalProperties",
  ]);
  for (const key of Object.keys(s)) {
    if (unsupported.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword: ${key}`);
    }
  }

  const rawType = s.type;
  const types: string[] = Array.isArray(rawType)
    ? (rawType as string[])
    : rawType
      ? [rawType as string]
      : [];

  let base: z.ZodType | undefined;
  for (const t of types) {
    let next: z.ZodType;
    switch (t) {
      case "string":
        next = z.string();
        break;
      case "number":
      case "integer":
        next = z.number();
        break;
      case "boolean":
        next = z.boolean();
        break;
      case "null":
        next = z.null();
        break;
      case "array": {
        const items = s.items;
        const itemSchema =
          items && typeof items === "object" ? jsonSchemaToZod(items) : z.unknown();
        next = z.array(itemSchema);
        break;
      }
      case "object": {
        const props = (s.properties as Record<string, unknown>) ?? {};
        const required = new Set((s.required as string[]) ?? []);
        const shape: Record<string, z.ZodType> = {};
        for (const [key, val] of Object.entries(props)) {
          const field = jsonSchemaToZod(val);
          shape[key] = required.has(key) ? field : field.optional();
        }
        next = z.object(shape);
        break;
      }
      default:
        next = z.unknown();
    }
    base = base ? z.union([base, next]) : next;
  }

  return base ?? z.unknown();
}

/**
 * Extract content from the current page, prompt an LLM to produce structured
 * data, validate it against an optional JSON Schema, and return pretty JSON.
 * Falls back to file mode when the output exceeds env.MAX_INLINE_BYTES.
 */
export async function runExtractAi(
  args: {
    instruction: string;
    schema?: string;
    format: "text" | "html";
    tabId?: number;
    owner?: string;
    force?: boolean;
  },
  mgr: BrowserManager,
  env: Env,
  deps: RunExtractAiDeps = {},
): Promise<{ text: string; structuredContent: unknown; filePath?: string }> {
  const extractPageContent = deps.extractPageContent ?? defaultExtractPageContent;
  const llmJson = deps.llmJson ?? defaultLlmJson;
  const writeToFile = deps.writeToFile ?? defaultWriteToFile;

  const { instruction, schema: schemaJson, format } = args;
  const page = await mgr.getPage({ tabId: args.tabId, owner: args.owner, force: args.force });

  let content = "";
  if (format === "text") {
    const result = await page.evaluate(extractPageContent, {
      selector: null,
      includeLinks: false,
      mode: "innerText" as const,
    });
    content = result.text ?? "";
  } else {
    content = await page.evaluate(() => {
      const CONTENT_AREA_SELECTORS = ["main", "article", '[role="main"]', "body"] as const;
      const d = document;
      let root: Element | null = null;
      for (const s of CONTENT_AREA_SELECTORS) {
        if (s === "body") {
          root = d.body;
          break;
        }
        const el = d.querySelector(s);
        if (el && (el.textContent?.trim().length ?? 0) > 100) {
          root = el;
          break;
        }
      }
      if (!root) root = d.body;
      if (!root) return "";
      let html = root.outerHTML;
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
      html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
      html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ");
      html = html.replace(/<!--[\s\S]*?-->/g, " ");
      return html.replace(/\s+/g, " ").trim();
    });
  }

  const maxContent = 20_000;
  if (content.length > maxContent) {
    content = content.slice(0, maxContent) + "\n[TRUNCATED — content capped at 20000 chars]";
  }

  const builtSchema = schemaJson
    ? jsonSchemaToZod(JSON.parse(schemaJson))
    : z.record(z.string(), z.unknown());

  const systemPrompt =
    "Extract structured data from the page content per the user's instruction. Return ONLY JSON matching the requested shape.";
  const userPrompt = [
    instruction,
    schemaJson ? `\nSchema:\n${schemaJson}` : "",
    "\n\nPage content:\n",
    content,
  ].join("");

  const parsed = await llmJson(env, {
    system: systemPrompt,
    user: userPrompt,
    schema: builtSchema,
  });

  const text = JSON.stringify(parsed, null, 2);

  if (Buffer.byteLength(text) > env.MAX_INLINE_BYTES) {
    const filePath = await writeToFile(text, "extract_ai_result.json", env);
    return { text: filePath, structuredContent: parsed, filePath };
  }

  return { text, structuredContent: parsed };
}
