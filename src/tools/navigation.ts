import { z } from "zod";
import { clipText } from "../page-output.js";
import type { Page } from "patchright";
import type { BrowserManager, Env } from "../manager.js";
import { afterAction, actionFeedback } from "../utils.js";
import { awaitCaptcha, formatCaptchaResult } from "../captcha.js";
import {
  cleanErrorMessage,
  detectErrorPage,
  ErrorTracker,
  extractPageContent,
} from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";
import { tabTargetForce } from "./shared.js";
import { policyErrorResult } from "../site-policy.js";

// Module-level ErrorTracker instance — persists across tool calls.
const errorTracker = new ErrorTracker();

// Tracks pages with active media-blocking routes so we can restore media
// without a tab-id lookup. Page identity survives tab resets better than
// numeric IDs, and the WeakSet avoids leaking memory when pages close.
const mediaBlockedTabs = new WeakSet<Page>();

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  register({
    name: "block_site",
    title: "Block Site",
    toolset: "core",
    description:
      "Add a registrable domain to your lane deny list. This also blocks its subdomains. Entries cannot be removed and expire with the lane. In lanes-off mode the list belongs to the process. Omit site to list the effective shared and lane entries. A site requires a reason.",
    inputSchema: {
      site: z.string().min(1).max(2048).optional(),
      reason: z.string().trim().min(1).max(500).optional(),
    },
    outputSchema: {
      sites: z.array(
        z.object({
          domain: z.string(),
          source: z.enum(["shared", "lane"]),
          reason: z.string().optional(),
        }),
      ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({ site, reason }) => {
      try {
        const result = await mgr.blockSite(site, reason);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  });
  // go_to_url -----------------------------------------------------------------
  register({
    name: "go_to_url",
    title: "Navigate to URL",
    description: `Navigate the current tab to a URL and return the final URL + page title. Detects CAPTCHA widgets and bot walls, then waits up to 90s for the CapSolver extension (CAPTCHA_WAIT_TOTAL_MS overrides). No CAPTCHA means no added wait. Returns solved or an actionable failure; use solve_captcha for an explicit paid API fallback, or start_browser for handoff. Also detects HTTP error pages (404/5xx). Combine with readPage to extract text in the same call, or waitFor to pause until a selector appears. Use this as the primary navigation tool — do NOT use new_tab just to change pages.

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
      destructiveHint: true,
      idempotentHint: false,
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
          await page.route("**/*", async (route) => {
            if (await mgr.guardPolicy?.(route)) return;
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

        const navigate = () => page.goto(url, { waitUntil: "domcontentloaded" });
        await (mgr.navigate ? mgr.navigate(page, navigate) : navigate());
        await afterAction(page, env);

        let finalUrl = page.url();
        let title = await page.title().catch(() => "");

        const captcha = await awaitCaptcha(page);
        const captchaLine = formatCaptchaResult(captcha);
        if (captcha.status !== "none" && captcha.status !== "solved") {
          errorTracker.record(url);
          return { isError: true, content: [{ type: "text", text: captchaLine }] };
        }
        title = await page.title().catch(() => "");
        finalUrl = page.url();

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

        // Remember the final URL for crash recovery so the tab can be
        // restored to the last successful navigation target.
        const resolvedForLastUrl = mgr.resolveTab({ tabId, owner, force });
        mgr.setTabLastUrl(resolvedForLastUrl, finalUrl);

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
                clipText(cleaned, maxChars) +
                `\n[TRUNCATED — ${cleaned.length.toLocaleString()} total chars]`;
            }
            pageText = "\n---\n" + cleaned;
          } catch {
            pageText = "\n---\n[readPage: failed to extract text]";
          }
        }

        // Update snapshot baseline (silent when readPage already reports content).
        const resolved = mgr.resolveTab({ tabId, owner, force });
        const navFeedback = await actionFeedback(page, resolved, {
          navigated: true,
          silent: readPage,
        });

        const pageNotice = mgr.dialogNotice(resolved) + mgr.consumeRecoveryNotice(resolved);
        const warningPrefix = priorWarning ? `[WARNING: ${priorWarning}]\n` : "";
        return {
          content: [
            {
              type: "text",
              text:
                warningPrefix +
                navLine +
                (captchaLine ? `\n${captchaLine}` : "") +
                titleLine +
                waitMsg +
                mediaNote +
                pageText +
                (navFeedback ? `\n${navFeedback}` : "") +
                pageNotice,
            },
          ],
        };
      } catch (err) {
        const policy = policyErrorResult(err);
        if (policy) return policy;
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
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ action, tabId, owner, force }) => {
      try {
        const page = await mgr.getPage({ tabId, owner, force });
        const beforeUrl = page.url();
        let navResult: Awaited<ReturnType<typeof page.goBack>> | null = null;
        if (action === "back") {
          const navigate = () => page.goBack({ waitUntil: "commit", timeout: 10000 });
          navResult = await (mgr.navigate ? mgr.navigate(page, navigate) : navigate());
        } else if (action === "forward") {
          const navigate = () => page.goForward({ waitUntil: "commit", timeout: 10000 });
          navResult = await (mgr.navigate ? mgr.navigate(page, navigate) : navigate());
        } else {
          const navigate = () => page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
          await (mgr.navigate ? mgr.navigate(page, navigate) : navigate());
        }
        await afterAction(page, env);
        const afterUrl = page.url();

        // Snapshot feedback — compute navigated from actual URL comparison.
        // Reload is always a navigation even if the URL stays the same
        // (content may have changed), and no-ops report navigated:false.
        const resolved = mgr.resolveTab({ tabId, owner, force });
        mgr.setTabLastUrl(resolved, afterUrl);
        const histFeedback = await actionFeedback(page, resolved, {
          navigated: afterUrl !== beforeUrl || action === "reload",
        });
        const feedbackText = histFeedback ? `\n${histFeedback}` : "";
        const pageNotice = mgr.dialogNotice(resolved) + mgr.consumeRecoveryNotice(resolved);

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
            {
              type: "text",
              text: `${verb}${suffix}.\nCurrent URL: ${afterUrl}${titlePart}${feedbackText}${pageNotice}`,
            },
          ],
        };
      } catch (err) {
        const policy = policyErrorResult(err);
        if (policy) return policy;
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
