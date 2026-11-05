import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { encryptJSON, decryptJSON } from "./crypto.js";
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
const writing = new AsyncLocalStorage<ReadonlySet<string>>();

export function profileRevision(file: string): number {
  return revisions.get(path.resolve(file)) ?? 0;
}
export function withProfileWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  // Nested reads use the same queue slot so migration cannot deadlock a save.
  if (writing.getStore()?.has(key)) return operation();
  return serialize(key, () =>
    writing.run(new Set([...(writing.getStore() ?? []), key]), operation),
  );
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
export async function readProfileData(
  file: string,
  allowMissing = false,
  passphrase?: string,
): Promise<ProfileData> {
  return withProfileWrite(file, async () => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid profile file");
      const raw = (await fs.readFile(file, "utf8")).trim();
      if (!raw.startsWith("{")) {
        if (!passphrase)
          throw Object.assign(new Error("Encrypted profile requires CREDENTIALS_PASSPHRASE."), {
            code: "profile_passphrase_required",
          });
        try {
          return stateSchema.parse(decryptJSON(raw, passphrase));
        } catch {
          throw new Error("Cannot decrypt profile: check CREDENTIALS_PASSPHRASE.");
        }
      }
      let plain: unknown;
      try {
        plain = JSON.parse(raw);
      } catch {
        throw new Error("Invalid plaintext profile.");
      }
      const state = stateSchema.parse(plain);
      if (passphrase) {
        try {
          await atomicWriteJson(file, plain, passphrase, true);
        } catch {
          console.error(`[steel-mcp] profile migration failed: ${path.basename(file, ".json")}`);
        }
      }
      return state;
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  });
}
// Keep the read, merge, and atomic write in one queue slot.
export async function writeProfileData(
  file: string,
  state: ProfileData,
  passphrase?: string,
): Promise<void> {
  await withProfileWrite(file, async () => {
    await readProfileData(file, true, passphrase);
    await atomicWriteJson(file, state, passphrase);
    revisions.set(path.resolve(file), profileRevision(file) + 1);
  });
}
export async function atomicWriteJson(
  file: string,
  state: unknown,
  passphrase?: string,
  compare = false,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      passphrase ? encryptJSON(state, passphrase) : JSON.stringify(state, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    if (
      compare &&
      (!passphrase ||
        !isDeepStrictEqual(state, decryptJSON(await fs.readFile(temporary, "utf8"), passphrase)))
    )
      throw new Error("Profile migration compare mismatch");
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
