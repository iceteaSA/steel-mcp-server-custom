#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decryptJSON } from "./crypto.js";
import { atomicWriteJson, withProfileWrite } from "./profile-store.js";
import { isValidProfileName } from "./helpers.js";

export async function decryptProfiles(
  directory: string,
  passphrase: string,
  dryRun = false,
): Promise<number> {
  if (!passphrase) throw new Error("CREDENTIALS_PASSPHRASE is required.");
  const root = path.resolve(directory);
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw new Error("PROFILES_DIR must be a real directory, not a symlink.");
  const entries: Array<{ file: string; raw: string; state: unknown }> = [];
  for (const name of await fs.readdir(root)) {
    if (!name.endsWith(".json")) continue;
    if (!isValidProfileName(name.slice(0, -5))) throw new Error("Invalid profile name.");
    const file = path.join(root, name);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Refusing non-regular profile file.");
    const raw = await fs.readFile(file, "utf8");
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
      state = decryptJSON(raw.trim(), passphrase);
    } catch {
      throw new Error("Cannot decrypt profile: check CREDENTIALS_PASSPHRASE.");
    }
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(state)), state))
      throw new Error("Profile compare mismatch.");
    entries.push({ file, raw, state });
  }
  if (!dryRun) {
    for (const { file, raw, state } of entries)
      await withProfileWrite(file, async () => {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || (await fs.readFile(file, "utf8")) !== raw)
          throw new Error("Profile changed during rollback. Stop the server and retry.");
        await atomicWriteJson(file, state);
      });
  }
  return entries.length;
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
