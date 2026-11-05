import { expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSchema } from "../env.js";
import { writeToFile } from "../utils.js";
import { assertNotReservedStore } from "../reserved-stores.js";

for (const shape of ["default", "separate"] as const) {
  for (const target of [
    "profile",
    "state",
    "audit",
    "credentials",
    "topic",
    "symlink",
    "hardlink",
    "new",
  ] as const) {
    test(`reserved stores: ${shape} ${target} cannot be a generic output`, async () => {
      const root = await mkdtemp(join(tmpdir(), "reserved-output-"));
      const output = shape === "default" ? root : join(root, "out");
      const env = EnvSchema.parse({
        BROWSER_MODE: "local",
        OUTPUT_DIR: output,
        ...(shape === "separate"
          ? {
              PROFILES_DIR: join(root, "profiles"),
              CREDENTIALS_FILE: join(root, "credentials.json"),
            }
          : {}),
        STEEL_NTFY_TOPIC_FILE: join(root, "notify.topic"),
      });
      try {
        await mkdir(output, { recursive: true });
        await mkdir(env.PROFILES_DIR, { recursive: true });
        const files = {
          profile: join(env.PROFILES_DIR, "x.json"),
          state: join(env.PROFILES_DIR, ".signin-state.json"),
          audit: join(env.PROFILES_DIR, ".signin-audit.jsonl"),
          credentials: env.CREDENTIALS_FILE,
          topic: env.STEEL_NTFY_TOPIC_FILE!,
          symlink: join(output, "alias.json"),
          hardlink: join(output, "linked.json"),
          new: join(env.PROFILES_DIR, "new", "nested.json"),
        };
        for (const key of ["profile", "state", "audit", "credentials", "topic"] as const)
          await writeFile(files[key], "SERVER_ONLY_CANARY");
        await symlink(files.profile, files.symlink);
        await link(files.credentials, files.hardlink);
        await expect(writeToFile("untrusted", "unused.txt", env, files[target])).rejects.toThrow(
          "reserved_store",
        );
        for (const key of ["profile", "state", "audit", "credentials", "topic"] as const)
          expect(await readFile(files[key], "utf8")).toBe("SERVER_ONLY_CANARY");
        expect(await Bun.file(files.new).exists()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("reserved stores do not block ordinary output aliases or new output directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "reserved-ordinary-"));
  const env = EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: root });
  try {
    const normal = join(root, "ordinary.txt");
    await writeFile(normal, "old");
    await symlink(normal, join(root, "alias.txt"));
    await link(normal, join(root, "linked.txt"));
    await writeToFile("one", "unused", env, join(root, "alias.txt"));
    await writeToFile("two", "unused", env, join(root, "linked.txt"));
    expect(await readFile(normal, "utf8")).toBe("two");
    await writeToFile("new", "unused", env, join(root, "new", "ordinary.txt"));
    expect(await readFile(join(root, "new", "ordinary.txt"), "utf8")).toBe("new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default output accepts a nested OUTPUT_DIR inside a different OUTPUT_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "output-root-"));
  const output = join(root, "nested", "out");
  const env = EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: output, OUTPUT_ROOT: root });
  try {
    const file = await writeToFile("ordinary", "default.txt", env);
    expect(file).toBe(join(output, "default.txt"));
    expect(await readFile(file, "utf8")).toBe("ordinary");
    await expect(writeToFile("escape", "unused", env, join(root, "..", "escape.txt"))).rejects.toThrow("escapes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a root PROFILES_DIR reserves every descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "root-profiles-"));
  try {
    await expect(assertNotReservedStore(join(root, "new.txt"), { OUTPUT_DIR: root, PROFILES_DIR: "/" })).rejects.toThrow("reserved_store");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parent replacement after output validation cannot overwrite server state", async () => {
  const root = await mkdtemp(join(tmpdir(), "output-race-"));
  const output = join(root, "out");
  const profiles = join(root, "profiles");
  const env = EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: output, PROFILES_DIR: profiles, OUTPUT_ROOT: "*" });
  const mkdir = fs.mkdir.bind(fs);
  let swapped = false;
  try {
    await mkdir(output);
    await mkdir(profiles);
    await writeFile(join(profiles, "saved.json"), "SERVER_ONLY_CANARY");
    const spy = spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args);
      if (!swapped && args[0] === output) {
        swapped = true;
        await fs.rename(output, join(root, "original"));
        await symlink(profiles, output);
      }
      return result;
    });
    try { await writeToFile("untrusted", "saved.json", env).catch(() => {}); }
    finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(await readFile(join(profiles, "saved.json"), "utf8")).toBe("SERVER_ONLY_CANARY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("output writes fail closed when descriptor paths are unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "output-no-proc-"));
  const access = fs.access.bind(fs);
  const spy = spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file === "/proc/self/fd") throw Object.assign(new Error("unavailable"), { code: "ENOENT" });
    return access(file, mode);
  });
  try {
    await expect(writeToFile("untrusted", "ordinary.txt", EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: root }))).rejects.toThrow("descriptor");
    expect(await Bun.file(join(root, "ordinary.txt")).exists()).toBe(false);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
