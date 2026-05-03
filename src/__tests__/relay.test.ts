import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { startRelayServer, type PushPayload, type RelayConfig } from "../relay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: http.Server;
let tmpDir: string;
let config: RelayConfig;

async function fetch_(url: string, opts?: RequestInit): Promise<Response> {
  return fetch(url, opts);
}

function postPush(payload: PushPayload, secret = "test-secret") {
  return fetch_(`http://127.0.0.1:${config.port}/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  config = {
    port: 0, // will pick a random available port
    secret: "test-secret",
    profilesDir: path.join(tmpDir, "profiles"),
    credentialsFile: path.join(tmpDir, "credentials.json"),
  };

  server = startRelayServer(config);

  // Wait for the server to start listening and grab the actual port
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        config.port = addr.port;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean profiles dir between tests
  await fs.rm(config.profilesDir, { recursive: true, force: true }).catch(() => {});
  await fs.unlink(config.credentialsFile).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /status", () => {
  it("returns ok without auth", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/status`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.server).toBe("steel-mcp-relay");
  });
});

describe("POST /push — auth", () => {
  it("rejects without Authorization header", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with wrong secret", async () => {
    const res = await postPush({ profile: "test" }, "wrong-secret");
    expect(res.status).toBe(401);
  });
});

describe("POST /push — cookies", () => {
  it("creates a profile with cookies", async () => {
    const res = await postPush({
      profile: "github",
      cookies: [
        { name: "session", value: "abc123", domain: ".github.com", path: "/" },
        { name: "_gh_sess", value: "xyz", domain: "github.com", path: "/", httpOnly: true, secure: true },
      ],
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.cookieCount).toBe(2);
    expect(data.profile).toBe("github");

    // Verify file on disk
    const profilePath = path.join(config.profilesDir, "github.json");
    const raw = await fs.readFile(profilePath, "utf8");
    const state = JSON.parse(raw);
    expect(state.cookies).toHaveLength(2);
    expect(state.pushedFrom).toBe("extension");
  });

  it("merges cookies on second push", async () => {
    // First push
    await postPush({
      profile: "merge-test",
      cookies: [
        { name: "a", value: "1", domain: "example.com", path: "/" },
        { name: "b", value: "2", domain: "example.com", path: "/" },
      ],
    });

    // Second push — overwrites cookie "a", adds "c"
    await postPush({
      profile: "merge-test",
      cookies: [
        { name: "a", value: "updated", domain: "example.com", path: "/" },
        { name: "c", value: "3", domain: "example.com", path: "/" },
      ],
    });

    const raw = await fs.readFile(path.join(config.profilesDir, "merge-test.json"), "utf8");
    const state = JSON.parse(raw);
    expect(state.cookies).toHaveLength(3); // a (updated), b, c
    const cookieA = state.cookies.find((c: any) => c.name === "a");
    expect(cookieA.value).toBe("updated");
  });
});

describe("POST /push — localStorage", () => {
  it("saves localStorage alongside cookies", async () => {
    const res = await postPush({
      profile: "ls-test",
      cookies: [{ name: "s", value: "v", domain: "example.com", path: "/" }],
      localStorage: {
        "https://example.com": { token: "jwt-abc", theme: "dark" },
      },
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.localStorageOrigins).toContain("https://example.com");

    const raw = await fs.readFile(path.join(config.profilesDir, "ls-test.json"), "utf8");
    const state = JSON.parse(raw);
    expect(state.localStorage["https://example.com"].token).toBe("jwt-abc");
  });

  it("merges localStorage across pushes", async () => {
    await postPush({
      profile: "ls-merge",
      localStorage: { "https://a.com": { k1: "v1" } },
    });
    await postPush({
      profile: "ls-merge",
      localStorage: { "https://a.com": { k2: "v2" }, "https://b.com": { k3: "v3" } },
    });

    const raw = await fs.readFile(path.join(config.profilesDir, "ls-merge.json"), "utf8");
    const state = JSON.parse(raw);
    expect(state.localStorage["https://a.com"]).toEqual({ k1: "v1", k2: "v2" });
    expect(state.localStorage["https://b.com"]).toEqual({ k3: "v3" });
  });
});

describe("POST /push — credentials", () => {
  it("saves credentials to the credential store", async () => {
    const res = await postPush({
      profile: "cred-test",
      cookies: [{ name: "s", value: "v", domain: "github.com", path: "/" }],
      credentials: {
        name: "github",
        url: "github.com",
        username: "user@example.com",
        password: "hunter2",
      },
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.credentialSaved).toBe(true);

    // Verify credential file
    const raw = await fs.readFile(config.credentialsFile, "utf8");
    const creds = JSON.parse(raw);
    expect(creds).toHaveLength(1);
    expect(creds[0].name).toBe("github");
    expect(creds[0].username).toBe("user@example.com");
  });

  it("updates existing credential by name", async () => {
    // First push
    await postPush({
      profile: "cred-update",
      credentials: { name: "site", url: "site.com", username: "old", password: "old" },
    });

    // Second push — same name, new password
    await postPush({
      profile: "cred-update",
      credentials: { name: "site", url: "site.com", username: "old", password: "new" },
    });

    const raw = await fs.readFile(config.credentialsFile, "utf8");
    const creds = JSON.parse(raw);
    expect(creds).toHaveLength(1);
    expect(creds[0].password).toBe("new");
  });
});

describe("POST /push — encrypted credentials", () => {
  it("encrypts and decrypts credentials with passphrase", async () => {
    const encConfig: RelayConfig = {
      port: 0, // random port — must NOT inherit config.port which is already bound
      secret: "test-secret",
      profilesDir: config.profilesDir,
      credentialsFile: path.join(tmpDir, "encrypted-creds.json"),
      credentialsPassphrase: "test-passphrase-123",
    };

    // Create a second relay to test encryption
    const srv2 = startRelayServer(encConfig);
    await new Promise<void>((resolve) => {
      srv2.on("listening", () => {
        const addr = srv2.address();
        if (addr && typeof addr === "object") encConfig.port = addr.port;
        resolve();
      });
    });

    try {
      const res = await fetch_(`http://127.0.0.1:${encConfig.port}/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${encConfig.secret}`,
        },
        body: JSON.stringify({
          profile: "enc-test",
          credentials: { name: "secret-site", url: "secret.com", username: "u", password: "p" },
        }),
      });
      expect(res.ok).toBe(true);

      // Verify file is encrypted (not valid JSON)
      const raw = await fs.readFile(encConfig.credentialsFile, "utf8");
      expect(() => JSON.parse(raw)).toThrow(); // It's base64, not JSON
    } finally {
      srv2.close();
    }
  });
});

describe("POST /push — validation", () => {
  it("rejects empty profile name", async () => {
    const res = await postPush({ profile: "" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.secret}`,
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("404", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("handles OPTIONS preflight", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
