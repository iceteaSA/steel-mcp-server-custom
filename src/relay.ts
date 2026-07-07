/**
 * Relay HTTP server — receives cookies/localStorage/credentials from the
 * browser extension and writes them into Steel profiles + credential store.
 *
 * Runs alongside the MCP stdio transport on a configurable port (RELAY_PORT).
 * Auth: shared secret via Authorization: Bearer <RELAY_SECRET>.
 *
 * Endpoints:
 *   GET  /status   — health check (no auth required)
 *   POST /push     — receive session data from extension
 */

import crypto from "crypto";
import http from "http";
import fs from "fs/promises";
import path from "path";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { assertSafeProfilePath, isValidProfileName } from "./helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // epoch seconds (-1 or omitted = session cookie)
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface PushPayload {
  profile: string; // profile name to create/update
  cookies?: RelayCookie[]; // from chrome.cookies API
  localStorage?: Record<string, Record<string, string>>; // origin → {key: value}
  credentials?: {
    // optional login credentials
    name: string;
    url: string;
    username: string;
    password: string;
    extra?: Record<string, string>;
  };
}

export interface PushResult {
  profile: string;
  cookieCount: number;
  localStorageOrigins: string[];
  credentialSaved: boolean;
  message: string;
}

export interface RelayConfig {
  port: number;
  bindAddr: string;
  secret: string;
  profilesDir: string;
  credentialsFile: string;
  credentialsPassphrase?: string;
}

// ---------------------------------------------------------------------------
// Credential helpers (duplicated minimally to avoid circular deps with index)
// ---------------------------------------------------------------------------

type Credential = {
  name: string;
  url: string;
  username: string;
  password: string;
  extra?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

async function loadCreds(file: string, passphrase?: string): Promise<Credential[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (passphrase) return decryptJSON(raw.trim(), passphrase) as Credential[];
    return JSON.parse(raw) as Credential[];
  } catch {
    return [];
  }
}

async function saveCreds(creds: Credential[], file: string, passphrase?: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (passphrase) {
    await fs.writeFile(file, encryptJSON(creds, passphrase));
  } else {
    await fs.writeFile(file, JSON.stringify(creds, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Push handler
// ---------------------------------------------------------------------------

async function handlePush(payload: PushPayload, config: RelayConfig): Promise<PushResult> {
  const { profile: profileName, cookies, localStorage, credentials } = payload;

  if (!profileName || typeof profileName !== "string") {
    throw new Error("profile name is required");
  }
  // Reject path-traversal payloads before constructing any file path.
  // Also validates name length (1–64) and character set.
  if (!isValidProfileName(profileName)) {
    throw new Error(
      `Invalid profile name "${profileName}". Must be 1-64 alphanumeric, hyphens, or underscores.`,
    );
  }

  // --- Cookies + localStorage → profile JSON ---
  // Defense in depth: assertSafeProfilePath validates the name AND confirms
  // the resolved path stays under profilesDir (catches bugs in the regex).
  const profilePath = assertSafeProfilePath(profileName, config.profilesDir);
  await fs.mkdir(config.profilesDir, { recursive: true });

  // Load existing profile state if it exists, merge new data
  let existingState: {
    cookies?: RelayCookie[];
    localStorage?: Record<string, Record<string, string>>;
    savedAt?: string;
  } = {};
  try {
    const raw = await fs.readFile(profilePath, "utf8");
    existingState = JSON.parse(raw);
  } catch {
    // New profile
  }

  // Merge cookies: new cookies override existing ones (by name+domain+path)
  const mergedCookies = [...(existingState.cookies ?? [])];
  if (cookies?.length) {
    for (const newCookie of cookies) {
      const idx = mergedCookies.findIndex(
        (c) =>
          c.name === newCookie.name && c.domain === newCookie.domain && c.path === newCookie.path,
      );
      if (idx >= 0) {
        mergedCookies[idx] = newCookie;
      } else {
        mergedCookies.push(newCookie);
      }
    }
  }

  // Merge localStorage: new origins override existing, within an origin new keys override
  const mergedLS: Record<string, Record<string, string>> = { ...existingState.localStorage };
  if (localStorage) {
    for (const [origin, entries] of Object.entries(localStorage)) {
      mergedLS[origin] = { ...mergedLS[origin], ...entries };
    }
  }

  const state = {
    cookies: mergedCookies,
    localStorage: mergedLS,
    savedAt: new Date().toISOString(),
    pushedFrom: "extension",
  };
  await fs.writeFile(profilePath, JSON.stringify(state, null, 2));

  // --- Credentials ---
  let credentialSaved = false;
  if (credentials && credentials.name && credentials.username && credentials.password) {
    const creds = await loadCreds(config.credentialsFile, config.credentialsPassphrase);
    const now = new Date().toISOString();
    const existing = creds.findIndex((c) => c.name === credentials.name);
    const cred: Credential = {
      name: credentials.name,
      url: credentials.url || profileName,
      username: credentials.username,
      password: credentials.password,
      ...(credentials.extra ? { extra: credentials.extra } : {}),
      createdAt: existing >= 0 ? creds[existing].createdAt : now,
      updatedAt: now,
    };
    if (existing >= 0) {
      creds[existing] = cred;
    } else {
      creds.push(cred);
    }
    await saveCreds(creds, config.credentialsFile, config.credentialsPassphrase);
    credentialSaved = true;
  }

  return {
    profile: profileName,
    cookieCount: cookies?.length ?? 0,
    localStorageOrigins: localStorage ? Object.keys(localStorage) : [],
    credentialSaved,
    message:
      `Profile "${profileName}" updated with ${cookies?.length ?? 0} cookies` +
      (localStorage ? `, localStorage from ${Object.keys(localStorage).length} origin(s)` : "") +
      (credentialSaved ? `, credential "${credentials!.name}" saved` : ""),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 5 * 1024 * 1024; // 5MB
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Timing-safe comparison — hashes both sides to equal lengths, then
// crypto.timingSafeEqual avoids leaking byte position of the first mismatch.
function timingSafeCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(json);
}

export function startRelayServer(config: RelayConfig): http.Server {
  const srv = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    // GET /status — no auth required
    if (req.method === "GET" && url.pathname === "/status") {
      jsonResponse(res, 200, { ok: true, server: "steel-mcp-relay", version: "1.0.0" });
      return;
    }

    // POST /push — requires auth
    if (req.method === "POST" && url.pathname === "/push") {
      // Auth check — timing-safe to avoid leaking the expected secret length
      // or the position of the first mismatch byte.
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${config.secret}`;
      if (!authHeader || !timingSafeCompare(authHeader, expected)) {
        jsonResponse(res, 401, { error: "Unauthorized. Set the correct RELAY_SECRET." });
        return;
      }

      try {
        const body = await readBody(req);
        const payload = JSON.parse(body) as PushPayload;
        const result = await handlePush(payload, config);
        jsonResponse(res, 200, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 400, { error: msg });
      }
      return;
    }

    // 404
    jsonResponse(res, 404, { error: "Not found. Endpoints: GET /status, POST /push" });
  });

  srv.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[steel-mcp] Relay port ${config.port} already in use (another session's relay is running). Continuing without relay.`,
      );
      srv.close();
    } else {
      console.error(`[steel-mcp] Relay server error: ${err.message}`);
    }
  });

  srv.listen(config.port, config.bindAddr, () => {
    console.error(`[steel-mcp] Relay server listening on http://${config.bindAddr}:${config.port}`);
  });

  // Don't block Node process exit
  srv.unref();

  return srv;
}
