import { randomUUID } from "node:crypto";

export function clipText(text: string, maxChars: number, offset = 0): string {
  let end = Math.min(text.length, offset + maxChars);
  if (
    end > offset &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    // A one-unit budget must advance past one complete character.
    end += end - offset === 1 ? 1 : -1;
  }
  return text.slice(offset, end);
}

interface Continuation {
  scope: string;
  text: string;
  offset: number;
  expires: number;
  hidden?: number;
}

export class PageTextStore {
  private readonly entries = new Map<string, Continuation>();

  clear(): void {
    this.entries.clear();
  }

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 32,
    private readonly ttlMs = 300000,
  ) {}

  read(
    text: string | undefined,
    options: { scope: string; maxChars: number; cursor?: string; query?: string; hidden?: number },
  ) {
    const { scope, cursor, query } = options;
    let { hidden } = options;
    const maxChars = options.maxChars;
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 64000) {
      throw new Error(
        "Paginated maxChars must be an integer from 1 to 64000. Use file mode for larger output.",
      );
    }
    if (query !== undefined && (!query.trim() || query.length > 256)) {
      throw new Error("query must contain 1 to 256 characters.");
    }
    for (const [key, value] of this.entries) {
      if (value.expires <= this.now()) this.entries.delete(key);
    }
    let offset = 0;
    let expires = this.now() + this.ttlMs;
    if (cursor !== undefined) {
      const stored = this.entries.get(cursor);
      if (!stored || stored.scope !== scope) {
        throw new Error(
          "Invalid, expired, or differently scoped cursor. Omit cursor to start again.",
        );
      }
      ({ text, offset, expires, hidden } = stored);
    } else {
      if (text === undefined) throw new Error("Missing initial page content.");
      if (text.length > 1000000)
        throw new Error(
          "Page exceeds the continuation cache limit. Scope with selector or use file mode.",
        );
      if (query !== undefined) {
        const needle = query.toLowerCase();
        text = text
          .split("\n")
          .filter((line) => line.toLowerCase().includes(needle))
          .join("\n");
      }
    }
    const document = text!;
    let end = Math.min(document.length, offset + maxChars);
    if (end < document.length) {
      const newline = document.lastIndexOf("\n", end - 1);
      if (newline >= offset) end = newline + 1;
    }
    const chunk = clipText(document, end - offset, offset);
    end = offset + chunk.length;
    let nextCursor: string | undefined;
    if (end < document.length) {
      nextCursor = randomUUID();
      this.entries.set(nextCursor, { scope, text: document, offset: end, expires, hidden });
      while (this.entries.size > this.capacity)
        this.entries.delete(this.entries.keys().next().value!);
    }
    const structuredContent = {
      text: chunk,
      totalChars: document.length,
      ...(nextCursor ? { nextCursor } : {}),
    };
    return {
      content: [
        {
          type: "text" as const,
          text: chunk + (nextCursor ? `\n[Continue with cursor: ${nextCursor}]` : ""),
        },
      ],
      structuredContent,
      ...(hidden !== undefined ? { _meta: { "steel/hidden": hidden } } : {}),
    };
  }
}
