import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class NoCallerError extends Error {
  readonly code = "no_caller";
  readonly result: CallToolResult;

  constructor() {
    super('no_caller: send params._meta["ai.opencode/sessionID"] on every tools/call; no shared fallback lane exists.');
    this.result = {
      isError: true,
      structuredContent: { error: this.code },
      content: [{ type: "text", text: this.message }],
    };
  }
}
