import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Env } from "./manager.js";
import { safeRealpath, assertInsideRoot } from "./helpers.js";

export type ReservedStoreEnv = Pick<Env, "OUTPUT_DIR"> &
  Partial<Pick<Env, "PROFILES_DIR" | "CREDENTIALS_FILE" | "STEEL_NTFY_TOPIC_FILE">>;

function inside(file: string, directory: string): boolean {
  const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
  return file === directory || file.startsWith(prefix);
}

export async function writeReservedSafeOutput(
  file: string,
  data: Buffer | string | AsyncIterable<Uint8Array>,
  env: ReservedStoreEnv & Pick<Env, "OUTPUT_ROOT">,
): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("reserved_store: output writes require Linux descriptor paths.");
  try {
    await fs.access("/proc/self/fd", constants.R_OK | constants.X_OK);
  } catch {
    throw new Error("reserved_store: output descriptor paths are unavailable.");
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const resolved = await safeRealpath(path.resolve(file));
  await assertNotReservedStore(resolved, env);
  await assertInsideRoot(resolved, env.OUTPUT_ROOT, "outputPath");
  const directory = path.dirname(resolved);
  const checked = await fs.lstat(directory);
  const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await parent.stat();
    if (!opened.isDirectory() || opened.dev !== checked.dev || opened.ino !== checked.ino)
      throw new Error("reserved_store: output directory changed during access.");
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(resolved)}`;
    await assertNotReservedStore(anchored, env);
    await assertInsideRoot(anchored, env.OUTPUT_ROOT, "outputPath");
    const leaf = await fs.open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await leaf.stat()).isFile()) throw new Error("reserved_store: output must be a regular file.");
      // Check the opened inode before truncation. A leaf can change after its path check.
      await assertNotReservedStore(`/proc/self/fd/${leaf.fd}`, env);
      await assertInsideRoot(`/proc/self/fd/${leaf.fd}`, env.OUTPUT_ROOT, "outputPath");
      await leaf.truncate(0);
      if (typeof data === "string" || Buffer.isBuffer(data)) await leaf.writeFile(data);
      else for await (const chunk of data) await leaf.writeFile(chunk);
    } finally { await leaf.close(); }
  } finally { await parent.close(); }
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
