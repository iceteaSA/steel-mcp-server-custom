import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { BrowserContext } from "playwright";
import type { BrowserManager, Env } from "../manager.js";
import {
  cleanErrorMessage,
  deriveDownloadFilename,
  matchesCookieHost,
  mimeToExt,
  validateCookies,
} from "../helpers.js";
import { withBackgroundTab } from "../utils.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // cookies -------------------------------------------------------------------
  register({
    name: "cookies",
    title: "Browser Cookies",
    description: `Get or set browser cookies for the current session. Default: return all cookies (filter by domain or URL). Pass setCookies to inject cookies (e.g. restore a saved session from a previous run). The set mode does NOT persist across browser restarts — use save_profile for durable session storage. Do NOT use to transfer cookies between profiles; each profile has its own isolated cookie jar.

CONTEXT BUDGET — default cap: 50 cookies. Set limit=0 for all.`,
    toolset: "network",
    inputSchema: {
      domain: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Filter by domain (e.g. 'github.com'). Preferred over urls."),
      urls: z
        .array(z.string())
        .optional()
        .describe("Filter by full URLs. Falls back to host-contains if exact match empty."),
      limit: z.number().optional().describe("Max cookies returned. Default 50. Set 0 for all."),
      setCookies: z
        .array(
          z
            .object({
              name: z.string(),
              value: z.string(),
              url: z.string().optional(),
              domain: z.string().optional(),
              path: z.string().optional(),
              expires: z.number().optional(),
              httpOnly: z.boolean().optional(),
              secure: z.boolean().optional(),
              sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
            })
            .passthrough(),
        )
        .optional()
        .describe(
          "Inject cookies into the browser context. Each needs name+value and either url or domain+path.",
        ),
    },
    outputSchema: {
      cookies: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            domain: z.string(),
            path: z.string(),
          }),
        )
        .optional(),
      count: z.number().optional(),
    },
    annotations: {
      readOnlyHint: false, // set mode mutates
      destructiveHint: false,
      idempotentHint: true, // get is idempotent; set is also safe to repeat
      openWorldHint: false,
    },
    handler: async ({ urls, domain, limit, setCookies }) => {
      try {
        await mgr.initialize();
        const ctx = mgr.context!;

        // Set mode — inject cookies and return
        if (setCookies && setCookies.length > 0) {
          const violations = validateCookies(setCookies);
          if (violations.length > 0) {
            return {
              isError: true,
              content: [{ type: "text", text: violations.join("\n") }],
            };
          }
          await ctx.addCookies(setCookies as Parameters<BrowserContext["addCookies"]>[0]);
          return {
            content: [{ type: "text", text: `Set ${setCookies.length} cookie(s).` }],
            structuredContent: { count: setCookies.length },
          };
        }

        // Get mode
        const cap = limit === undefined ? 50 : limit;
        let cookies = await ctx.cookies(urls);

        // Fallback: if urls filter returned nothing, retry with host-contains match.
        if (urls && urls.length > 0 && cookies.length === 0) {
          const all = await ctx.cookies();
          const hosts = urls
            .map((u: string) => {
              try {
                return new URL(u).hostname;
              } catch {
                return u;
              }
            })
            .filter(Boolean);
          cookies = all.filter((c) => hosts.some((h: string) => matchesCookieHost(c.domain, h)));
        }

        // Domain filter (substring match — handles leading-dot + subdomain quirks)
        if (domain) {
          const domains = (Array.isArray(domain) ? domain : [domain]).map((d) => d.toLowerCase());
          cookies = cookies.filter((c) => {
            const cd = (c.domain || "").toLowerCase();
            return domains.some((d) => cd.includes(d));
          });
        }

        const total = cookies.length;
        const truncated = cap > 0 && total > cap;
        if (truncated) {
          cookies = cookies.slice(0, cap);
        }

        if (total === 0) {
          const hint = urls
            ? " (no match for urls; try the `domain` param instead)"
            : domain
              ? " (no match for domain)"
              : "";
          return {
            content: [{ type: "text", text: `No cookies in the browser context.${hint}` }],
            structuredContent: { cookies: [] },
          };
        }

        const body = JSON.stringify(cookies, null, 2);
        const footer = truncated
          ? `\n\n[CAPPED — ${total} total cookies in context, returning first ${cap}. Set limit=0 or use domain/urls filter for full list.]`
          : "";

        const structured = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
        }));

        return {
          content: [{ type: "text", text: body + footer }],
          structuredContent: { cookies: structured },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // download_file -------------------------------------------------------------
  register({
    name: "download_file",
    title: "Download File",
    description: `Download a URL to disk using browser cookies for authentication. Handles both Content-Disposition attachment downloads and inline binary files (auto-fallback to fetch). Use for downloading PDFs, images, spreadsheets, or any file behind authentication. Uses a temporary background tab so the caller's active tab is never navigated away — do NOT use for small text responses (use fetch_urls instead).`,
    toolset: "media",
    inputSchema: {
      url: z.string().describe("The download URL to fetch."),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Absolute path to save the download under. Defaults to OUTPUT_DIR/<suggestedFilename>.",
        ),
      timeout: z
        .number()
        .min(1000)
        .max(120000)
        .default(30000)
        .optional()
        .describe(
          "Timeout in ms for the download event (before falling back to fetch). Default: 30000.",
        ),
      forceFetch: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Skip the download-event path and go straight to context.request.fetch. Useful when you know the URL has no Content-Disposition.",
        ),
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    // tabId is kept in the schema for backward compatibility — downloads now
    // use a temporary tab so the caller's active tab is never navigated away.
    handler: async ({ url, outputPath, timeout = 30000, forceFetch = false, tabId: _tabId }) => {
      const saveViaFetch = async (via: string): Promise<string> => {
        const ctx = mgr.context!;
        const resp = await ctx.request.fetch(url, { timeout: timeout + 5000 });
        if (!resp.ok()) {
          throw new Error(`fetch fallback HTTP ${resp.status()} ${resp.statusText()}`);
        }
        const body = await resp.body();
        let suggested = deriveDownloadFilename(url);
        if (!path.extname(suggested)) {
          const ext = mimeToExt(resp.headers()["content-type"] ?? null);
          if (ext) suggested += ext;
        }
        const savePath = outputPath ?? path.join(env.OUTPUT_DIR, suggested);
        await fs.mkdir(path.dirname(savePath), { recursive: true });
        await fs.writeFile(savePath, body);
        const stat = await fs.stat(savePath);
        return `Downloaded ${suggested} [via ${via}]\nSaved to: ${savePath}\nSize: ${stat.size.toLocaleString()} bytes`;
      };

      try {
        if (forceFetch) {
          return {
            content: [{ type: "text", text: await saveViaFetch("forceFetch") }],
          };
        }

        // Use a temporary background tab so the caller's active tab is
        // never navigated away and the active-tab pointer is preserved.
        const resultText = await withBackgroundTab(mgr, async (page) => {
          try {
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout }),
              page.goto(url).catch((err) => {
                const msg = (err as Error).message;
                if (
                  !/ERR_ABORTED|net::ERR_ABORTED|Download is starting|Cannot load download URL/i.test(
                    msg,
                  )
                ) {
                  throw err;
                }
              }),
            ]);
            const suggested = download.suggestedFilename() || deriveDownloadFilename(url);
            const savePath = outputPath ?? path.join(env.OUTPUT_DIR, suggested);
            await fs.mkdir(path.dirname(savePath), { recursive: true });
            try {
              await download.saveAs(savePath);
            } catch (saveErr) {
              const sMsg = (saveErr as Error).message;
              if (/ENOENT|no such file or directory|copyfile/i.test(sMsg)) {
                return await saveViaFetch("fetch-fallback-after-saveAs-ENOENT");
              }
              throw saveErr;
            }
            const stat = await fs.stat(savePath);
            return `Downloaded ${suggested} [via download-event]\nSaved to: ${savePath}\nSize: ${stat.size.toLocaleString()} bytes`;
          } catch (err) {
            const msg = (err as Error).message;
            if (!/waitForEvent.*[Tt]imeout|Timeout.*waitForEvent|Timeout.*download/.test(msg)) {
              throw err;
            }
            return await saveViaFetch("fetch-fallback");
          }
        });

        return { content: [{ type: "text", text: resultText }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
