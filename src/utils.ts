// -----------------------------------------------------------------------------
// utils.ts — Shared utility functions used across tool files.
//
// Extracted from manager.ts. Imported by tools/*.ts.
// -----------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import type { Page } from "playwright";
import type { BrowserManager, Env } from "./manager.js";
import { waitForSettled } from "./settle.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function globalWait(env: Pick<Env, "GLOBAL_WAIT_SECONDS">): Promise<void> {
  if (env.GLOBAL_WAIT_SECONDS > 0) {
    await sleep(env.GLOBAL_WAIT_SECONDS * 1000);
  }
}

/**
 * Post-action wait: settle detection (network idle + DOM quiet) followed by
 * the configurable global wait.  Call this from every action tool after the
 * action completes, replacing the bare `await globalWait(env)`.
 */
export async function afterAction(page: Page, env: Env): Promise<void> {
  await waitForSettled(page, env);
  await globalWait(env);
}

/**
 * Open a temporary background tab, run `fn(page, tabId)` on it, and close
 * the tab in `finally`.  The tab never becomes the active tab
 * (`activate:false`), so the caller's active-tab pointer is preserved even
 * when other tabs exist.
 *
 * Used by `download_file` and `fetch_urls` — both need a throw-safe temp
 * tab that doesn't move the active pointer under the caller.
 */
export async function withBackgroundTab<T>(
  mgr: BrowserManager,
  fn: (page: Page, tabId: number) => Promise<T>,
): Promise<T> {
  const { tabId, page } = await mgr.newTab(undefined, undefined, undefined, false);
  try {
    return await fn(page, tabId);
  } finally {
    await mgr.closeTab(tabId).catch(() => {});
  }
}

export async function writeToFile(
  data: Buffer | string,
  defaultName: string,
  env: Pick<Env, "OUTPUT_DIR">,
  outputPath?: string,
): Promise<string> {
  const filePath = outputPath ?? path.join(env.OUTPUT_DIR, defaultName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return filePath;
}
