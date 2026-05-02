import { describe, it, expect } from "vitest";
import crypto from "crypto";

// Replicate the encryption functions from index.ts for isolated testing.
// These are internal (not exported), so we test the logic directly.

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, "steel-mcp-creds", 32);
}

function encryptJSON(data: unknown, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptJSON(blob: string, passphrase: string): unknown {
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

describe("credential encryption", () => {
  const passphrase = "test-secret-123";

  it("round-trips simple data", () => {
    const data = { username: "alice", password: "hunter2" };
    const encrypted = encryptJSON(data, passphrase);
    const decrypted = decryptJSON(encrypted, passphrase);
    expect(decrypted).toEqual(data);
  });

  it("round-trips arrays", () => {
    const data = [
      { name: "github", url: "github.com", username: "u", password: "p" },
      { name: "aws", url: "aws.com", username: "admin", password: "secret" },
    ];
    const encrypted = encryptJSON(data, passphrase);
    const decrypted = decryptJSON(encrypted, passphrase);
    expect(decrypted).toEqual(data);
  });

  it("produces different ciphertext for same data (random IV)", () => {
    const data = { key: "value" };
    const a = encryptJSON(data, passphrase);
    const b = encryptJSON(data, passphrase);
    expect(a).not.toBe(b); // different IVs
    expect(decryptJSON(a, passphrase)).toEqual(data);
    expect(decryptJSON(b, passphrase)).toEqual(data);
  });

  it("ciphertext contains no plaintext", () => {
    const data = { password: "supersecretpassword123" };
    const encrypted = encryptJSON(data, passphrase);
    expect(encrypted).not.toContain("supersecretpassword123");
    expect(encrypted).not.toContain("password");
  });

  it("fails with wrong passphrase", () => {
    const data = { secret: "value" };
    const encrypted = encryptJSON(data, passphrase);
    expect(() => decryptJSON(encrypted, "wrong-passphrase")).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const data = { secret: "value" };
    const encrypted = encryptJSON(data, passphrase);
    // Flip a byte in the middle
    const buf = Buffer.from(encrypted, "base64");
    buf[buf.length - 5] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptJSON(tampered, passphrase)).toThrow();
  });

  it("handles empty objects", () => {
    const encrypted = encryptJSON({}, passphrase);
    expect(decryptJSON(encrypted, passphrase)).toEqual({});
  });

  it("handles unicode content", () => {
    const data = { name: "用户", emoji: "🔐" };
    const encrypted = encryptJSON(data, passphrase);
    expect(decryptJSON(encrypted, passphrase)).toEqual(data);
  });
});
