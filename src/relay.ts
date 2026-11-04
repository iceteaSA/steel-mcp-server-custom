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
 *   GET /profiles, GET /profiles/:name — saved domains and counts only
 *   DELETE /profiles/:name/domains/:domain — remove one saved hostname
 */

import crypto from "crypto";
import http from "http";
import fs from "fs/promises";
import path from "path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { assertSafeProfilePath, isValidProfileName } from "./helpers.js";
import { WebSocket, WebSocketServer } from "ws";
import { SigninStore, type SigninRequest } from "./signin.js";
import { withProfileWrite, writeProfileData } from "./profile-store.js";

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
  signinStore?: SigninStore;
  onProfileUpdated?: (profile: string) => boolean | void | Promise<boolean | void>;
}

const domainSchema = z
  .string()
  .max(253)
  .regex(/^\.?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/);
const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
});
const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: domainSchema,
  path: z.string().startsWith("/"),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z
    .enum(["Strict", "Lax", "None", "No_restriction"])
    .transform((value) => (value === "No_restriction" ? "None" : value))
    .optional(),
});
const storageSchema = z.record(originSchema, z.record(z.string(), z.string()));
const pushSchema = z.object({
  profile: z.string().refine(isValidProfileName),
  cookies: z.array(cookieSchema).optional(),
  localStorage: storageSchema.optional(),
  credentials: z
    .object({
      name: z.string(),
      url: z.string(),
      username: z.string(),
      password: z.string(),
      extra: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});
const stateSchema = z
  .object({
    cookies: z.array(cookieSchema).optional(),
    localStorage: storageSchema.optional(),
  })
  .passthrough();
type ProfileState = z.infer<typeof stateSchema>;

async function readProfile(name: string, config: RelayConfig): Promise<ProfileState> {
  const file = assertSafeProfilePath(name, config.profilesDir);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid profile file");
  return stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

async function writeProfile(name: string, state: ProfileState, config: RelayConfig): Promise<void> {
  const file = assertSafeProfilePath(name, config.profilesDir);
  await writeProfileData(file, state);
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

function summarizeProfile(name: string, state: ProfileState) {
  const domains = new Map<
    string,
    { domain: string; cookieCount: number; storageKeyCount: number }
  >();
  const entry = (domain: string) => {
    const normalized = normalizeDomain(domain);
    if (!domains.has(normalized))
      domains.set(normalized, { domain: normalized, cookieCount: 0, storageKeyCount: 0 });
    return domains.get(normalized)!;
  };
  for (const cookie of state.cookies ?? []) entry(cookie.domain).cookieCount++;
  for (const [origin, storage] of Object.entries(state.localStorage ?? {})) {
    entry(new URL(origin).hostname).storageKeyCount += Object.keys(storage).length;
  }
  return { name, domains: [...domains.values()].sort((a, b) => a.domain.localeCompare(b.domain)) };
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
  await fs.chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (passphrase) {
    await fs.writeFile(file, encryptJSON(creds, passphrase), { mode: 0o600 });
  } else {
    await fs.writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  await fs.chmod(file, 0o600);
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
  await withProfileWrite(assertSafeProfilePath(profileName, config.profilesDir), async () => {
    let existingState: ProfileState = {};
    try {
      existingState = await readProfile(profileName, config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    await writeProfile(profileName, state, config);
  });

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
      (credentialSaved ? ", credential saved" : ""),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    const MAX_BODY = 5 * 1024 * 1024; // 5MB
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // An error response before the complete request can cause a connection error.
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) {
        reject(Object.assign(new Error("Request body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
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
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function rejectSocket(socket: Duplex, status: 403 | 503, error: string): void {
  socket.once("error", () => socket.destroy());
  const body = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy(),
  );
}

export function startRelayServer(config: RelayConfig): http.Server {
  const accepted = new Set<Duplex>();
  const httpSockets = new Set<Duplex>();
  const refusedHttp = new WeakSet<Duplex>();
  const admittedWebSockets = new Set<WebSocket>();
  let signinStore: Promise<SigninStore> | undefined;
  const getSigninStore = () =>
    (signinStore ??= config.signinStore
      ? Promise.resolve(config.signinStore)
      : SigninStore.open({ profilesDir: config.profilesDir }));
  // Each update reads and writes a complete file. Concurrent updates can discard data.
  let mutations: Promise<unknown> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutations.then(operation);
    mutations = next.catch(() => {});
    return next;
  };
  const srv = http.createServer(async (req, res) => {
    if (refusedHttp.has(req.socket)) return;
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? "")) {
      jsonResponse(res, 403, { error: "Forbidden host." });
      return;
    }
    // Extension host permissions give access without CORS.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    // GET /status — no auth required
    if (req.method === "GET" && url.pathname === "/status") {
      jsonResponse(res, 200, { ok: true, server: "steel-mcp-relay", version: "1.0.0" });
      return;
    }

    const profilesRoute = url.pathname === "/profiles" || url.pathname.startsWith("/profiles/");
    const signinRoute = url.pathname === "/signin" || url.pathname.startsWith("/signin/");
    if ((req.method === "POST" && url.pathname === "/push") || profilesRoute || signinRoute) {
      // Auth check — timing-safe to avoid leaking the expected secret length
      // or the position of the first mismatch byte.
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${config.secret}`;
      if (!authHeader || !timingSafeCompare(authHeader, expected)) {
        if (signinRoute && req.method !== "GET") {
          try {
            await (await getSigninStore()).audit(undefined, "rejected:unauthorized");
          } catch {
            console.error("[steel-mcp] Sign-in audit unavailable.");
          }
          req.resume();
          res.setHeader("Connection", "close");
        }
        jsonResponse(res, 401, { error: "Unauthorized. Set the correct RELAY_SECRET." });
        return;
      }

      try {
        if (signinRoute) {
          const store = await getSigninStore();
          const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
          if (req.method === "GET" && segments.length === 1) {
            jsonResponse(res, 200, { requests: await store.pending() });
            return;
          }
          if (segments[1] === "grants") {
            if (req.method === "GET" && segments.length === 2) {
              jsonResponse(res, 200, { grants: await store.grants() });
              return;
            }
            if (req.method === "DELETE" && segments.length === 3) {
              await store.revoke(segments[2]);
              jsonResponse(res, 200, { ok: true });
              return;
            }
          }
          if (req.method === "POST" && segments.length === 3) {
            let request: SigninRequest | undefined;
            try {
              const body: unknown = JSON.parse(await readBody(req));
              request = await store.request(segments[1]);
              if (segments[2] === "deny") {
                const { note } = z
                  .object({ note: z.string().max(1000).optional() })
                  .strict()
                  .parse(body);
                const result = await mutate(() => store.deny(segments[1], note));
                jsonResponse(res, 200, result);
                return;
              }
              if (segments[2] === "push") {
                const payload = pushSchema
                  .omit({ credentials: true })
                  .extend({
                    cookies: z
                      .array(cookieSchema.extend({ hostOnly: z.boolean().optional() }))
                      .optional(),
                    remember: z.boolean().optional(),
                    useGrant: z.boolean().optional(),
                    note: z.string().max(1000).optional(),
                  })
                  .strict()
                  .parse(body);
                const counts = await mutate(() =>
                  store.consume(segments[1], {
                    validate: (pending) => {
                      if (payload.useGrant && !pending.remembered)
                        throw new Error("signin_grant_required");
                      if (payload.profile !== pending.profile)
                        throw new Error("signin_profile_mismatch");
                      if (
                        (payload.cookies ?? []).some(
                          (cookie) => !pending.domains.includes(normalizeDomain(cookie.domain)),
                        )
                      )
                        throw new Error("signin_site_mismatch");
                      for (const cookie of payload.cookies ?? []) {
                        if (
                          (cookie.name.startsWith("__Secure-") ||
                            cookie.name.startsWith("__Host-")) &&
                          cookie.secure !== true
                        )
                          throw new Error("signin_cookie_prefix");
                        if (
                          cookie.name.startsWith("__Host-") &&
                          (cookie.path !== "/" ||
                            cookie.hostOnly !== true ||
                            cookie.domain.startsWith(".") ||
                            normalizeDomain(cookie.domain) !== pending.domains[0])
                        )
                          throw new Error("signin_cookie_prefix");
                      }
                      if (
                        Object.keys(payload.localStorage ?? {}).some(
                          (origin) =>
                            !pending.domains.includes(new URL(origin).hostname) ||
                            (pending.site.includes("://")
                              ? origin !== pending.site
                              : new URL(origin).protocol !== "https:" ||
                                new URL(origin).port !== ""),
                        )
                      )
                        throw new Error("signin_site_mismatch");
                    },
                    write: async () => {
                      await handlePush(
                        {
                          ...payload,
                          cookies: payload.cookies?.map(
                            ({ hostOnly: _hostOnly, ...cookie }) => cookie,
                          ),
                        },
                        config,
                      );
                      return {
                        cookieCount: payload.cookies?.length ?? 0,
                        storageKeyCount: Object.values(payload.localStorage ?? {}).reduce(
                          (sum, entries) => sum + Object.keys(entries).length,
                          0,
                        ),
                      };
                    },
                    remember: payload.remember === true,
                    note: payload.note,
                  }),
                );
                // A live apply error must not cause a second state write.
                let liveApplied = false;
                try {
                  if (config.onProfileUpdated)
                    liveApplied = (await config.onProfileUpdated(counts.profile)) !== false;
                } catch {
                  liveApplied = false;
                }
                jsonResponse(res, 200, {
                  id: counts.id,
                  status: counts.status,
                  ...counts.counts,
                  liveApplied,
                });
                return;
              }
            } catch (error) {
              const tooLarge = (error as NodeJS.ErrnoException).code === "BODY_TOO_LARGE";
              const code = tooLarge
                ? "body_too_large"
                : error instanceof Error &&
                    /^signin_(unknown|used|expired|cancelled|denied|site_mismatch|profile_mismatch|grant_required|cookie_prefix)$/.test(
                      error.message,
                    )
                  ? error.message
                  : "signin_invalid";
              await store.audit(request, `rejected:${code}`);
              if (tooLarge) res.setHeader("Connection", "close");
              jsonResponse(res, tooLarge ? 413 : code === "signin_used" ? 409 : 400, {
                error: code,
              });
              return;
            }
          }
          jsonResponse(res, 404, { error: "Unknown sign-in endpoint." });
          return;
        }
        if (req.method === "POST" && url.pathname === "/push") {
          const payload = pushSchema.parse(JSON.parse(await readBody(req)));
          const result = await mutate(() => handlePush(payload, config));
          jsonResponse(res, 200, result);
          return;
        }
        await mutations;
        if (req.method === "GET" && url.pathname === "/profiles") {
          const files = await fs
            .readdir(config.profilesDir)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
          const names = files
            .filter((file) => file.endsWith(".json"))
            .map((file) => file.slice(0, -5))
            .filter(isValidProfileName)
            .sort();
          const profiles = [];
          for (const name of names)
            profiles.push(summarizeProfile(name, await readProfile(name, config)));
          jsonResponse(res, 200, { profiles });
          return;
        }
        const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
        const name = segments[1];
        if (!isValidProfileName(name ?? "")) {
          jsonResponse(res, 400, {
            error: "Use a profile name with 1-64 letters, digits, hyphens, or underscores.",
          });
          return;
        }
        if (req.method === "GET" && segments.length === 2) {
          jsonResponse(res, 200, summarizeProfile(name, await readProfile(name, config)));
          return;
        }
        if (req.method === "DELETE" && segments.length === 4 && segments[2] === "domains") {
          const domain = normalizeDomain(domainSchema.parse(segments[3]));
          const summary = await mutate(() =>
            withProfileWrite(assertSafeProfilePath(name, config.profilesDir), async () => {
              const state = await readProfile(name, config);
              state.cookies = (state.cookies ?? []).filter(
                (cookie) => normalizeDomain(cookie.domain) !== domain,
              );
              state.localStorage = Object.fromEntries(
                Object.entries(state.localStorage ?? {}).filter(
                  ([origin]) => new URL(origin).hostname.toLowerCase() !== domain,
                ),
              );
              state.savedAt = new Date().toISOString();
              await writeProfile(name, state, config);
              return summarizeProfile(name, state);
            }),
          );
          jsonResponse(res, 200, summary);
          return;
        }
        jsonResponse(res, 404, { error: "Not found. Check the relay endpoint." });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "BODY_TOO_LARGE") {
          res.setHeader("Connection", "close");
          jsonResponse(res, 413, { error: "body_too_large" });
          return;
        }
        // Parse errors can include sign-in values or private file paths.
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        jsonResponse(res, missing ? 404 : 400, {
          error: missing
            ? "Profile not found. Refresh the profile list."
            : "Request or saved profile is invalid. Check the profile name and data; check relay file permissions.",
        });
      }
      return;
    }

    // 404
    jsonResponse(res, 404, { error: "Not found. Endpoints: GET /status, POST /push" });
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  srv.on("connection", (socket: Duplex) => {
    accepted.add(socket);
    socket.once("close", () => {
      accepted.delete(socket);
      httpSockets.delete(socket);
    });
    if (httpSockets.size >= 64) {
      refusedHttp.add(socket);
      rejectSocket(socket, 503, "connection_limit");
      return;
    }
    httpSockets.add(socket);
  });
  srv.on("upgrade", (req, socket, head) => {
    if (refusedHttp.has(socket)) return;
    if (
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host ?? "") ||
      req.url !== "/signin/events"
    ) {
      socket.destroy();
      return;
    }
    if (
      req.headers.origin !== undefined &&
      !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)
    ) {
      rejectSocket(socket, 403, "forbidden_origin");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (admittedWebSockets.size >= 16) {
        ws.close(1013, "Relay connection limit");
        const deadline = setTimeout(() => ws.terminate(), 100);
        deadline.unref();
        ws.once("close", () => clearTimeout(deadline));
        return;
      }
      httpSockets.delete(socket);
      admittedWebSockets.add(ws);
      ws.once("close", () => admittedWebSockets.delete(ws));
      sockets.emit("connection", ws);
    });
  });
  sockets.on("connection", (ws) => {
    let authenticated = false;
    let unsubscribe: (() => void) | undefined;
    const authExpires = Date.now() + 2000;
    const deadline = setTimeout(() => ws.close(1008, "Authentication timeout"), 2000);
    const keepalive = setInterval(() => {
      if (authenticated && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "keepalive" }));
    }, 20_000);
    keepalive.unref();
    ws.on("error", () => {});
    ws.on("message", async (data, binary) => {
      if (authenticated) return;
      try {
        if (Date.now() >= authExpires || ws.readyState !== WebSocket.OPEN) throw new Error();
        const message: unknown = JSON.parse(data.toString());
        const parsed = z
          .object({ secret: z.string().max(4096) })
          .strict()
          .parse(message);
        if (binary || !timingSafeCompare(parsed.secret, config.secret)) throw new Error();
        // The store read is asynchronous. Set authentication first to prevent duplicate listeners.
        authenticated = true;
        clearTimeout(deadline);
        const store = await getSigninStore();
        if (ws.readyState !== WebSocket.OPEN) return;
        const sendPending = () => {
          void store
            .pending()
            .then((requests) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "pending", requests }));
            })
            .catch(() => ws.close(1011, "Store unavailable"));
        };
        store.on("change", sendPending);
        unsubscribe = () => store.removeListener("change", sendPending);
        sendPending();
      } catch {
        ws.close(1008, "Authentication failed");
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      clearInterval(keepalive);
      unsubscribe?.();
    });
  });
  const closeHttp = srv.close.bind(srv);
  let closing: Promise<void> | undefined;
  srv.close = (callback?: (error?: Error) => void): http.Server => {
    closing ??= new Promise<void>((resolve) => {
      for (const ws of sockets.clients) ws.terminate();
      for (const socket of accepted) socket.destroy();
      sockets.close();
      if (!config.signinStore) void signinStore?.then((store) => store.close());
      let finished = false;
      // Bun does not always call the HTTP close callback after a WebSocket upgrade.
      // Socket destruction does not prevent this.
      const deadline = setTimeout(() => {
        console.error(
          "[steel-mcp] Relay close callback timed out; all accepted sockets were terminated.",
        );
        finish();
      }, 500);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        resolve();
      }
      closeHttp(() => finish());
    });
    if (callback) void closing.then(() => callback());
    return srv;
  };

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
