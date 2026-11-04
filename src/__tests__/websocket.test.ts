import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "patchright";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";

test("settle injection on document load preserves page WebSocket upgrades", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(
        "<!doctype html><title>WebSocket fixture</title><body>Local fixture</body>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const profile = await mkdtemp(join(tmpdir(), "steel-websocket-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    timeout: 5000,
    args: ["--no-sandbox"],
  });
  try {
    const page = context.pages()[0];
    const mgr = new BrowserManager(
      EnvSchema.parse({ BROWSER_MODE: "local", TAB_IDLE_TIMEOUT_MS: "0" }),
    );
    const internals = mgr as unknown as { allocateTab(page: Page): number };
    internals.allocateTab(page);
    for (const path of ["/first", "/second"]) {
      await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => typeof (window as unknown as { __steelSettle?: unknown }).__steelSettle === "object",
        undefined,
        { timeout: 3000 },
      );
      const reply = await page.evaluate(
        (port) =>
          new Promise<string>((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/echo`);
            const timeout = setTimeout(() => {
              socket.close();
              reject(new Error("WebSocket echo timed out"));
            }, 3000);
            socket.onopen = () => socket.send("settle-preserves-websocket");
            socket.onmessage = (event) => {
              clearTimeout(timeout);
              socket.close();
              resolve(String(event.data));
            };
            socket.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebSocket upgrade failed"));
            };
          }),
        server.port,
      );
      expect(reply).toBe("settle-preserves-websocket");
    }
  } finally {
    await context.close();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 20000);
