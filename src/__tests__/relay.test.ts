import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
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
    bindAddr: "127.0.0.1",
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
  it("accepts only loopback Host spellings with optional ports", async () => {
    for (const host of [
      "localhost",
      "localhost:3921",
      "127.0.0.1",
      "127.0.0.1:3921",
      "[::1]",
      "[::1]:3921",
    ]) {
      expect(
        (await fetch_(`http://127.0.0.1:${config.port}/status`, { headers: { Host: host } }))
          .status,
      ).toBe(200);
    }
  });
  for (const route of ["/status", "/profiles"]) {
    it(`rejects a hostile Host on ${route} without reflecting Origin`, async () => {
      const response = await fetch_(`http://127.0.0.1:${config.port}${route}`, {
        headers: {
          Host: "evil.example",
          Origin: "https://evil.example",
          Authorization: "Bearer test-secret",
        },
      });
      expect(response.status).toBe(403);
      expect(Object.keys(await response.json())).toEqual(["error"]);
      expect(
        [...response.headers.keys()].some((key) => key.startsWith("access-control-allow-")),
      ).toBe(false);
    });
  }
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
        {
          name: "_gh_sess",
          value: "xyz",
          domain: "github.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
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
  for (const existed of [false, true]) {
    it(`saves credentials with mode 0600 when file ${existed ? "was 0644" : "is new"}`, async () => {
      if (existed) await fs.writeFile(config.credentialsFile, "[]", { mode: 0o644 });
      const response = await postPush({
        profile: "permissions",
        credentials: {
          name: "fixture",
          url: "example.com",
          username: "fixture-only",
          password: "fixture-only",
        },
      });
      expect(response.status).toBe(200);
      expect((await fs.stat(config.credentialsFile)).mode & 0o777).toBe(0o600);
    });
  }
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
      bindAddr: "127.0.0.1",
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
      await fs.writeFile(encConfig.credentialsFile, "[]", { mode: 0o644 });
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
      expect((await fs.stat(encConfig.credentialsFile)).mode & 0o777).toBe(0o600);

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

describe("POST /push — profile name traversal prevention", () => {
  it("rejects ../ path traversal", async () => {
    const res = await postPush({ profile: "../etc-passwd" });
    expect(res.status).toBe(400);
  });

  it("rejects path with slash separator", async () => {
    const res = await postPush({ profile: "a/b" });
    expect(res.status).toBe(400);
  });

  it("rejects absolute path", async () => {
    const res = await postPush({ profile: "/etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("rejects names longer than 64 characters", async () => {
    const res = await postPush({ profile: "x".repeat(65) });
    expect(res.status).toBe(400);
  });

  it("accepts valid name with hyphens and underscores", async () => {
    const res = await postPush({
      profile: "my-profile_1",
      cookies: [{ name: "a", value: "1", domain: "example.com", path: "/" }],
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.profile).toBe("my-profile_1");
  });

  it("accepts valid single-char name", async () => {
    const res = await postPush({
      profile: "x",
      cookies: [{ name: "a", value: "1", domain: "example.com", path: "/" }],
    });
    expect(res.ok).toBe(true);
  });
});

describe("404", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("answers OPTIONS without permitting web-origin access", async () => {
    const res = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(
      [...res.headers.keys()].filter((header) => header.startsWith("access-control-allow-")),
    ).toEqual([]);
  });

  it("does not expose GET replies to a web origin even with the secret", async () => {
    for (const route of ["/status", "/profiles"]) {
      const res = await fetch_(`http://127.0.0.1:${config.port}${route}`, {
        headers: { Origin: "https://evil.example", Authorization: "Bearer test-secret" },
      });
      expect(res.status).toBe(200);
      expect(
        [...res.headers.keys()].filter((header) => header.startsWith("access-control-allow-")),
      ).toEqual([]);
    }
  });
});

function profileRequest(route: string, method = "GET", secret: string | null = "test-secret") {
  return fetch_(`http://127.0.0.1:${config.port}${route}`, {
    method,
    headers: secret === null ? {} : { Authorization: `Bearer ${secret}` },
  });
}

describe("profile management", () => {
  it("accepts the 1.0.0 extension SameSite mapping", async () => {
    const response = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        profile: "legacy",
        cookies: [
          {
            name: "session",
            value: "fixture-only",
            domain: "example.com",
            path: "/",
            sameSite: "No_restriction",
            secure: true,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const state = JSON.parse(
      await fs.readFile(path.join(config.profilesDir, "legacy.json"), "utf8"),
    );
    expect(state.cookies[0].sameSite).toBe("None");
  });
  for (const [method, route] of [
    ["GET", "/profiles"],
    ["GET", "/profiles/work"],
    ["DELETE", "/profiles/work/domains/example.com"],
  ]) {
    it(`${method} ${route} requires correct Bearer auth`, async () => {
      expect((await profileRequest(route, method, null)).status).toBe(401);
      expect((await profileRequest(route, method, "wrong")).status).toBe(401);
    });
  }

  it("lists an empty directory", async () => {
    const response = await profileRequest("/profiles");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profiles: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  async function seedProfile() {
    await postPush({
      profile: "work",
      cookies: [
        {
          name: "private-cookie-name",
          value: "private-cookie-value",
          domain: ".example.com",
          path: "/",
        },
        { name: "other", value: "private-cookie-value", domain: "sub.example.com", path: "/" },
      ],
      localStorage: {
        "https://example.com": { "private-storage-key": "private-storage-value" },
        "http://example.com:8080": { another: "private-storage-value" },
        "https://sub.example.com": { another: "private-storage-value" },
      },
      credentials: {
        name: "private-credential-name",
        url: "example.com",
        username: "private-user",
        password: "private-password",
      },
    });
  }

  it("returns only names, domains, and counts in list and detail", async () => {
    await seedProfile();
    const expected = {
      name: "work",
      domains: [
        { domain: "example.com", cookieCount: 1, storageKeyCount: 2 },
        { domain: "sub.example.com", cookieCount: 1, storageKeyCount: 1 },
      ],
    };
    const list = await profileRequest("/profiles");
    expect(await list.json()).toEqual({ profiles: [expected] });
    const detail = await profileRequest("/profiles/work");
    expect(await detail.json()).toEqual(expected);
  });

  it("removes an exact normalized domain and preserves subdomains and credentials", async () => {
    await seedProfile();
    const response = await profileRequest("/profiles/work/domains/.EXAMPLE.com", "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "work",
      domains: [{ domain: "sub.example.com", cookieCount: 1, storageKeyCount: 1 }],
    });
    const state = JSON.parse(await fs.readFile(path.join(config.profilesDir, "work.json"), "utf8"));
    expect(state.cookies.length).toBe(1);
    expect(Object.keys(state.localStorage)).toEqual(["https://sub.example.com"]);
    expect(JSON.parse(await fs.readFile(config.credentialsFile, "utf8")).length).toBe(1);
    expect((await profileRequest("/profiles/work/domains/example.com", "DELETE")).status).toBe(200);
  });

  it("returns 404 for missing profiles", async () => {
    expect((await profileRequest("/profiles/missing")).status).toBe(404);
    expect((await profileRequest("/profiles/missing/domains/example.com", "DELETE")).status).toBe(
      404,
    );
  });

  it("rejects encoded traversal and invalid domains", async () => {
    expect((await profileRequest("/profiles/a%2Fb")).status).toBe(400);
    expect((await profileRequest("/profiles/work/domains/a%2Fb", "DELETE")).status).toBe(400);
  });

  it("does not expose malformed JSON content in errors", async () => {
    const response = await fetch_(`http://127.0.0.1:${config.port}/push`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: '{"password":"private-marker"',
    });
    expect(response.status).toBe(400);
    expect((await response.text()).includes("private-marker")).toBe(false);
  });

  it("does not expose credentials in push responses", async () => {
    const response = await postPush({
      profile: "safe",
      credentials: {
        name: "private-marker",
        url: "example.com",
        username: "private-marker",
        password: "private-marker",
      },
    });
    expect(response.status).toBe(200);
    expect((await response.text()).includes("private-marker")).toBe(false);
  });

  it("preserves all concurrent pushes to a profile", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        postPush({
          profile: "concurrent",
          cookies: [
            { name: `cookie-${i}`, value: "fixture-only", domain: "example.com", path: "/" },
          ],
        }),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    const detail = await profileRequest("/profiles/concurrent");
    expect((await detail.json()).domains[0].cookieCount).toBe(12);
  });

  it("does not overwrite corrupt profiles or follow symlinks", async () => {
    await fs.mkdir(config.profilesDir, { recursive: true });
    const file = path.join(config.profilesDir, "broken.json");
    await fs.writeFile(file, "not-json-private-marker");
    const response = await postPush({ profile: "broken" });
    expect(response.status).toBe(400);
    expect((await response.text()).includes("private-marker")).toBe(false);
    expect((await fs.readFile(file, "utf8")) === "not-json-private-marker").toBe(true);
    await fs.symlink(file, path.join(config.profilesDir, "link.json"));
    expect((await profileRequest("/profiles/link")).status).toBe(400);
  });

  it("does not authorize DELETE preflight", async () => {
    const response = await profileRequest("/profiles/work/domains/example.com", "OPTIONS", null);
    expect(response.status).toBe(204);
    expect(
      [...response.headers.keys()].filter((header) => header.startsWith("access-control-allow-")),
    ).toEqual([]);
  });
});
