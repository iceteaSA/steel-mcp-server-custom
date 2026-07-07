import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { checkFingerprintConsistency, cleanErrorMessage } from "../helpers.js";
import { sleep } from "../utils.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // start_browser -------------------------------------------------------------
  register({
    name: "start_browser",
    title: "Start Browser",
    description: `Start the browser and return Session Viewer (read-only) and Interactive URL for human takeover (CAPTCHA, login, 2FA). The browser auto-starts on first tool call — call this only when you need the Interactive URL for a human-in-the-loop step. Do NOT use for routine navigation; tools like go_to_url auto-initialize.`,
    toolset: "core",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async () => {
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
  });

  // stop_browser --------------------------------------------------------------
  register({
    name: "stop_browser",
    title: "Stop Browser",
    description: `Stop the browser and release all resources (Steel session, tabs, profiles). Destroys the entire session — use close_tabs for per-agent cleanup instead. Do NOT call this unless you want to end the entire browser session for all agents.`,
    toolset: "core",
    inputSchema: {
      owner: z
        .string()
        .optional()
        .describe(
          "Your agent identity. When provided, checks whether other agents still have live tabs before stopping.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Override the safety check and kill everything even when other agents have live tabs.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ owner, force }) => {
      try {
        // Safety check: if the caller has an owner tag but other agents
        // still have live tabs, block unless force:true.
        if (owner && !force) {
          const others = mgr.ownersWithLiveTabs(owner);
          if (others.length > 0) {
            const totalTabs = others.reduce((sum, o) => sum + o.tabIds.length, 0);
            const ownerList = others
              .map((o) => `"${o.owner}" (tabs ${o.tabIds.join(",")})`)
              .join(", ");
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `stop_browser blocked: ${totalTabs} tabs owned by ${ownerList}. Use close_tabs({owner}) for your own cleanup, or force:true to kill everything.`,
                },
              ],
            };
          }
        }
        await mgr.stop();
        return { content: [{ type: "text", text: "Browser stopped." }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // smoke_test ----------------------------------------------------------------
  register({
    name: "smoke_test",
    title: "Smoke Test",
    description: `Self-test: navigates to example.com and bot.sannysoft.com, checks fingerprint consistency against the real browser identity, reports headless-detection failures, and verifies CapSolver balance. Use after browser restarts or config changes to verify stealth posture. Creates and cleans up its own test tab — does not affect your active tabs.`,
    toolset: "debug",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async () => {
      try {
        // Background tab so the test never moves the caller's active pointer.
        const { tabId, page } = await mgr.newTab(
          "https://example.com",
          "smoke:test",
          undefined,
          false,
        );
        const results: Array<{ check: string; pass: boolean; detail: string }> = [];
        const identity: {
          userAgent?: string;
          platform?: string;
          tz?: string;
          locale?: string;
          screen?: { width: number; height: number };
        } = {};

        // 1. Connectivity
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

        // 2. Fingerprint consistency — collect real browser identity.
        try {
          const raw = await page.evaluate(() => {
            const uaData = (
              navigator as Navigator & {
                userAgentData?: {
                  brands?: Array<{ brand: string; version: string }>;
                  platform?: string;
                  mobile?: boolean;
                };
              }
            ).userAgentData;
            return {
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              userAgentData: uaData
                ? {
                    brands: uaData.brands,
                    platform: uaData.platform,
                    mobile: uaData.mobile,
                  }
                : undefined,
              webdriver: navigator.webdriver,
              languages: Array.from(navigator.languages),
              pluginsCount: navigator.plugins.length,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              screen: { width: screen.width, height: screen.height },
            };
          });

          identity.userAgent = raw.userAgent;
          identity.platform = raw.platform;
          identity.tz = raw.timeZone;
          identity.locale = raw.languages[0] ?? "unknown";
          identity.screen = raw.screen;

          const consistency = checkFingerprintConsistency(raw);
          for (const c of consistency) {
            results.push({ check: c.check, pass: c.pass, detail: c.observed });
          }
        } catch (e) {
          results.push({
            check: "Fingerprint consistency",
            pass: false,
            detail: (e as Error).message,
          });
        }

        // 3. Headless-detection probe on bot.sannysoft.com
        let sannysoftFailures: string[] = [];
        try {
          await page.goto("https://bot.sannysoft.com", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          // Wait for the test table to populate (passed/warn/failed cells).
          await page
            .waitForFunction(
              () => document.querySelectorAll("td.failed, td.passed, td.warn").length >= 3,
              { timeout: 15000 },
            )
            .catch(() => {});
          // Give dynamic tests a moment to settle.
          await sleep(2000);

          sannysoftFailures = await page.evaluate(() => {
            const failures: string[] = [];
            for (const row of document.querySelectorAll("tr")) {
              const cells = Array.from(row.querySelectorAll("td, th"));
              if (cells.length < 2) continue;
              const failedCell = cells.find((c) => c.classList.contains("failed"));
              if (!failedCell) continue;
              const label = (cells[0].textContent ?? "").trim().replace(/\s+/g, " ");
              const status = (failedCell.textContent ?? "").trim().replace(/\s+/g, " ");
              failures.push(`${label}: ${status || "failed"}`);
            }
            return failures;
          });
        } catch (e) {
          results.push({
            check: "Headless detection probe",
            pass: false,
            detail: (e as Error).message,
          });
        }

        // 4. Canvas noise
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

        // 5. CapSolver
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

        // Build human-readable sections.
        const lines: string[] = [];
        lines.push("Connectivity:");
        const nav = results.find((r) => r.check === "Navigation");
        lines.push(
          nav ? `${nav.pass ? "✓" : "✗"} ${nav.check}: ${nav.detail}` : "? Navigation: unknown",
        );

        lines.push("\nFingerprint consistency:");
        const fpChecks = results.filter((r) =>
          [
            "webdriver hidden",
            "UA/platform consistency",
            "languages non-empty",
            "plugins count",
            "timeZone valid",
            "screen dimensions",
          ].includes(r.check),
        );
        for (const r of fpChecks) {
          lines.push(`${r.pass ? "✓" : "✗"} ${r.check}: ${r.detail}`);
        }

        lines.push("\nHeadless detection:");
        if (sannysoftFailures.length === 0) {
          lines.push("No failures reported by bot.sannysoft.com");
        } else {
          for (const f of sannysoftFailures.slice(0, 20)) {
            lines.push(`- ${f}`);
          }
        }

        lines.push("\nIdentity:");
        lines.push(`timeZone: ${identity.tz ?? "unknown"}`);
        lines.push(`locale: ${identity.locale ?? "unknown"}`);
        lines.push(
          `screen: ${identity.screen ? `${identity.screen.width}x${identity.screen.height}` : "unknown"}`,
        );
        lines.push(`ua: ${identity.userAgent ?? "unknown"}`);
        lines.push(`platform: ${identity.platform ?? "unknown"}`);
        lines.push(
          `\nNote: browser tz/locale reflect the Steel container config, not the proxy geo. Mismatches vs proxy geo require Steel-side configuration.`,
        );

        const fpPassed = fpChecks.filter((r) => r.pass).length;
        const fpTotal = fpChecks.length;
        lines.push(`\n${fpPassed}/${fpTotal} fingerprint consistency checks passed`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            checks: results,
            headlessFailures: sannysoftFailures.slice(0, 20),
            identity,
          },
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Smoke test failed to run: ${cleanErrorMessage(error)}`,
            },
          ],
        };
      }
    },
  });

  // get_console ---------------------------------------------------------------
  register({
    name: "get_console",
    title: "Get Console Logs",
    description: `Get browser console messages captured since the session started. Filter by severity level (error/warning/info/log), owner, or tabId, and optionally clear the buffer after reading. Use to debug JavaScript errors or verify page behavior. Do NOT use to check if a page loaded — use wait_for or go_to_url with waitFor instead.

CONTEXT BUDGET — output capped at maxEntries (default 50). The buffer holds up to 500 messages total.

NOTE: when clear=true with a filter, ALL entries captured up to read time are removed (not just the filtered level/tab). Messages arriving during the read survive.`,
    toolset: "debug",
    inputSchema: {
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
      tabId: z
        .number()
        .int()
        .optional()
        .describe("Filter to messages from a specific tab. Omit for all tabs."),
      owner: z
        .string()
        .optional()
        .describe("Filter to messages from tabs owned by this agent. Omit for all owners."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({ level = "all", maxEntries = 50, clear = false, tabId, owner }) => {
      try {
        await mgr.initialize();

        // Build the set of tabIds owned by the given owner for filtering.
        let ownerTabIds: Set<number> | undefined;
        if (owner) {
          const tabs = await mgr.listTabs();
          ownerTabIds = new Set(tabs.filter((t) => t.owner === owner).map((t) => t.tabId));
        }

        // Snapshot the array length at read start so splice removes only
        // entries that existed at that moment. Messages arriving between
        // snapshot and splice survive the clear.
        const snapshotLength = mgr.consoleLogs.length;
        let logs = mgr.consoleLogs;
        if (level !== "all") logs = logs.filter((m) => m.level === level);
        if (tabId !== undefined) logs = logs.filter((m) => m.tabId === tabId);
        // Owner filter excludes unattributed entries (tabId === undefined)
        // so logs from unregistered pages don't leak across owners.
        if (ownerTabIds)
          logs = logs.filter((m) => m.tabId !== undefined && ownerTabIds.has(m.tabId));
        const slice = logs.slice(-maxEntries);

        if (clear) {
          // Remove everything up to snapshotLength regardless of filter.
          mgr.consoleLogs.splice(0, snapshotLength);
        }

        if (slice.length === 0) {
          const filterParts: string[] = [];
          if (level !== "all") filterParts.push(`level '${level}'`);
          if (tabId !== undefined) filterParts.push(`tab ${tabId}`);
          if (owner) filterParts.push(`owner "${owner}"`);
          const filterNote = filterParts.length > 0 ? ` (filter: ${filterParts.join(", ")})` : "";
          return {
            content: [
              {
                type: "text",
                text: `No console messages captured${filterNote}.`,
              },
            ],
          };
        }

        const formatted = slice
          .map((m) => {
            const tag = m.tabId !== undefined ? `[tab ${m.tabId}] ` : "";
            const base = `[${new Date(m.timestamp).toISOString()}] ${tag}[${m.level.toUpperCase()}] ${m.text}`;
            if (!m.location || !m.location.url) return base;
            const { url, lineNumber, columnNumber } = m.location;
            const locStr =
              lineNumber || columnNumber ? `${url}:${lineNumber}:${columnNumber}` : url;
            return `${base}\n    at ${locStr}`;
          })
          .join("\n");

        const filterNote = level !== "all" ? ` (level: ${level})` : "";

        return {
          content: [
            {
              type: "text",
              text: `${slice.length} console message(s)${filterNote}:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // captcha_status ------------------------------------------------------------
  register({
    name: "captcha_status",
    title: "CAPTCHA Solver Status",
    description: `Check whether CapSolver CAPTCHA auto-solving is available: API key configured, balance, and supported CAPTCHA types. Use before tasks that may encounter CAPTCHAs (Cloudflare, reCAPTCHA, hCaptcha). The solver runs automatically during go_to_url — this tool is for pre-flight checks, not for solving.`,
    toolset: "debug",
    inputSchema: {},
    outputSchema: {
      apiKeyConfigured: z.boolean(),
      balance: z.number().nullable(),
      apiError: z.string().nullable(),
      supported: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async () => {
      try {
        const apiKey = process.env.CAPSOLVER_API_KEY;
        let balance: number | null = null;
        let apiError: string | null = null;

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

        const supported =
          "reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, AWS WAF, GeeTest, DataDome, ImageToText";

        const lines: string[] = [];
        lines.push(`CapSolver API key: ${apiKey ? "configured" : "NOT SET"}`);
        if (balance !== null) lines.push(`Balance: $${balance.toFixed(2)}`);
        if (apiError) lines.push(`API error: ${apiError}`);
        lines.push(`Extension: loaded in Steel container (token mode)`);
        lines.push(`Supported: ${supported}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            apiKeyConfigured: !!apiKey,
            balance,
            apiError,
            supported,
          },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
