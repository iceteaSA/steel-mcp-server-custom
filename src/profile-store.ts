import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "patchright";
import { z } from "zod";

export const domainSchema = z
  .string()
  .max(253)
  .regex(/^\.?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/);
export function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
const originSchema = z.string().refine((value) => httpOrigin(value) === value);
export const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: domainSchema,
  path: z.string().startsWith("/"),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  partitionKey: z.string().optional(),
  sameSite: z
    .enum(["Strict", "Lax", "None", "No_restriction"])
    .transform((value) => (value === "No_restriction" ? "None" : value))
    .optional(),
});
export const storageSchema = z.record(originSchema, z.record(z.string(), z.string()));
const stateSchema = z
  .object({ cookies: z.array(cookieSchema).optional(), localStorage: storageSchema.optional() })
  .passthrough();

type Cookie = Parameters<BrowserContext["addCookies"]>[0][number] & {
  domain: string;
  path: string;
};
export interface ProfileData {
  cookies?: Cookie[];
  localStorage?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}
const writes = new Map<string | object, Promise<unknown>>();
const revisions = new Map<string, number>();

export function profileRevision(file: string): number {
  return revisions.get(path.resolve(file)) ?? 0;
}
export function withProfileWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return serialize(path.resolve(file), operation);
}
export function serialize<T>(key: string | object, operation: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(key, next);
  const cleanup = () => {
    if (writes.get(key) === next) writes.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}
export async function readProfileData(file: string, allowMissing = false): Promise<ProfileData> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid profile file");
    return stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
// Callers hold `withProfileWrite` across the read, merge, and atomic write.
export async function writeProfileData(file: string, state: ProfileData): Promise<void> {
  await atomicWriteJson(file, state);
  revisions.set(path.resolve(file), profileRevision(file) + 1);
}
export async function atomicWriteJson(file: string, state: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
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
        item.name === cookie.name &&
        item.domain === cookie.domain &&
        item.path === cookie.path &&
        item.partitionKey === cookie.partitionKey,
    );
    if (index < 0) cookies.push(cookie);
    else cookies[index] = cookie;
  }
  const localStorage = { ...before.localStorage };
  for (const [origin, entries] of Object.entries(after.localStorage ?? {}))
    localStorage[origin] = { ...localStorage[origin], ...entries };
  return { ...before, ...after, cookies, localStorage };
}
