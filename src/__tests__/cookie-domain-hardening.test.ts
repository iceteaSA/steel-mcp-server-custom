import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { startRelayServer } from "../relay.js";
import { SigninStore } from "../signin.js";
import { domainSchema, readProfileData } from "../profile-store.js";

test("cookie domain validation admits underscores but no other new characters", () => {
  for (const domain of ["test_host.example.test", "_service.example.test", "service_.example.test", ".test_host.example.test"])
    expect(domainSchema.safeParse(domain).success).toBe(true);
  for (const domain of ["https://test_host.example.test", "test_host.example.test/path", "a b.test", "a:b.test", "a\\b.test", "a@test.test", "a%2eb.test", "a\u0000b.test", "-a.test", "a.test-", ".", "", "a".repeat(254)])
    expect(domainSchema.safeParse(domain).success).toBe(false);
});

for (const route of ["legacy", "signin"]) {
  test(`${route} push accepts an underscore cookie domain without broadening request scope`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cookie-domain-"));
    const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
    const relay = startRelayServer({ port: 0, bindAddr: "127.0.0.1", secret: "fixture-secret", profilesDir: directory, credentialsFile: path.join(directory, "credentials.json"), signinStore: store });
    await once(relay, "listening");
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("Missing relay address");
    const request = await store.create({ sessionID: "a" }, { site: "https://test_host.example.test", profile: "work", reason: "fixture" });
    const push = (domain: string) => fetch(`http://127.0.0.1:${address.port}${route === "legacy" ? "/push" : `/signin/${request.id}/push`}`, {
      method: "POST", headers: { Authorization: "Bearer fixture-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work", cookies: [{ name: "session", value: "COOKIE_CANARY", domain, path: "/" }] }),
    });
    try {
      if (route === "signin") {
        for (const domain of ["other_host.example.test", "test_host.example.test.evil.test", ".evil_test.test"]) {
          const denied = await push(domain);
          expect(denied.status).toBe(400);
          expect(await denied.json()).toEqual({ error: "signin_site_mismatch" });
          expect(await Bun.file(path.join(directory, "work.json")).exists()).toBe(false);
        }
      }
      const accepted = await push("test_host.example.test");
      expect(accepted.status).toBe(200);
      expect((await readProfileData(path.join(directory, "work.json"))).cookies?.map((cookie) => cookie.domain)).toEqual(["test_host.example.test"]);
    } finally {
      store.close();
      await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
