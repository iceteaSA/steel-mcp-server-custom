import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import {
  buildRadioSelector,
  cleanErrorMessage,
  detectFieldKind,
  detectFieldsInPage,
  extractPageContent,
  interpretCheckboxValue,
} from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // click ---------------------------------------------------------------------
  register({
    name: "click",
    title: "Click Element",
    description: `Click a page element identified by CSS selector. Reports navigation if the URL changes. Optionally wait for a selector or text to appear after clicking (saves a separate wait_for call). Use for buttons, links, and any interactive element. Do NOT use to type text into inputs — use fill for form fields.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .describe(
          "CSS selector of the element to click (e.g. 'button[type=submit]', '#login', 'a.nav-link').",
        ),
      waitFor: z
        .string()
        .optional()
        .describe(
          "CSS selector to wait for after clicking (e.g. '#results', '.loaded'). Saves a separate wait_for call.",
        ),
      waitForText: z
        .string()
        .optional()
        .describe(
          "Text to wait for on the page after clicking (e.g. 'Order confirmed'). Alternative to waitFor selector.",
        ),
      waitTimeout: z
        .number()
        .min(100)
        .max(60000)
        .default(10000)
        .optional()
        .describe("Timeout in ms for waitFor/waitForText. Default: 10000."),
      timeout: z
        .number()
        .min(100)
        .max(30000)
        .default(10000)
        .optional()
        .describe("Max time in ms to wait for the element to be clickable. Default: 10000."),
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
    handler: async ({
      selector,
      waitFor,
      waitForText,
      waitTimeout = 10000,
      timeout = 10000,
      tabId,
    }) => {
      try {
        const page = await mgr.getPage(tabId);
        const beforeUrl = page.url();
        await page.click(selector, { timeout });
        await globalWait(env);

        let waitMsg = "";
        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: waitTimeout });
            waitMsg = `\nwaitFor "${waitFor}" matched.`;
          } catch {
            waitMsg = `\nwaitFor "${waitFor}" TIMED OUT after ${waitTimeout}ms.`;
          }
        }
        if (waitForText) {
          try {
            await page.waitForFunction(
              (t: string) => document.body?.innerText?.includes(t),
              waitForText,
              { timeout: waitTimeout },
            );
            waitMsg += `\nText "${waitForText}" appeared.`;
          } catch {
            waitMsg += `\nText "${waitForText}" NOT found after ${waitTimeout}ms.`;
          }
        }

        const afterUrl = page.url();
        const navigated = afterUrl !== beforeUrl;
        const navMsg = navigated ? `\nNavigated to: ${afterUrl}` : "";
        return { content: [{ type: "text", text: `Clicked: ${selector}${navMsg}${waitMsg}` }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // fill ----------------------------------------------------------------------
  register({
    name: "fill",
    title: "Fill Form",
    description: `Fill one or more form fields on the page. Auto-detects field types (text, select, checkbox, radio). Pass submitSelector to click a submit button after filling. Use for any form interaction — login, search, registration, checkout. Do NOT use click to interact with form elements; fill handles all input types correctly.`,
    toolset: "core",
    inputSchema: {
      fields: z
        .array(
          z.object({
            selector: z
              .string()
              .describe(
                "CSS selector. For radios: match the group (e.g. 'input[name=size]') — value param picks which option.",
              ),
            value: z
              .string()
              .describe(
                "Value to set. For radios/selects: the option value. For checkboxes: truthy/falsy string.",
              ),
            submit: z
              .boolean()
              .optional()
              .describe("Press Enter after this field. Default: false."),
            kind: z
              .enum(["text", "check", "radio", "select", "selectLabel", "selectIndex"])
              .optional()
              .describe("Force a specific dispatch. Omit for auto-detect."),
          }),
        )
        .min(1)
        .describe("Ordered list of fields to fill."),
      submitSelector: z
        .string()
        .optional()
        .describe(
          "CSS selector of a submit button to click after all fields are filled. Optional.",
        ),
      skipMissing: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "If true, fields whose selector doesn't match are silently skipped. Default: false (first miss = isError).",
        ),
      timeout: z
        .number()
        .min(100)
        .max(30000)
        .default(10000)
        .optional()
        .describe("Per-field wait timeout in ms. Default: 10000."),
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
    handler: async ({ fields, submitSelector, skipMissing = false, timeout = 10000, tabId }) => {
      // Batched kind-detection: one evaluate call checks existence for ALL
      // fields and auto-detects kinds for fields lacking an explicit `kind`.
      // This avoids N per-field round-trips, eliminates TOCTOU, and means
      // explicit-kind missing selectors are also caught before any mutation.

      type FieldKind = "text" | "check" | "radio" | "select";

      try {
        const page = await mgr.getPage(tabId);

        // One batch existence check for every selector (explicit + implicit).
        const allSelectors = fields.map((f: { selector: string }) => f.selector);
        const infoMap: Record<string, { tag: string; type: string } | null> =
          allSelectors.length > 0 ? await page.evaluate(detectFieldsInPage, allSelectors) : {};

        // Derive kinds for implicit-kind fields; explicit fields skip this.
        const detectedKinds: Record<string, FieldKind | null> = {};
        for (const f of fields) {
          if (f.kind) continue;
          const info = infoMap[f.selector];
          if (!info) {
            detectedKinds[f.selector] = null;
          } else {
            detectedKinds[f.selector] = detectFieldKind(info.tag, info.type);
          }
        }

        // Validate: report ALL missing selectors before mutating anything.
        const missing = fields
          .filter((f: { selector: string }) => infoMap[f.selector] === null)
          .map((f: { selector: string }) => f.selector);
        if (missing.length > 0 && !skipMissing) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Selector(s) not found: ${missing.join(", ")}. Use skipMissing=true to ignore missing fields.`,
              },
            ],
          };
        }

        const filled: Array<{ selector: string; kind: string }> = [];
        const skipped: string[] = [];

        for (const f of fields) {
          try {
            // f.kind takes priority; otherwise use batched-detection result.
            // null means the element wasn't found (only reachable when
            // skipMissing=true — missing selectors abort earlier otherwise).
            const kind = f.kind ?? detectedKinds[f.selector];
            if (kind === null) {
              skipped.push(f.selector);
              continue;
            }
            if (kind === "select" || kind === "selectLabel" || kind === "selectIndex") {
              if (kind === "selectLabel") {
                await page.selectOption(f.selector, { label: f.value }, { timeout });
              } else if (kind === "selectIndex") {
                const idx = parseInt(f.value, 10);
                if (Number.isNaN(idx))
                  throw new Error(`selectIndex expects numeric value, got "${f.value}"`);
                await page.selectOption(f.selector, { index: idx }, { timeout });
              } else {
                await page.selectOption(f.selector, f.value, { timeout });
              }
              filled.push({ selector: f.selector, kind });
            } else if (kind === "check") {
              const intent = interpretCheckboxValue(f.value);
              if (intent === "check") {
                await page.check(f.selector, { timeout });
                filled.push({ selector: f.selector, kind });
              } else if (intent === "uncheck") {
                await page.uncheck(f.selector, { timeout });
                filled.push({ selector: f.selector, kind });
              } else {
                const fullSel = buildRadioSelector(f.selector, f.value);
                await page.check(fullSel, { timeout });
                filled.push({ selector: fullSel, kind: "check-by-value" });
              }
            } else if (kind === "radio") {
              const fullSel = buildRadioSelector(f.selector, f.value);
              await page.click(fullSel, { timeout });
              filled.push({ selector: fullSel, kind });
            } else {
              await page.fill(f.selector, f.value, { timeout });
              filled.push({ selector: f.selector, kind });
            }
            if (f.submit) await page.press(f.selector, "Enter");
          } catch (err) {
            if (skipMissing) {
              skipped.push(f.selector);
              continue;
            }
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Failed on field "${f.selector}": ${(err as Error).message}\nFilled before failure: ${filled.map((x) => x.selector).join(", ") || "(none)"}`,
                },
              ],
            };
          }
        }
        const beforeUrl = page.url();
        if (submitSelector) {
          await page.click(submitSelector, { timeout });
        }
        await globalWait(env);
        const lines = [`Filled ${filled.length}/${fields.length} field(s).`];
        if (filled.length) {
          const byKind = filled.map((x) => `${x.selector} [${x.kind}]`).join(", ");
          lines.push(`  ok: ${byKind}`);
        }
        if (skipped.length) lines.push(`  skipped: ${skipped.join(", ")}`);
        if (submitSelector) {
          const afterUrl = page.url();
          lines.push(`Clicked submit: ${submitSelector}`);
          if (afterUrl !== beforeUrl) lines.push(`Navigated to: ${afterUrl}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // scroll --------------------------------------------------------------------
  register({
    name: "scroll",
    title: "Scroll Page",
    description: `Scroll the page up or down by a pixel amount. Optionally extract visible text after scrolling with readAfterScroll (saves a follow-up get_page_text call). Use to reveal lazy-loaded content or read long pages in segments. Do NOT use as a substitute for navigation — use go_to_url to load a new page.`,
    toolset: "core",
    inputSchema: {
      direction: z.enum(["up", "down"]).describe("Scroll direction: 'up' or 'down'."),
      pixels: z
        .number()
        .default(500)
        .optional()
        .describe("Number of pixels to scroll. Default: 500."),
      readAfterScroll: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Extract visible page text after scrolling (saves a follow-up get_page_text call). Default: false.",
        ),
      maxChars: z
        .number()
        .default(3000)
        .optional()
        .describe("When readAfterScroll=true, max chars of text to return. Default: 3000."),
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
    handler: async ({
      direction,
      pixels = 500,
      readAfterScroll = false,
      maxChars = 3000,
      tabId,
    }) => {
      try {
        const page = await mgr.getPage(tabId);
        const dy = direction === "up" ? -pixels : pixels;
        const result = await page.evaluate(
          ({ yDelta }: { yDelta: number }) => {
            const before = window.scrollY;
            window.scrollBy({ left: 0, top: yDelta, behavior: "instant" as ScrollBehavior });
            const after = window.scrollY;
            const pageHeight = Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            );
            const viewportHeight = window.innerHeight;
            return { before, after, pageHeight, viewportHeight };
          },
          { yDelta: dy },
        );
        await globalWait(env);
        const actual = Math.abs(result.after - result.before);
        const noOp = actual === 0;
        const suffix = noOp
          ? ` (no-op — page not scrollable in that direction, or already at edge)`
          : actual !== pixels
            ? ` (actual: ${actual}px — reached document edge)`
            : "";
        const pct =
          result.pageHeight > 0
            ? Math.round(((result.after + result.viewportHeight) / result.pageHeight) * 100)
            : 0;
        const posInfo = `\nPosition: ${Math.round(result.after)}px / ${result.pageHeight}px (${Math.min(pct, 100)}% through page)`;

        let pageText = "";
        if (readAfterScroll) {
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
            pageText = "\n---\n[readAfterScroll: failed to extract text]";
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Scrolled ${direction} by ${pixels} pixels${suffix}.${posInfo}${pageText}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // wait_for ------------------------------------------------------------------
  register({
    name: "wait_for",
    title: "Wait for Condition",
    description: `Wait for a condition before proceeding: a CSS selector to appear, text to appear on the page, or text to disappear. On timeout, reports the current page URL and title for diagnosis. Use after navigation or clicks to wait for dynamic content to load. Do NOT use as a sleep substitute — the timeout is a should-not-happen guard, not a pacing mechanism.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe("CSS selector to wait for (e.g. '#results', '.loaded')."),
      text: z.string().optional().describe("Text string to wait for anywhere on the page."),
      textGone: z
        .string()
        .optional()
        .describe("Text string to wait for to disappear from the page."),
      timeout: z
        .number()
        .min(100)
        .max(60000)
        .default(10000)
        .optional()
        .describe("Maximum time to wait in milliseconds. Default: 10000 (10s). Max: 60000 (60s)."),
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ selector, text, textGone, timeout = 10000, tabId }) => {
      try {
        const page = await mgr.getPage(tabId);

        if (!selector && !text && !textGone) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "At least one of 'selector', 'text', or 'textGone' must be provided.",
              },
            ],
          };
        }

        const start = Date.now();
        const conditions: Promise<void>[] = [];

        if (selector) {
          conditions.push(page.waitForSelector(selector, { timeout }).then(() => undefined));
        }
        if (text) {
          conditions.push(
            page
              .waitForFunction((t: string) => document.body?.innerText?.includes(t), text, {
                timeout,
              })
              .then(() => undefined),
          );
        }
        if (textGone) {
          conditions.push(
            page
              .waitForFunction((t: string) => !document.body?.innerText?.includes(t), textGone, {
                timeout,
              })
              .then(() => undefined),
          );
        }

        await Promise.all(conditions);
        const elapsed = Date.now() - start;

        const parts: string[] = [];
        if (selector) parts.push(`selector "${selector}"`);
        if (text) parts.push(`text "${text}"`);
        if (textGone) parts.push(`text gone "${textGone}"`);

        return {
          content: [
            {
              type: "text",
              text: `Condition met: ${parts.join(", ")} — elapsed ${elapsed}ms.`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        let context = "";
        try {
          const page = await mgr.getPage(tabId);
          const url = page.url();
          const title = await page.title().catch(() => "");
          context = `\nCurrent page: ${url}${title ? ` — ${title}` : ""}`;
        } catch {
          /* */
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `wait_for timed out or failed: ${cleanErrorMessage(error)}${context}`,
            },
          ],
        };
      }
    },
  });
}
