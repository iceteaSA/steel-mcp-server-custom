// -----------------------------------------------------------------------------
// credentials-store.ts — Credential type, load/save helpers, crypto re-exports.
//
// Extracted from manager.ts. Imported by tools/credentials.ts and relay.ts
// (relay.ts has its own minimal copy to avoid circular deps, but tools use this).
// -----------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import type { Env } from "./manager.js";

// Import + re-export from shared crypto module (also used by relay.ts).
import { encryptJSON, decryptJSON } from "./crypto.js";
export { encryptJSON, decryptJSON };

export type Credential = {
  name: string;
  url: string; // URL pattern or domain to match
  username: string;
  password: string;
  extra?: Record<string, string>; // additional fields (e.g., OTP secret, security question)
  createdAt: string;
  updatedAt: string;
};

export async function loadCredentials(
  env: Pick<Env, "CREDENTIALS_FILE" | "CREDENTIALS_PASSPHRASE">,
): Promise<Credential[]> {
  try {
    const raw = await fs.readFile(env.CREDENTIALS_FILE, "utf8");
    if (env.CREDENTIALS_PASSPHRASE) {
      return decryptJSON(raw.trim(), env.CREDENTIALS_PASSPHRASE) as Credential[];
    }
    return JSON.parse(raw) as Credential[];
  } catch {
    return [];
  }
}

export async function saveCredentials(
  creds: Credential[],
  env: Pick<Env, "CREDENTIALS_FILE" | "CREDENTIALS_PASSPHRASE">,
): Promise<void> {
  await fs.mkdir(path.dirname(env.CREDENTIALS_FILE), { recursive: true });
  if (env.CREDENTIALS_PASSPHRASE) {
    await fs.writeFile(env.CREDENTIALS_FILE, encryptJSON(creds, env.CREDENTIALS_PASSPHRASE));
  } else {
    await fs.writeFile(env.CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  }
}
