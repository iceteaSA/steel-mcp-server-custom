import { expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptProfiles } from "../decrypt-profiles.js";
import { encryptJSON } from "../crypto.js";

test("rollback refuses unavailable procfs before it reads profile contents", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "rollback-no-procfs-"));
  await fs.writeFile(join(root, "saved.json"), encryptJSON({ cookies: [] }, "test-passphrase"));
  const realAccess = fs.access;
  const access = spyOn(fs, "access").mockImplementation(async (target, mode) => {
    if (String(target) === "/proc/self/fd") throw new Error("procfs unavailable");
    return realAccess(target, mode);
  });
  const read = spyOn(fs, "readFile");
  try {
    await expect(decryptProfiles(root, "test-passphrase", true)).rejects.toThrow("procfs");
    expect(read).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
    read.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses a file swapped for an outside symlink after lstat", async () => {
  const work = await fs.mkdtemp(join(tmpdir(), "rollback-leaf-race-"));
  const root = join(work, "profiles");
  await fs.mkdir(root);
  const file = join(root, "saved.json");
  const outside = join(work, "outside.json");
  const secret = encryptJSON({ cookies: [], marker: "OUTSIDE_CANARY" }, "test-passphrase");
  await fs.writeFile(file, encryptJSON({ cookies: [] }, "test-passphrase"));
  await fs.writeFile(outside, secret);
  const realLstat = fs.lstat;
  let swapped = false;
  const race = spyOn(fs, "lstat").mockImplementation(
    new Proxy(realLstat, {
      async apply(target, receiver, args) {
        const info = await Reflect.apply(target, receiver, args);
        if (String(args[0]).endsWith("/saved.json") && !swapped) {
          swapped = true;
          await fs.rename(file, file + ".backup");
          await fs.symlink(outside, file);
        }
        return info;
      },
    }),
  );
  try {
    await expect(decryptProfiles(root, "test-passphrase", true)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe(secret);
  } finally {
    race.mockRestore();
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("rollback pins its directory when the original path is renamed to an outside symlink", async () => {
  const work = await fs.mkdtemp(join(tmpdir(), "rollback-directory-race-"));
  const root = join(work, "profiles");
  const moved = join(work, "moved");
  const outside = join(work, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const own = { cookies: [], marker: "OWN_STATE" };
  const secret = encryptJSON({ cookies: [], marker: "OUTSIDE_CANARY" }, "test-passphrase");
  await fs.writeFile(join(root, "saved.json"), encryptJSON(own, "test-passphrase"));
  await fs.writeFile(join(outside, "saved.json"), secret);
  const realReaddir = fs.readdir;
  let swapped = false;
  const race = spyOn(fs, "readdir").mockImplementation(
    new Proxy(realReaddir, {
      async apply(target, receiver, args) {
        if (!swapped) {
          swapped = true;
          await fs.rename(root, moved);
          await fs.symlink(outside, root);
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  try {
    expect(await decryptProfiles(root, "test-passphrase")).toBe(1);
    expect(swapped).toBe(true);
    expect(await fs.readFile(join(outside, "saved.json"), "utf8")).toBe(secret);
    expect(JSON.parse(await fs.readFile(join(moved, "saved.json"), "utf8"))).toEqual(own);
  } finally {
    race.mockRestore();
    await fs.rm(work, { recursive: true, force: true });
  }
});
