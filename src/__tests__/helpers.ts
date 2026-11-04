import { expect } from "bun:test";
import { chromium, type Page } from "patchright";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import { register as extraction } from "../tools/extraction.js";
import type { ToolSpec } from "../tools/shared.js";
import { fenceDelimiters } from "../untrusted.js";
import { chromiumPath } from "./browser-processes.js";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export function pageValue(value: unknown, tool: "cookies" | "get_network"): string {
  if (typeof value !== "string") throw new Error("Expected a fenced page string");
  const { open, close } = fenceDelimiters(tool);
  expect(value.startsWith(open)).toBe(true);
  expect(value.endsWith(close)).toBe(true);
  return value.slice(open.length, -close.length);
}
export async function readPathFixture() {
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox"],
  });
  return { browser, page: await browser.newPage() };
}
export function readPathTool(page: Page, name: string, mode = "drop", tabId = 9001) {
  const specs: ToolSpec[] = [];
  extraction(
    (s) => specs.push(s),
    { getPage: async () => page, resolveTab: () => tabId } as unknown as BrowserManager,
    EnvSchema.parse({ BROWSER_MODE: "local", STEEL_HIDDEN_TEXT: mode }),
  );
  return specs.find((s) => s.name === name)!;
}
