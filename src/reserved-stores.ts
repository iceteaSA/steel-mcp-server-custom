import fs from "node:fs/promises";
import path from "node:path";
import type { Env } from "./manager.js";
import { safeRealpath } from "./helpers.js";

export type ReservedStoreEnv = Pick<Env, "OUTPUT_DIR"> &
  Partial<Pick<Env, "PROFILES_DIR" | "CREDENTIALS_FILE" | "STEEL_NTFY_TOPIC_FILE">>;

function inside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(directory + path.sep);
}

async function metadata(file: string) {
  try {
    return await fs.stat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function profileInodes(directory: string, result: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    const stat = await metadata(file);
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (entry.isSymbolicLink())
        throw new Error("reserved_store: cannot verify a store directory alias.");
      await profileInodes(file, result);
    } else if (stat.isFile()) result.add(`${stat.dev}:${stat.ino}`);
  }
}

/** Protect server stores even when root containment is disabled. */
export async function assertNotReservedStore(
  file: string,
  env: ReservedStoreEnv,
  operation: "read" | "write" = "write",
): Promise<void> {
  try {
    const profiles = path.resolve(env.PROFILES_DIR ?? path.join(env.OUTPUT_DIR, "profiles"));
    const files = [
      env.CREDENTIALS_FILE ?? path.join(env.OUTPUT_DIR, "credentials.json"),
      env.STEEL_NTFY_TOPIC_FILE,
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value));
    const resolvedProfiles = await safeRealpath(profiles);
    const resolvedFiles = await Promise.all(files.map((value) => safeRealpath(value)));
    const target = path.resolve(file);
    const resolved = await safeRealpath(target);
    const refuse = () => {
      throw new Error("reserved_store: this path is reserved for server state.");
    };
    if (
      inside(target, profiles) ||
      inside(resolved, resolvedProfiles) ||
      files.includes(target) ||
      resolvedFiles.includes(resolved)
    )
      refuse();
    const stat = await metadata(resolved);
    if (!stat) return;
    if (stat.isDirectory()) {
      if (
        operation === "read" &&
        [resolvedProfiles, ...resolvedFiles].some((store) => inside(store, resolved))
      )
        refuse();
      return;
    }
    const reserved = new Set<string>();
    for (const store of resolvedFiles) {
      const info = await metadata(store);
      if (info?.isFile()) reserved.add(`${info.dev}:${info.ino}`);
    }
    await profileInodes(resolvedProfiles, reserved);
    if (reserved.has(`${stat.dev}:${stat.ino}`)) refuse();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("reserved_store:")) throw error;
    throw new Error("reserved_store: cannot verify file access.");
  }
}
