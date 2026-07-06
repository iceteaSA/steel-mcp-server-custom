import { describe, it, expect } from "bun:test";
import { encryptJSON, decryptJSON } from "../crypto.js";

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
