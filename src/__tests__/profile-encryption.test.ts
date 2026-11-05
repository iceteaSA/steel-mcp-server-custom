import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfileData, writeProfileData, withProfileWrite } from "../profile-store.js";
import * as crypto from "../crypto.js";
import { barrier } from "./helpers.js";

const state = {
  cookies: [{ name: "token", value: "CANARY", domain: "example.test", path: "/" }],
  localStorage: { "https://example.test": { token: "CANARY" } },
};
test("profile encryption round trip, migration, fail closed, and 0600 files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "encrypted-profile-"));
  const file = join(dir, "saved.json");
  try {
    await writeFile(file, JSON.stringify(state));
    expect(
      await withProfileWrite(file, () => readProfileData(file, false, "test-passphrase")),
    ).toEqual(state);
    const encrypted = await readFile(file, "utf8");
    expect(encrypted.startsWith("v2:")).toBe(true);
    expect(encrypted).not.toContain("CANARY");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(readProfileData(file)).rejects.toThrow("CREDENTIALS_PASSPHRASE");
    await expect(readProfileData(file, false, "wrong")).rejects.toThrow("decrypt");
    await expect(writeProfileData(file, { cookies: [] }, "wrong")).rejects.toThrow("decrypt");
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await withProfileWrite(file, () => writeProfileData(file, state, "test-passphrase"));
    expect(await readProfileData(file, false, "test-passphrase")).toEqual(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration compare mismatch keeps original plaintext and logs no state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migration-"));
  const file = join(dir, "saved.json");
  const original = JSON.stringify(state);
  const decrypt = spyOn(crypto, "decryptJSONAsync").mockResolvedValue({ cookies: [] });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await writeFile(file, original);
    expect(
      await withProfileWrite(file, () => readProfileData(file, false, "test-passphrase")),
    ).toEqual(state);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("CANARY");
    expect(JSON.stringify(log.mock.calls)).not.toContain(dir);
  } finally {
    decrypt.mockRestore();
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-read migration and a concurrent save share the same queue slot order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "migration-save-"));
  const file = join(dir, "saved.json");
  const entered = barrier();
  const release = barrier();
  try {
    await writeFile(file, JSON.stringify(state));
    const held = withProfileWrite(file, async () => {
      entered.release();
      await release.promise;
    });
    await entered.promise;
    const before = readProfileData(file, false, "test-passphrase");
    const updated = { ...state, localStorage: { "https://example.test": { token: "NEWER_SAVE" } } };
    const save = writeProfileData(file, updated, "test-passphrase");
    const after = readProfileData(file, false, "test-passphrase");
    release.release();
    await held;
    expect(await before).toEqual(state);
    await save;
    expect(await after).toEqual(updated);
    expect(crypto.decryptJSON(await readFile(file, "utf8"), "test-passphrase")).toEqual(updated);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    release.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decrypt-profiles dry-run and apply refuse symlinks and wrong passphrases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rollback-"));
  const file = join(dir, "saved.json");
  const run = async (args: string[], passphrase = "test-passphrase", directory = dir) => {
    const child = Bun.spawn([process.execPath, "src/decrypt-profiles.ts", ...args], {
      env: { ...process.env, PROFILES_DIR: directory, CREDENTIALS_PASSPHRASE: passphrase },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
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
    await symlink(dir, join(dir, "directory-link"));
    expect((await run([], "test-passphrase", join(dir, "directory-link"))).code).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await rm(join(dir, "directory-link"));
    const invalid = join(dir, "invalid name.json");
    await writeFile(invalid, "{}");
    expect((await run([])).code).not.toBe(0);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await rm(invalid);
    const malformed = join(dir, "malformed.json");
    await writeFile(malformed, '{"token": CANARY_PRIVATE}');
    const rejected = await run([]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.output).not.toContain("CANARY_PRIVATE");
    expect(await readFile(file, "utf8")).toBe(encrypted);
    await rm(malformed);
    expect((await run([])).code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built Node decrypt-profiles command decrypts a file without Bun runtime APIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-rollback-"));
  try {
    const build = await Bun.build({
      entrypoints: ["src/decrypt-profiles.ts"],
      outdir: dir,
      naming: "rollback.mjs",
      target: "node",
      format: "esm",
    });
    expect(build.success).toBe(true);
    const profiles = join(dir, "profiles");
    const file = join(profiles, "saved.json");
    await writeProfileData(file, state, "test-passphrase");
    const run = async (dryRun: boolean) => {
      const child = Bun.spawn(
        ["/usr/bin/node", join(dir, "rollback.mjs"), ...(dryRun ? ["--dry-run"] : [])],
        {
          env: {
            ...process.env,
            PROFILES_DIR: profiles,
            CREDENTIALS_PASSPHRASE: "test-passphrase",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output =
        (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
      expect(output).not.toContain("CANARY");
      expect(await child.exited).toBe(0);
    };
    await run(true);
    expect((await readFile(file, "utf8")).startsWith("v2:")).toBe(true);
    await run(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
