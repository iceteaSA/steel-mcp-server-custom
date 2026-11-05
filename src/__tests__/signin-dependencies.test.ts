import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { SigninStore } from "../signin.js";
import { register as signin } from "../tools/signin.js";
import type { ToolSpec } from "../tools/shared.js";

test("sign-in registration uses explicit shared dependencies and resolves the caller per call", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-deps-"));
  const env = EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: directory, RELAY_PORT: 0 });
  const manager = new BrowserManager(env);
  const store = await SigninStore.open({ profilesDir: directory, automaticTimers: false });
  const specs: ToolSpec[] = [];
  let caller = "first";
  Reflect.apply(signin, undefined, [(spec: ToolSpec) => specs.push(spec), manager, env, { signin: { store: Promise.resolve(store), getCaller: () => caller } }]);
  try {
    const request = specs.find((spec) => spec.name === "request_signin")!;
    for (const value of ["first", "second"]) {
      caller = value;
      const result = await request.handler({ site: "https://example.test", profile: value, reason: "fixture" });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.status).toBe("pending");
    }
    expect((await store.pending()).map((request) => request.caller.sessionID)).toEqual(["first", "second"]);
    expect(manager.tabIds).toEqual([]);
  } finally {
    store.close();
    await manager.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
