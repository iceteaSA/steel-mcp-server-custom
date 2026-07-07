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
  validateUrlPattern,
} from "../helpers.js";
import { withBackgroundTab, writeToFile } from "../utils.js";
import type { ToolRegistrar } from "./shared.js";
import { tabTarget } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // cookies -------------------------------------------------------------------
  register({
    name: "cookies",
    title: "Browser Cookies",
    description: `Get or set browser cookies for the current session. Default: return all cookies (filter by domain or URL); pass setCookies to inject cookies (e.g. restore a saved session). Set mode does NOT persist across browser restarts — use save_profile for durable storage. Do NOT use to transfer cookies between profiles; each profile has its own isolated cookie jar.

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

  // get_network ---------------------------------------------------------------
  register({
    name: "get_network",
    title: "Network Traffic",
    description: `Inspect the request/response traffic a page has generated (XHR, fetch, document, scripts, etc.). Useful for finding API endpoints, debugging SPA loads, or verifying form submissions. Returns a compact list by default; set body=true (or pass requestId) to fetch one response body on demand.

CONTEXT BUDGET — default limit 30 lines; body capped at 10K chars and downgraded to file mode if it exceeds MAX_INLINE_BYTES.`,
    toolset: "network",
    inputSchema: {
      urlPattern: z
        .string()
        .optional()
        .describe("Filter by URL substring (e.g. '/api/') or /regex/ (e.g. /api\\/i)."),
      resourceType: z
        .string()
        .optional()
        .describe(
          "Filter by Playwright resource type (e.g. 'xhr', 'fetch', 'script', 'document').",
        ),
      status: z
        .string()
        .optional()
        .describe("Filter by status: exact digits (200, 404) or range (4xx, 5xx)."),
      limit: z.number().default(30).optional().describe("Max events to return. Default 30."),
      body: z
        .boolean()
        .optional()
        .describe(
          "Return the response body of the single matching request. Requires exactly one match unless requestId is given.",
        ),
      requestId: z
        .number()
        .int()
        .optional()
        .describe("Exact network event id to fetch body for. Overrides body matching."),
      ...tabTarget,
    },
    outputSchema: {
      events: z
        .array(
          z.object({
            id: z.number(),
            method: z.string(),
            url: z.string(),
            resourceType: z.string(),
            status: z.number().optional(),
            sizeBytes: z.number().optional(),
            durationMs: z.number().optional(),
          }),
        )
        .optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({
      urlPattern,
      resourceType,
      status,
      limit = 30,
      body,
      requestId,
      tabId,
      owner,
    }: {
      urlPattern?: string;
      resourceType?: string;
      status?: string;
      limit?: number;
      body?: boolean;
      requestId?: number;
      tabId?: number;
      owner?: string;
    }) => {
      try {
        if (urlPattern) {
          const validationError = validateUrlPattern(urlPattern);
          if (validationError) {
            return {
              isError: true,
              content: [{ type: "text", text: validationError }],
              structuredContent: { events: [] },
            };
          }
        }

        // Only scope to a resolved tab when the caller explicitly asked for one.
        // Untabbed events (tabId undefined) are visible only without a tab/owner
        // filter, matching the requestId cross-tab isolation rule.
        const resolved =
          tabId !== undefined || owner ? mgr.resolveTab({ tabId, owner }) : undefined;
        const events = mgr.getNetworkEvents({
          urlPattern,
          resourceType,
          status,
          tabId: resolved,
          owner,
          limit,
        });

        if (body || requestId !== undefined) {
          let targetId: number | undefined;
          if (requestId !== undefined) {
            // Enforce scope: the requested id must be visible through the same
            // tab/owner filter used for the list path.
            if (!events.some((e) => e.id === requestId)) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `requestId ${requestId} not found in your tabs`,
                  },
                ],
                structuredContent: { events },
              };
            }
            targetId = requestId;
          } else {
            if (events.length !== 1) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `${events.length} matches; pass requestId to fetch a specific body, or narrow the filter so exactly one request matches.`,
                  },
                ],
                structuredContent: { events },
              };
            }
            targetId = events[0]?.id;
          }
          if (targetId === undefined) {
            return {
              isError: true,
              content: [{ type: "text", text: "No matching network request found." }],
              structuredContent: { events },
            };
          }

          const bodyText = await mgr.getResponseBody(targetId);
          const capped =
            bodyText.length > 10000
              ? bodyText.slice(0, 10000) + "\n[TRUNCATED at 10000 chars]"
              : bodyText;
          if (Buffer.byteLength(capped) > env.MAX_INLINE_BYTES) {
            const filePath = await writeToFile(
              Buffer.from(capped, "utf8"),
              `network-body-${targetId}.txt`,
              env,
            );
            return {
              content: [{ type: "text", text: `Body written to: ${filePath}` }],
              structuredContent: { events: [] },
            };
          }
          return { content: [{ type: "text", text: capped }], structuredContent: { events: [] } };
        }

        const lines = events.map((e: any) => {
          const statusOrFailed = e.failed ? "FAILED" : (e.status ?? "-");
          const size = e.sizeBytes !== undefined ? `${e.sizeBytes}B` : "-";
          const duration = e.durationMs !== undefined ? `${e.durationMs}ms` : "-";
          return `#${e.id} ${e.method} ${statusOrFailed} ${e.resourceType} ${e.url} (${size} ${duration})`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") || "No network events matched." }],
          structuredContent: { events },
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: cleanErrorMessage(error) }],
          structuredContent: { events: [] },
        };
      }
    },
  });
}
