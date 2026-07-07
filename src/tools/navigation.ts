import { z } from "zod";
import type { Page } from "playwright";
import type { BrowserManager, Env } from "../manager.js";
import { afterAction, sleep } from "../utils.js";
import {
  CAPTCHA_POLL_INTERVAL_MS,
  CAPTCHA_WAIT_TOTAL_MS,
  cleanErrorMessage,
  detectErrorPage,
  ErrorTracker,
  extractPageContent,
  isBotWall,
} from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";
import { tabTargetForce } from "./shared.js";

// Module-level ErrorTracker instance — persists across tool calls.
const errorTracker = new ErrorTracker();

// Tracks pages with active media-blocking routes so we can restore media
// without a tab-id lookup. Page identity survives tab resets better than
// numeric IDs, and the WeakSet avoids leaking memory when pages close.
const mediaBlockedTabs = new WeakSet<Page>();

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // go_to_url -----------------------------------------------------------------
  register({
    name: "go_to_url",
    title: "Navigate to URL",
    description: `Navigate the current tab to a URL and return the final URL + page title. Auto-detects bot walls (waits up to 15s for CapSolver auto-solve) and HTTP error pages (404/5xx). Combine with readPage to extract text in the same call, or waitFor to pause until a selector appears. Use this as the primary navigation tool — do NOT use new_tab just to change pages.

CONTEXT BUDGET — when readPage=true, extracted text capped at maxChars (default 5K).`,
    toolset: "core",
    inputSchema: {
      url: z.string().describe("The URL to navigate to."),
      readPage: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Extract page text after navigation (combines navigate + get_page_text into one call). Uses smart content-area detection. Default: false.",
        ),
      maxChars: z
        .number()
        .default(5000)
        .optional()
        .describe("When readPage=true, max chars of page text to include. Default: 5000."),
      waitFor: z
        .string()
        .optional()
        .describe(
          "Optional CSS selector to wait for after navigation. Replaces a separate wait_for call for list-page scraping. Defaults to no wait.",
        ),
      waitTimeout: z
        .number()
        .default(10000)
        .optional()
        .describe("Timeout in ms for waitFor. Default: 10000."),
      disableMedia: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Block images, fonts, stylesheets, and media during navigation. Faster for text-only scraping. Default: false.",
        ),
      ...tabTargetForce,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      url,
      readPage = false,
      maxChars = 5000,
      waitFor,
      waitTimeout = 10000,
      disableMedia = false,
      tabId,
      owner,
      force,
    }) => {
      try {
        // Check error history before navigating — prepend warning if URL has
        // previously returned 404 or triggered a bot wall.
        const priorWarning = errorTracker.check(url);

        const page = await mgr.getPage({ tabId, owner, force });

        // Block heavy resources if requested (images, fonts, CSS, media).
        // Tracks per-page state so repeated calls don't stack routes and so
        // disableMedia=false can unblock previously blocked pages.
        let mediaNote = "";
        const alreadyBlocked = mediaBlockedTabs.has(page);
        if (disableMedia && !alreadyBlocked) {
          await page.route("**/*", (route) => {
            const type = route.request().resourceType();
            if (["image", "font", "stylesheet", "media"].includes(type)) {
              return route.abort();
            }
            return route.continue();
          });
          mediaBlockedTabs.add(page);
          mediaNote = "\nMedia blocking enabled.";
        } else if (!disableMedia && alreadyBlocked) {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          mediaBlockedTabs.delete(page);
          if (env.OPTIMIZE_BANDWIDTH) {
            mediaNote =
              "\nRoute-level media blocking disabled (session-level OPTIMIZE_BANDWIDTH still active).";
          } else {
            mediaNote = "\nMedia blocking disabled.";
          }
        }

        await page.goto(url, { waitUntil: "domcontentloaded" });
        await afterAction(page, env);

        let finalUrl = page.url();
        let title = await page.title().catch(() => "");

        // Bot-check / CAPTCHA detection. If CapSolver is configured, wait up
        // to 15s for it to auto-solve before returning isError. Without a
        // CapSolver key, fail immediately — no point waiting.
        if (isBotWall(title, finalUrl)) {
          const hasCapSolver = !!process.env.CAPSOLVER_API_KEY;
          let solved = false;
          if (hasCapSolver) {
            const deadline = Date.now() + CAPTCHA_WAIT_TOTAL_MS;
            while (Date.now() < deadline) {
              await sleep(CAPTCHA_POLL_INTERVAL_MS);
              title = await page.title().catch(() => "");
              finalUrl = page.url();
              if (!isBotWall(title, finalUrl)) {
                solved = true;
                break;
              }
            }
          }
          if (!solved) {
            errorTracker.record(url);
            const waitNote = hasCapSolver
              ? ` (waited ${CAPTCHA_WAIT_TOTAL_MS / 1000}s for CapSolver)`
              : " (no CAPSOLVER_API_KEY set — skipped auto-solve wait)";
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Bot-check wall detected${waitNote}. title="${title}" url=${finalUrl}. Hand off to user via start_browser (Interactive URL).`,
                },
              ],
            };
          }
          // CapSolver solved it — continue with normal response
        }

        // HTTP error page detection (404, 5xx, etc.)
        const errorStatus = detectErrorPage(title);
        if (errorStatus) {
          errorTracker.record(url);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `HTTP ${errorStatus} — ${title}. URL: ${finalUrl}`,
              },
            ],
          };
        }

        // Optional wait for content selector
        let waitMsg = "";
        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: waitTimeout });
            waitMsg = `\nwaitFor "${waitFor}" matched.`;
          } catch {
            waitMsg = `\nwaitFor "${waitFor}" TIMED OUT after ${waitTimeout}ms (page loaded but selector missing).`;
          }
        }

        const navLine =
          finalUrl !== url
            ? `Navigated to ${url}\nFinal URL: ${finalUrl}`
            : `Navigated to ${finalUrl}`;
        const pageTitle = title || (await page.title().catch(() => ""));
        const titleLine = pageTitle ? `\nTitle: ${pageTitle}` : "";

        // Optional page text extraction (readPage)
        let pageText = "";
        if (readPage) {
          try {
            const rawText: string =
              (
                await page.evaluate(extractPageContent, {
                  selector: null,
                  includeLinks: false,
                  mode: "innerText" as const,
                })
              ).text ?? "";
            let cleaned = rawText
              .replace(/[^\S\n]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            if (maxChars > 0 && cleaned.length > maxChars) {
              cleaned =
                cleaned.slice(0, maxChars) +
                `\n[TRUNCATED — ${cleaned.length.toLocaleString()} total chars]`;
            }
            pageText = "\n---\n" + cleaned;
          } catch {
            pageText = "\n---\n[readPage: failed to extract text]";
          }
        }

        const warningPrefix = priorWarning ? `[WARNING: ${priorWarning}]\n` : "";
        return {
          content: [
            {
              type: "text",
              text: warningPrefix + navLine + titleLine + waitMsg + mediaNote + pageText,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // history -------------------------------------------------------------------
  register({
    name: "history",
    title: "Navigate History",
    description: `Navigate the current tab through its browser history: back (previous page), forward (next page), or reload (refresh). Use after clicking a link to go back, or to reload a stale page. Do NOT use for initial navigation — use go_to_url to load a URL for the first time.`,
    toolset: "core",
    inputSchema: {
      action: z
        .enum(["back", "forward", "reload"])
        .describe(
          "History action: 'back' (previous page), 'forward' (next page), 'reload' (refresh current page).",
        ),
      ...tabTargetForce,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ action, tabId, owner, force }) => {
      try {
        const page = await mgr.getPage({ tabId, owner, force });
        const beforeUrl = page.url();
        let navResult: Awaited<ReturnType<typeof page.goBack>> | null = null;
        if (action === "back") {
          navResult = await page.goBack({ waitUntil: "commit", timeout: 10000 });
        } else if (action === "forward") {
          navResult = await page.goForward({ waitUntil: "commit", timeout: 10000 });
        } else {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
        }
        await afterAction(page, env);
        const afterUrl = page.url();
        const verb =
          action === "back" ? "Went back" : action === "forward" ? "Went forward" : "Reloaded";
        const noOp =
          (action === "back" || action === "forward") &&
          navResult === null &&
          beforeUrl === afterUrl;
        const suffix = noOp
          ? ` — no history entry to go ${action === "back" ? "back" : "forward"} to. URL unchanged: ${beforeUrl}`
          : "";
        const pageTitle = await page.title().catch(() => "");
        const titlePart = pageTitle ? `\nTitle: ${pageTitle}` : "";
        return {
          content: [
            { type: "text", text: `${verb}${suffix}.\nCurrent URL: ${afterUrl}${titlePart}` },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
