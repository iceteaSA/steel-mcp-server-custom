import type { Page } from "patchright";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { llmJson } from "../llm.js";
import { captureSnapshot } from "../snapshot.js";
import { actionFeedback } from "../utils.js";
import type { ToolRegistrar } from "./shared.js";
import { execClick, execFillField, execPressKey, execScroll, tabTarget } from "./shared.js";

const ACT_ACTION_SCHEMA = z.object({
  action: z.enum(["click", "fill", "press_key", "scroll", "done", "stuck"]),
  ref: z.string().optional(),
  value: z.string().optional(),
  reason: z.string(),
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
): Promise<string> {
  const { instruction, maxSteps, tabId, owner, force } = args;
  const page = await mgr.getPage({ tabId, owner, force });
  const resolvedTabId = mgr.resolveTab({ tabId, owner, force });
  const deadline = Date.now() + 60_000;

  const systemPrompt =
    "You drive a browser via an accessibility tree. Each element may have [ref=eN]. Given the user's instruction and the current tree, choose the SINGLE next action. Use the ref of the target element. action=done when the instruction is satisfied; action=stuck (with reason) if impossible. Only click/fill/press_key/scroll are available.";

  const steps: string[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (Date.now() > deadline) {
      steps.push(`step ${step}: timeout — 60s wall-clock cap reached`);
      break;
    }

    const snapshot = await captureSnapshot(page, resolvedTabId, { maxChars: 8000 });
    const userPrompt = `${instruction}\n\nCurrent page:\n${snapshot.text}`;

    const decision = await llmJson(env, {
      system: systemPrompt,
      user: userPrompt,
      schema: ACT_ACTION_SCHEMA,
    });

    if (decision.action === "done" || decision.action === "stuck") {
      steps.push(
        `step ${step}: ${decision.action}${decision.reason ? ` — ${decision.reason}` : ""}`,
      );
      break;
    }

    const start = Date.now();
    await executeAction(page, env, decision);
    const elapsed = Date.now() - start;
    const valuePart = decision.value !== undefined ? ` "${decision.value}"` : "";
    steps.push(
      `step ${step}: ${decision.action} ${decision.ref ?? ""}${valuePart} — ${decision.reason} (${elapsed}ms)`,
    );

    if (step === maxSteps) {
      steps.push(`reached maxSteps (${maxSteps}) without completing`);
    }
  }

  const feedback = await actionFeedback(page, resolvedTabId);
  if (feedback) steps.push(feedback);

  return steps.join("\n");
}

async function executeAction(
  page: Page,
  env: Env,
  decision: z.infer<typeof ACT_ACTION_SCHEMA>,
): Promise<void> {
  switch (decision.action) {
    case "click":
      await execClick(page, env, { ref: decision.ref });
      break;
    case "fill":
      if (decision.value === undefined) throw new Error("fill action requires a value");
      await execFillField(page, env, { ref: decision.ref, value: decision.value });
      break;
    case "press_key":
      if (decision.value === undefined) throw new Error("press_key action requires a value (key)");
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
}
