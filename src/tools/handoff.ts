import { z } from "zod";
import type { ToolRegistrar } from "./shared.js";
import type { BrowserManager, Env } from "../manager.js";

export function register(register: ToolRegistrar, _manager: BrowserManager, _env: Env): void {
  const outputSchema = {
    id: z.string().optional(),
    state: z.enum(["AGENT", "HUMAN_REQUESTED", "DRAINING", "HUMAN", "RESYNC", "PAUSED"]).optional(),
    status: z.enum(["human_done", "human_declined", "paused", "timeout"]).optional(),
    reason: z.string().optional(),
    tabId: z.number().optional(),
    error: z.string().optional(),
    closedTabIds: z.array(z.number()).optional(),
    fenced_not_closed: z.array(z.number()).optional(),
    requestedTabClosed: z.boolean().optional(),
    requests: z
      .array(
        z.object({
          id: z.string(),
          agent: z.string(),
          reason: z.string(),
          tabId: z.number().optional(),
          created: z.number(),
        }),
      )
      .optional(),
  };
  for (const name of ["request_human", "wait_for_human"] as const)
    register({
      name,
      title: name === "request_human" ? "Request Human" : "Wait for Human",
      description:
        name === "request_human"
          ? "Ask the operator to take browser-wide control. Return a request ID at once. The operator must take control explicitly."
          : "Wait at most 120 seconds for human_done, human_declined, paused, or timeout. After human_done, read the page again; old refs are invalid.",
      toolset: "core",
      outputSchema,
      inputSchema:
        name === "request_human"
          ? { reason: z.string().min(1).max(1000), tabId: z.number().int().min(1).optional() }
          : { timeout: z.number().min(0).max(120).default(120) },
      annotations: {
        readOnlyHint: name === "wait_for_human",
        destructiveHint: false,
        idempotentHint: name === "wait_for_human",
        openWorldHint: false,
      },
      handler: async (args) => {
        try {
          const binding = register.handoff;
          if (!binding) throw new Error("handoff_unavailable");
          const caller = binding.getCaller();
          const value =
            name === "request_human"
              ? binding.controller.request(caller, args, binding.getAgent())
              : await binding.controller.wait(caller, args.timeout);
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          const code = error instanceof Error ? error.message : "handoff_unavailable";
          return {
            isError: true,
            content: [{ type: "text", text: code }],
            structuredContent: { error: code },
          };
        }
      },
    });
}
