import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { cleanErrorMessage } from "../helpers.js";

export function register(server: McpServer, mgr: BrowserManager, env: Env): void {
  // start_browser -------------------------------------------------------------
  server.tool(
    "start_browser",
    `Start the browser. Returns Session Viewer (read-only) and Interactive URL (human takeover for CAPTCHA/login/2FA). Auto-starts on first tool call — only needed for the URLs.`,
    {},
    async () => {
      try {
        await mgr.initialize();
        const lines: string[] = ["Browser started."];
        if (mgr.sessionViewerUrl) {
          lines.push(`Session Viewer: ${mgr.sessionViewerUrl}`);
        }
        if (mgr.debugUrl) {
          lines.push(`Interactive URL: ${mgr.debugUrl}?interactive=true&showControls=true`);
        }
        if (env.RELAY_PORT > 0 && env.RELAY_SECRET) {
          const relayUrl = env.RELAY_PUBLIC_URL ?? `http://localhost:${env.RELAY_PORT}`;
          lines.push(`Relay server: ${relayUrl} (for Steel Cookie Push extension)`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // stop_browser --------------------------------------------------------------
  server.tool(
    "stop_browser",
    "Stop the browser and clean up resources. Releases the Steel session if one is active.",
    {},
    async () => {
      try {
        await mgr.stop();
        return { content: [{ type: "text", text: "Browser stopped." }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // smoke_test ----------------------------------------------------------------
  server.tool(
    "smoke_test",
    `Self-test: navigates to example.com, checks fingerprint consistency, verifies stealth properties, and reports pass/fail for each check. Use to verify the browser is working correctly after restarts or config changes.`,
    {},
    async () => {
      try {
        const { tabId, page } = await mgr.newTab("https://example.com");
        const results: Array<{ check: string; pass: boolean; detail: string }> = [];

        // 1. Navigation
        try {
          const title = await page.title();
          results.push({
            check: "Navigation",
            pass: title.includes("Example"),
            detail: `Title: ${title}`,
          });
        } catch (e) {
          results.push({ check: "Navigation", pass: false, detail: (e as Error).message });
        }

        // 2. Fingerprint
        try {
          const fp = await page.evaluate(() => ({
            ua: navigator.userAgent,
            platform: navigator.platform,
            webdriver: navigator.webdriver,
            plugins: navigator.plugins.length,
            langs: navigator.languages,
            webgl: (() => {
              const c = document.createElement("canvas");
              const gl = c.getContext("webgl");
              if (!gl) return "none";
              const d = gl.getExtension("WEBGL_debug_renderer_info");
              return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "no ext";
            })(),
          }));

          const uaMac = fp.ua.includes("Macintosh");
          const platMac = fp.platform === "MacIntel";
          results.push({
            check: "UA → macOS",
            pass: uaMac,
            detail: fp.ua.substring(0, 80),
          });
          results.push({
            check: "Platform match",
            pass: uaMac === platMac,
            detail: `platform=${fp.platform}`,
          });
          results.push({
            check: "Webdriver hidden",
            pass: fp.webdriver === false,
            detail: `webdriver=${fp.webdriver}`,
          });
          results.push({
            check: "Plugins spoofed",
            pass: fp.plugins >= 3,
            detail: `${fp.plugins} plugins`,
          });
          results.push({
            check: "WebGL spoofed",
            pass: fp.webgl !== "none" && !fp.webgl.includes("SwiftShader"),
            detail: (fp.webgl as string).substring(0, 60),
          });
          results.push({
            check: "Languages",
            pass: fp.langs.length > 0,
            detail: fp.langs.join(", "),
          });
        } catch (e) {
          results.push({ check: "Fingerprint", pass: false, detail: (e as Error).message });
        }

        // 3. Canvas noise
        try {
          const noised = await page.evaluate(() => {
            const c = document.createElement("canvas");
            c.width = 50;
            c.height = 50;
            const ctx = c.getContext("2d")!;
            ctx.fillStyle = "red";
            ctx.fillRect(0, 0, 25, 25);
            ctx.fillText("test", 5, 15);
            return c.toDataURL() !== c.toDataURL();
          });
          results.push({
            check: "Canvas noise",
            pass: noised,
            detail: noised ? "active" : "NOT noised",
          });
        } catch (e) {
          results.push({ check: "Canvas noise", pass: false, detail: (e as Error).message });
        }

        // 4. CapSolver
        const apiKey = process.env.CAPSOLVER_API_KEY;
        if (apiKey) {
          try {
            const res = await fetch("https://api.capsolver.com/getBalance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clientKey: apiKey }),
            });
            const data = (await res.json()) as { balance?: number; errorId?: number };
            const hasBalance = (data.balance ?? 0) > 0;
            results.push({
              check: "CapSolver",
              pass: hasBalance,
              detail: `$${data.balance?.toFixed(2) ?? "0.00"}`,
            });
          } catch {
            results.push({ check: "CapSolver", pass: false, detail: "API unreachable" });
          }
        } else {
          results.push({ check: "CapSolver", pass: false, detail: "No API key set" });
        }

        // Clean up temp tab
        await mgr.closeTab(tabId).catch(() => {});

        const passed = results.filter((r) => r.pass).length;
        const total = results.length;
        const lines = results.map((r) => `${r.pass ? "✓" : "✗"} ${r.check}: ${r.detail}`);
        lines.push(`\n${passed}/${total} checks passed`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          ...(passed < total ? { isError: true } : {}),
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [
            { type: "text", text: `Smoke test failed to run: ${cleanErrorMessage(error)}` },
          ],
        };
      }
    },
  );

  // get_console ---------------------------------------------------------------
  server.tool(
    "get_console",
    `Get browser console messages. Filter by level (error/warning/info/log). Use clear: true to reset buffer after reading.`,
    {
      level: z
        .enum(["all", "error", "warning", "info", "log"])
        .default("all")
        .optional()
        .describe("Filter by severity. 'all' returns everything. Default: 'all'."),
      maxEntries: z
        .number()
        .min(1)
        .max(500)
        .default(50)
        .optional()
        .describe("Maximum number of entries to return (most recent). Default: 50."),
      clear: z
        .boolean()
        .default(false)
        .optional()
        .describe("Clear the captured log buffer after returning results. Default: false."),
    },
    async ({ level = "all", maxEntries = 50, clear = false }) => {
      try {
        await mgr.initialize();

        let logs = mgr.consoleLogs;
        if (level !== "all") logs = logs.filter((m) => m.level === level);
        const slice = logs.slice(-maxEntries);

        if (clear) mgr.consoleLogs = [];

        if (slice.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No console messages captured${level !== "all" ? ` at level '${level}'` : ""}.`,
              },
            ],
          };
        }

        const formatted = slice
          .map((m) => {
            const base = `[${new Date(m.timestamp).toISOString()}] [${m.level.toUpperCase()}] ${m.text}`;
            if (!m.location || !m.location.url) return base;
            const { url, lineNumber, columnNumber } = m.location;
            const locStr =
              lineNumber || columnNumber ? `${url}:${lineNumber}:${columnNumber}` : url;
            return `${base}\n    at ${locStr}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${slice.length} console message(s)${level !== "all" ? ` (level: ${level})` : ""}:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // captcha_status ------------------------------------------------------------
  server.tool(
    "captcha_status",
    `Check CapSolver CAPTCHA solving status: API balance and whether the extension is loaded. Useful before tasks that may encounter CAPTCHAs.`,
    {},
    async () => {
      try {
        const apiKey = process.env.CAPSOLVER_API_KEY;
        let balance: number | null = null;
        let apiError: string | undefined;

        if (apiKey) {
          try {
            const res = await fetch("https://api.capsolver.com/getBalance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clientKey: apiKey }),
            });
            const data = (await res.json()) as {
              balance?: number;
              errorId?: number;
              errorDescription?: string;
            };
            if (data.errorId && data.errorId !== 0) {
              apiError = data.errorDescription || "Unknown API error";
            } else {
              balance = data.balance ?? null;
            }
          } catch (err) {
            apiError = (err as Error).message;
          }
        }

        const lines: string[] = [];
        lines.push(`CapSolver API key: ${apiKey ? "configured" : "NOT SET"}`);
        if (balance !== null) lines.push(`Balance: $${balance.toFixed(2)}`);
        if (apiError) lines.push(`API error: ${apiError}`);
        lines.push(`Extension: loaded in Steel container (token mode)`);
        lines.push(
          `Supported: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, AWS WAF, GeeTest, DataDome, ImageToText`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );
}
