import { expect, test, spyOn } from "bun:test";
import nodeCrypto from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "../crypto.js";
import { writeProfileData, readProfileData } from "../profile-store.js";
import { saveCredentials, loadCredentials } from "../credentials-store.js";
import { decryptProfiles } from "../decrypt-profiles.js";
import { startRelayServer } from "../relay.js";

test("production profile, credential, relay, and rollback paths never call synchronous crypto exports", async () => {
  const work = await fs.mkdtemp(join(tmpdir(), "async-production-"));
  const profiles = join(work, "profiles");
  const env = {
    CREDENTIALS_FILE: join(work, "credentials.json"),
    CREDENTIALS_PASSPHRASE: "test-passphrase",
  };
  const state = { cookies: [], localStorage: {} };
  const encrypt = spyOn(crypto, "encryptJSON").mockImplementation(() => {
    throw new Error("production called sync encryptJSON");
  });
  const decrypt = spyOn(crypto, "decryptJSON").mockImplementation(() => {
    throw new Error("production called sync decryptJSON");
  });
  let server: ReturnType<typeof startRelayServer> | undefined;
  try {
    const file = join(profiles, "saved.json");
    await writeProfileData(file, state, env.CREDENTIALS_PASSPHRASE);
    expect(await readProfileData(file, false, env.CREDENTIALS_PASSPHRASE)).toEqual(state);
    const credentials = [
      {
        name: "fixture",
        url: "https://example.test",
        username: "user",
        password: "fixture",
        createdAt: "fixture",
        updatedAt: "fixture",
      },
    ];
    await saveCredentials(credentials, env);
    expect(await loadCredentials(env)).toEqual(credentials);
    server = startRelayServer({
      port: 0,
      bindAddr: "127.0.0.1",
      secret: "test-secret",
      profilesDir: profiles,
      credentialsFile: env.CREDENTIALS_FILE,
      credentialsPassphrase: env.CREDENTIALS_PASSPHRASE,
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test HTTP port");
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/push`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: "relay",
          cookies: [],
          credentials: {
            name: "relay",
            url: "https://example.test",
            username: "user",
            password: "fixture",
          },
        }),
      });
      expect(response.ok).toBe(true);
      await response.text();
    }
    expect(await decryptProfiles(profiles, env.CREDENTIALS_PASSPHRASE, true)).toBe(2);
    expect(await decryptProfiles(profiles, env.CREDENTIALS_PASSPHRASE)).toBe(2);
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    encrypt.mockRestore();
    decrypt.mockRestore();
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("async key derivation is single-flight per passphrase and salt and never calls scryptSync", async () => {
  expect(typeof crypto.decryptJSONAsync).toBe("function");
  const passphrase = "single-flight-fixture";
  const salt = nodeCrypto.randomBytes(16).toString("base64");
  const key = nodeCrypto.scryptSync(passphrase, salt, 32);
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ marker: "fixture" })),
    cipher.final(),
  ]);
  const blob = `v2:${salt}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
  const derive = spyOn(nodeCrypto, "scrypt");
  const sync = spyOn(nodeCrypto, "scryptSync").mockImplementation(() => {
    throw new Error("sync derivation in async path");
  });
  try {
    const values = await Promise.all(
      Array.from({ length: 8 }, () => crypto.decryptJSONAsync(blob, passphrase)),
    );
    expect(values).toEqual(Array.from({ length: 8 }, () => ({ marker: "fixture" })));
    expect(await crypto.decryptJSONAsync(blob, passphrase)).toEqual({ marker: "fixture" });
    expect(derive).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    await expect(crypto.decryptJSONAsync(blob, "different-passphrase")).rejects.toThrow();
    expect(derive).toHaveBeenCalledTimes(2);
  } finally {
    derive.mockRestore();
    sync.mockRestore();
  }
});

test("derived keys use a 256-entry FIFO cache without refreshing old entries on reads", async () => {
  expect(typeof crypto.encryptJSONAsync).toBe("function");
  const derive = spyOn(nodeCrypto, "scrypt");
  try {
    const blobs: string[] = [];
    for (let i = 0; i < 257; i++) blobs.push(await crypto.encryptJSONAsync({ i }, "cache-fixture"));
    expect(derive).toHaveBeenCalledTimes(257);
    expect(await crypto.decryptJSONAsync(blobs[1], "cache-fixture")).toEqual({ i: 1 });
    expect(derive).toHaveBeenCalledTimes(257);
    expect(await crypto.decryptJSONAsync(blobs[0], "cache-fixture")).toEqual({ i: 0 });
    expect(derive).toHaveBeenCalledTimes(258);
    expect(await crypto.decryptJSONAsync(blobs[1], "cache-fixture")).toEqual({ i: 1 });
    expect(derive).toHaveBeenCalledTimes(259);
  } finally {
    derive.mockRestore();
  }
}, 30000);
