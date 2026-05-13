// Shared AES-256-GCM encryption/decryption for credential storage.
// Used by both manager.ts (credential store) and relay.ts (cookie push).

import crypto from "crypto";

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, "steel-mcp-creds", 32);
}

export function encryptJSON(data: unknown, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptJSON(blob: string, passphrase: string): unknown {
  const key = deriveKey(passphrase);
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}
