import fs from "fs/promises";
import path from "path";
import os from "os";
import { describe, it, expect } from "bun:test";
import { encryptJSON, decryptJSON } from "../crypto.js";

describe("credential encryption", () => {
  const passphrase = "test-secret-123";

  // ---------------------------------------------------------------------------
  // v2 format — round-trip + uniqueness
  // ---------------------------------------------------------------------------

  it("v2 round-trips simple data", () => {
    const data = { username: "alice", password: "hunter2" };
    const encrypted = encryptJSON(data, passphrase);
    expect(encrypted.startsWith("v2:")).toBe(true);
    const decrypted = decryptJSON(encrypted, passphrase);
    expect(decrypted).toEqual(data);
  });

  it("v2 round-trips arrays", () => {
    const data = [
      { name: "github", url: "github.com", username: "u", password: "p" },
      { name: "aws", url: "aws.com", username: "admin", password: "secret" },
    ];
    const encrypted = encryptJSON(data, passphrase);
    expect(encrypted.startsWith("v2:")).toBe(true);
    const decrypted = decryptJSON(encrypted, passphrase);
    expect(decrypted).toEqual(data);
  });

  it("produces different ciphertexts and different salts for same data", () => {
    const data = { key: "value" };
    const a = encryptJSON(data, passphrase);
    const b = encryptJSON(data, passphrase);
    expect(a).not.toBe(b);

    // Extract salts to confirm they differ (not just different IVs).
    const saltA = a.split(":")[1];
    const saltB = b.split(":")[1];
    expect(saltA).not.toBe(saltB);

    // Both must decrypt correctly.
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
    const parts = encrypted.split(":");
    // Flip a byte in the ciphertext part (last field)
    const ctBuf = Buffer.from(parts[4], "base64");
    ctBuf[ctBuf.length - 3] ^= 0xff;
    parts[4] = ctBuf.toString("base64");
    const tampered = parts.join(":");
    expect(() => decryptJSON(tampered, passphrase)).toThrow();
  });

  it("fails with tampered auth tag", () => {
    const data = { secret: "value" };
    const encrypted = encryptJSON(data, passphrase);
    const parts = encrypted.split(":");
    // Flip a byte in the auth tag
    const tagBuf = Buffer.from(parts[3], "base64");
    tagBuf[0] ^= 0xff;
    parts[3] = tagBuf.toString("base64");
    const tampered = parts.join(":");
    expect(() => decryptJSON(tampered, passphrase)).toThrow();
  });

  it("v2 rejects malformed payloads", () => {
    expect(() => decryptJSON("v2:only-three-parts", passphrase)).toThrow();
    expect(() => decryptJSON("v2:" + "x".repeat(100), passphrase)).toThrow();
  });

  it("handles empty objects", () => {
    const encrypted = encryptJSON({}, passphrase);
    expect(encrypted.startsWith("v2:")).toBe(true);
    expect(decryptJSON(encrypted, passphrase)).toEqual({});
  });

  it("handles unicode content", () => {
    const data = { name: "用户", emoji: "🔐" };
    const encrypted = encryptJSON(data, passphrase);
    expect(decryptJSON(encrypted, passphrase)).toEqual(data);
  });

  // ---------------------------------------------------------------------------
  // Legacy format — decrypt old fixed-salt blobs; next save auto-upgrades to v2
  // ---------------------------------------------------------------------------

  // Fixture generated with the pre-v0.8.0-sota fixed-salt code:
  //   encryptJSON({ username: "legacyuser", password: "legacypass" }, "legacy-fixture-pw")
  const LEGACY_FIXTURE =
    "k8HrsgvNANgC4ZXsB5KwyX/K9LT42PfneU26dtdZIfXpXvemqR1YmGIuw/EDhWfGErrTRWNJNooBphzgJIuHkzdw1tG/s6vB/6FOPqU=";
  const LEGACY_PW = "legacy-fixture-pw";
  const LEGACY_DATA = { username: "legacyuser", password: "legacypass" };

  it("decrypts legacy-format fixture", () => {
    const decrypted = decryptJSON(LEGACY_FIXTURE, LEGACY_PW);
    expect(decrypted).toEqual(LEGACY_DATA);
  });

  it("legacy fixture re-encrypts as v2 (migration path)", () => {
    // Load legacy → re-encrypt → verify v2 format → verify round-trip.
    const decrypted = decryptJSON(LEGACY_FIXTURE, LEGACY_PW);
    const reEncrypted = encryptJSON(decrypted, LEGACY_PW);
    expect(reEncrypted.startsWith("v2:")).toBe(true);
    expect(decryptJSON(reEncrypted, LEGACY_PW)).toEqual(LEGACY_DATA);
  });

  it("store-level migration: legacy file → save → file is now v2 → loads again", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "steel-enc-test-"));
    const credFile = path.join(tmpDir, "creds.json");

    try {
      // Write a legacy-format file (raw ciphertext, no v2 prefix).
      await fs.writeFile(credFile, LEGACY_FIXTURE);

      // Read back with decryptJSON (should detect legacy format).
      const raw = await fs.readFile(credFile, "utf8");
      const decrypted1 = decryptJSON(raw.trim(), LEGACY_PW);
      expect(decrypted1).toEqual(LEGACY_DATA);

      // Re-encrypt (now v2) and overwrite.
      const reEncrypted = encryptJSON(decrypted1, LEGACY_PW);
      expect(reEncrypted.startsWith("v2:")).toBe(true);
      await fs.writeFile(credFile, reEncrypted);

      // Read back again — should detect v2 and decrypt.
      const raw2 = await fs.readFile(credFile, "utf8");
      const decrypted2 = decryptJSON(raw2.trim(), LEGACY_PW);
      expect(decrypted2).toEqual(LEGACY_DATA);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
