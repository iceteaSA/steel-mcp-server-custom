import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "patchright";

type Cookie = Parameters<BrowserContext["addCookies"]>[0][number] & {
  domain: string;
  path: string;
};
export interface ProfileData {
  cookies?: Cookie[];
  localStorage?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}
const writes = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();

export function profileRevision(file: string): number {
  return revisions.get(path.resolve(file)) ?? 0;
}
export function withProfileWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(key, next);
  const cleanup = () => {
    if (writes.get(key) === next) writes.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}
export async function readProfileData(file: string): Promise<ProfileData> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid profile file");
    return JSON.parse(await fs.readFile(file, "utf8")) as ProfileData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
// Callers hold `withProfileWrite` across the read, merge, and atomic write.
export async function writeProfileData(file: string, state: ProfileData): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
    revisions.set(path.resolve(file), profileRevision(file) + 1);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
export async function removeProfileData(file: string): Promise<void> {
  await withProfileWrite(file, async () => {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    revisions.set(path.resolve(file), profileRevision(file) + 1);
  });
}
export function mergeProfileData(before: ProfileData, after: ProfileData): ProfileData {
  const cookies = [...(before.cookies ?? [])];
  for (const cookie of after.cookies ?? []) {
    const index = cookies.findIndex(
      (item) =>
        item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path,
    );
    if (index < 0) cookies.push(cookie);
    else cookies[index] = cookie;
  }
  const localStorage = { ...before.localStorage };
  for (const [origin, entries] of Object.entries(after.localStorage ?? {}))
    localStorage[origin] = { ...localStorage[origin], ...entries };
  return { ...before, ...after, cookies, localStorage };
}
