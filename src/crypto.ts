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

function deriveKey(passphrase: string, salt: string): Buffer {
  return crypto.scryptSync(passphrase, salt, 32);
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

export function decryptJSON(blob: string, passphrase: string): unknown {
  // v2 format: "v2:<salt b64>:<iv b64>:<tag b64>:<ct b64>"
  if (blob.startsWith("v2:")) {
    const rest = blob.slice(3);
    // 5 parts total: v2 marker + 4 colon-separated b64 fields
    const parts = rest.split(":");
    if (parts.length !== 4) {
      throw new Error("Malformed v2 encrypted payload: expected 4 colon-separated parts");
    }
    const [saltB64, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    const key = deriveKey(passphrase, saltB64);
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const encrypted = Buffer.from(ctB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(plain);
  }

  // Legacy format (pre-v2): fixed salt + base64(iv + tag + ciphertext)
  const LEGACY_SALT = "steel-mcp-creds";
  const key = deriveKey(passphrase, LEGACY_SALT);
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}
