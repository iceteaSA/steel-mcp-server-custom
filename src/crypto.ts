// Shared AES-256-GCM encryption/decryption for credential storage.
// Used by both manager.ts (credential store) and relay.ts (cookie push).
//
// v2 format (current): per-file random 16-byte salt → scrypt → AES-256-GCM.
//   "v2:<salt b64>:<iv b64>:<tag b64>:<ct b64>"
// Legacy format: fixed salt "steel-mcp-creds" → base64(iv + tag + ciphertext).
//   Automatically detected and decrypted; next save upgrades to v2.

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

const keys = new Map<string, Buffer>();
const pendingKeys = new Map<string, Promise<Buffer>>();
const KEY_CACHE_LIMIT = 256;

function keyId(passphrase: string, salt: string): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([passphrase, salt]))
    .digest("hex");
}

function rememberKey(id: string, key: Buffer): Buffer {
  if (!keys.has(id) && keys.size >= KEY_CACHE_LIMIT) {
    const oldest = keys.keys().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  keys.set(id, key);
  return key;
}

function deriveKey(passphrase: string, salt: string): Buffer {
  const id = keyId(passphrase, salt);
  return keys.get(id) ?? rememberKey(id, crypto.scryptSync(passphrase, salt, 32));
}

function deriveKeyAsync(passphrase: string, salt: string): Promise<Buffer> {
  const id = keyId(passphrase, salt);
  const cached = keys.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = pendingKeys.get(id);
  if (pending) return pending;
  const operation = new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, (error, key) => (error ? reject(error) : resolve(key)));
  })
    .then((key) => rememberKey(id, key))
    .finally(() => pendingKeys.delete(id));
  pendingKeys.set(id, operation);
  return operation;
}

// ---------------------------------------------------------------------------
// v2 format — per-file random salt
// ---------------------------------------------------------------------------

export function encryptJSON(data: unknown, passphrase: string): string {
  // 16-byte random salt per call so two encrypts of the same plaintext
  // produce different output (unlike the legacy fixed-salt format).
  const salt = crypto.randomBytes(16);
  const saltB64 = salt.toString("base64");
  const key = deriveKey(passphrase, saltB64);
  return encryptWithKey(data, saltB64, key);
}

export async function encryptJSONAsync(data: unknown, passphrase: string): Promise<string> {
  const saltB64 = crypto.randomBytes(16).toString("base64");
  return encryptWithKey(data, saltB64, await deriveKeyAsync(passphrase, saltB64));
}

function encryptWithKey(data: unknown, saltB64: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${saltB64}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Decrypt — auto-detect v2 vs legacy
// ---------------------------------------------------------------------------

function encryptedParts(blob: string) {
  // v2 format: "v2:<salt b64>:<iv b64>:<tag b64>:<ct b64>"
  if (blob.startsWith("v2:")) {
    const rest = blob.slice(3);
    // 5 parts total: v2 marker + 4 colon-separated b64 fields
    const parts = rest.split(":");
    if (parts.length !== 4) {
      throw new Error("Malformed v2 encrypted payload: expected 4 colon-separated parts");
    }
    const [saltB64, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const encrypted = Buffer.from(ctB64, "base64");
    return { salt: saltB64, iv, tag, encrypted };
  }

  // Legacy format (pre-v2): fixed salt + base64(iv + tag + ciphertext)
  const LEGACY_SALT = "steel-mcp-creds";
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  return { salt: LEGACY_SALT, iv, tag, encrypted };
}

function decryptWithKey(parts: ReturnType<typeof encryptedParts>, key: Buffer): unknown {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, parts.iv);
  decipher.setAuthTag(parts.tag);
  const plain = Buffer.concat([decipher.update(parts.encrypted), decipher.final()]).toString(
    "utf8",
  );
  return JSON.parse(plain);
}

export function decryptJSON(blob: string, passphrase: string): unknown {
  const parts = encryptedParts(blob);
  return decryptWithKey(parts, deriveKey(passphrase, parts.salt));
}

export async function decryptJSONAsync(blob: string, passphrase: string): Promise<unknown> {
  const parts = encryptedParts(blob);
  return decryptWithKey(parts, await deriveKeyAsync(passphrase, parts.salt));
}
