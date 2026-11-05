#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decryptJSONAsync } from "./crypto.js";
import { atomicWriteJson, withProfileWrite } from "./profile-store.js";
import { isValidProfileName } from "./helpers.js";

async function readRollbackFile(file: string) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Refusing non-regular profile file.");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Profile changed during rollback. Stop the server and retry.");
    return { raw: await handle.readFile("utf8"), dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

export async function decryptProfiles(
  directory: string,
  passphrase: string,
  dryRun = false,
): Promise<number> {
  if (!passphrase) throw new Error("CREDENTIALS_PASSPHRASE is required.");
  if (process.platform !== "linux")
    throw new Error("Rollback requires Linux with procfs at /proc/self/fd.");
  try {
    await fs.access("/proc/self/fd", constants.R_OK | constants.X_OK);
  } catch {
    throw new Error("Rollback requires accessible procfs at /proc/self/fd.");
  }
  const root = path.resolve(directory);
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw new Error("PROFILES_DIR must be a real directory, not a symlink.");
  const directoryHandle = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await directoryHandle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("Profile directory changed during rollback.");
    // The descriptor keeps the selected directory stable if its pathname changes.
    const anchoredRoot = `/proc/self/fd/${directoryHandle.fd}`;
    const entries: Array<{ name: string; raw: string; state: unknown; dev: number; ino: number }> =
      [];
    for (const name of await fs.readdir(anchoredRoot)) {
      if (!name.endsWith(".json")) continue;
      if (!isValidProfileName(name.slice(0, -5))) throw new Error("Invalid profile name.");
      const { raw, dev, ino } = await readRollbackFile(path.join(anchoredRoot, name));
      if (raw.trim().startsWith("{")) {
        try {
          JSON.parse(raw);
        } catch {
          throw new Error("Invalid plaintext profile.");
        }
        continue;
      }
      let state: unknown;
      try {
        state = await decryptJSONAsync(raw.trim(), passphrase);
      } catch {
        throw new Error("Cannot decrypt profile: check CREDENTIALS_PASSPHRASE.");
      }
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(state)), state))
        throw new Error("Profile compare mismatch.");
      entries.push({ name, raw, state, dev, ino });
    }
    if (!dryRun) {
      for (const { name, raw, state, dev, ino } of entries)
        await withProfileWrite(path.join(root, name), async () => {
          const file = path.join(anchoredRoot, name);
          const current = await readRollbackFile(file);
          if (current.raw !== raw || current.dev !== dev || current.ino !== ino)
            throw new Error("Profile changed during rollback. Stop the server and retry.");
          await atomicWriteJson(file, state);
        });
    }
    return entries.length;
  } finally {
    await directoryHandle.close();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--dry-run"))
      throw new Error("Usage: decrypt-profiles [--dry-run]");
    const directory =
      process.env.PROFILES_DIR ?? path.join(process.env.OUTPUT_DIR ?? "/tmp/steel-mcp", "profiles");
    const count = await decryptProfiles(
      directory,
      process.env.CREDENTIALS_PASSPHRASE ?? "",
      args.includes("--dry-run"),
    );
    console.log(
      `${args.includes("--dry-run") ? "Would decrypt" : "Decrypted"} ${count} profile(s).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Profile rollback failed.");
    process.exitCode = 1;
  }
}
