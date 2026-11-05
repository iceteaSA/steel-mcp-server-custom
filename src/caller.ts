import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export function errorForTool(
  result: CallToolResult,
  outputSchema?: Record<string, z.ZodType>,
): CallToolResult {
  if (!result.isError || !result.structuredContent || !outputSchema) return result;
  if (z.object(outputSchema).strict().safeParse(result.structuredContent).success) return result;
  // SDK clients check structured errors against the success schema too.
  const { structuredContent: _structuredContent, ...error } = result;
  return error;
}

export class NoCallerError extends Error {
  readonly code = "no_caller";
  readonly result: CallToolResult;

  constructor() {
    super(
      'no_caller: send params._meta["ai.opencode/sessionID"] on every tools/call; no shared fallback lane exists.',
    );
    this.result = {
      isError: true,
      structuredContent: { error: this.code },
      content: [{ type: "text", text: this.message }],
    };
  }
}
