import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfileData, writeProfileData, withProfileWrite } from "../profile-store.js";
import * as crypto from "../crypto.js";

const state = { cookies: [{ name: "token", value: "CANARY", domain: "example.test", path: "/" }], localStorage: { "https://example.test": { token: "CANARY" } } };
test("profile encryption round trip, migration, fail closed, and 0600 files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "encrypted-profile-"));
  const file = join(dir, "saved.json");
  try {
    await writeFile(file, JSON.stringify(state));
    expect(await withProfileWrite(file, () => readProfileData(file, false, "test-passphrase"))).toEqual(state);
    const encrypted = await readFile(file, "utf8");
    expect(encrypted.startsWith("v2:")).toBe(true);
    expect(encrypted).not.toContain("CANARY");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(readProfileData(file)).rejects.toThrow("CREDENTIALS_PASSPHRASE");
    await expect(readProfileData(file, false, "wrong")).rejects.toThrow("decrypt");
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await withProfileWrite(file, () => writeProfileData(file, state, "test-passphrase"));
    expect(await readProfileData(file, false, "test-passphrase")).toEqual(state);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("migration compare mismatch keeps original plaintext and logs no state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migration-"));
  const file = join(dir, "saved.json");
  const original = JSON.stringify(state);
  const decrypt = spyOn(crypto, "decryptJSON").mockReturnValue({ cookies: [] });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await writeFile(file, original);
    expect(await withProfileWrite(file, () => readProfileData(file, false, "test-passphrase"))).toEqual(state);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("CANARY");
    expect(JSON.stringify(log.mock.calls)).not.toContain(dir);
  } finally { decrypt.mockRestore(); log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

test("decrypt-profiles dry-run and apply refuse symlinks and wrong passphrases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rollback-"));
  const file = join(dir, "saved.json");
  const run = async (args: string[], passphrase = "test-passphrase") => {
    const child = Bun.spawn([process.execPath, "src/decrypt-profiles.ts", ...args], { env: { ...process.env, PROFILES_DIR: dir, CREDENTIALS_PASSPHRASE: passphrase }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    return { code: await child.exited, output };
  };
  try {
    const encrypted = crypto.encryptJSON(state, "test-passphrase");
    await writeFile(file, encrypted);
    expect((await run(["--dry-run"])).code).toBe(0);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    expect((await run([], "wrong")).code).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await symlink(file, join(dir, "link.json"));
    expect((await run([])).code).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await rm(join(dir, "link.json"));
    expect((await run([])).code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
