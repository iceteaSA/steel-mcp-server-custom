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
import {
  captureSnapshot,
  storeSnapshot,
  getStoredSnapshot,
  diffSnapshots,
  truncateAtLine,
} from "./snapshot.js";

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

// -----------------------------------------------------------------------------
// actionFeedback — snapshot-diff feedback on action tools
// -----------------------------------------------------------------------------

export async function actionFeedback(
  page: Page,
  tabId: number,
  opts?: { navigated?: boolean; silent?: boolean },
): Promise<string> {
  try {
    if (opts?.navigated) {
      // Store the full untruncated tree so future same-page diffs have a
      // consistent baseline (truncated store → phantom diffs on later 8K captures).
      const snap = await captureSnapshot(page, tabId, { noTruncate: true });
      storeSnapshot(tabId, snap.text);
      if (opts?.silent) return "";
      // Display baseline capped at 3K chars — store carries the full tree.
      const display = truncateAtLine(snap.text, 3000).text;
      return `\n--- new page (baseline snapshot) ---\n${display}`;
    }

    const stored = getStoredSnapshot(tabId);
    if (!stored) {
      // No stored snapshot → the agent hasn't opted in via snapshot or navigation.
      // Return empty — do NOT seed the store on first action (avoids spamming
      // agents who never asked for snapshots + saves an ariaSnapshot capture).
      return "";
    }

    // Guard: pathological pages (>1500 lines) skip the diff to avoid the
    // O(n*m) LCS DP path (diffSnapshots already falls back internally, but the
    // ariaSnapshot capture itself is expensive on huge pages).
    const storedLineCount = stored.split("\n").length;
    if (storedLineCount > 1500) return "";

    // Same page, has prior snapshot — capture full, diff full, store new.
    // Both stored and fresh are untruncated so diffs never show phantom + lines.
    const fresh = await captureSnapshot(page, tabId, { noTruncate: true });
    const diff = diffSnapshots(stored, fresh.text, { maxChars: 2000 });
    storeSnapshot(tabId, fresh.text);

    if (diff === "(no visible change)") {
      return "\n(no visible change)";
    }
    return `\n--- page changes ---\n${diff}`;
  } catch {
    return ""; // best-effort — feedback never fails the action
  }
}
