/// <reference lib="es2024.string" />

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";

export function callerKey(id: string): string {
  return Buffer.byteLength(id, "utf8") > 128
    ? `long:${createHash("sha256").update(id).digest("hex")}`
    : `short:${id}`;
}

export function callerLabel(key: string): string {
  return key.startsWith("long:") ? `sha256:${key.slice(5, 21)}` : key.slice(6);
}

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
