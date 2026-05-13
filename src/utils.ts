// -----------------------------------------------------------------------------
// utils.ts — Shared utility functions used across tool files.
//
// Extracted from manager.ts. Imported by tools/*.ts.
// -----------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import type { Env } from "./manager.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function globalWait(env: Pick<Env, "GLOBAL_WAIT_SECONDS">): Promise<void> {
  if (env.GLOBAL_WAIT_SECONDS > 0) {
    await sleep(env.GLOBAL_WAIT_SECONDS * 1000);
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
