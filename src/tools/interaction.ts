import fs from "fs/promises";

import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { afterAction, actionFeedback } from "../utils.js";
import {
  cleanErrorMessage,
  detectFieldKind,
  detectFieldsInPage,
  extractPageContent,
  interpretCheckboxValue,
} from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";
import {
  execClick,
  execFillField,
  execPressKey,
  execScroll,
  frameTarget,
  resolveFrame,
  tabTarget,
  tabTargetForce,
  toSelector,
  decorateRefError,
} from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // click ---------------------------------------------------------------------
  register({
    name: "click",
    title: "Click Element",
    description: `Click a page element identified by CSS selector or snapshot ref. Reports navigation if the URL changes. Optionally wait for a selector or text to appear after clicking (saves a separate wait_for call). Use for buttons, links, and interactive elements — do NOT use for form inputs (use fill instead). Refs come from the snapshot tool; refresh after navigation or page mutation. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector of the element to click (e.g. 'button[type=submit]', '#login', 'a.nav-link').",
        ),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
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
      ...tabTargetForce,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({
      selector,
      ref,
      waitFor,
      waitForText,
      waitTimeout = 10000,
      timeout = 10000,
      tabId,
      owner,
      force,
      frame,
    }) => {
      let sel = "";
      try {
        sel = toSelector({ selector, ref });
        const page = await mgr.getPage({ tabId, owner, force });
        const ctx = resolveFrame(page, frame);
        const beforeUrl = page.url();
        await execClick(page, env, { selector: sel, frame, timeout });

        // Snapshot-diff feedback (best-effort — doesn't affect result on failure).
        const afterUrl = page.url();
        const navigated = afterUrl !== beforeUrl;
        const resolved = mgr.resolveTab({ tabId, owner, force });
        if (navigated) {
          mgr.setTabLastUrl(resolved, afterUrl);
        }
        const feedback = await actionFeedback(page, resolved, {
          navigated,
        });
        const feedbackText = feedback ? `\n${feedback}` : "";

        let waitMsg = "";
        if (waitFor) {
          try {
            await ctx.waitForSelector(waitFor, { timeout: waitTimeout });
            waitMsg = `\nwaitFor "${waitFor}" matched.`;
          } catch {
            waitMsg = `\nwaitFor "${waitFor}" TIMED OUT after ${waitTimeout}ms.`;
          }
        }
        if (waitForText) {
          try {
            await ctx.waitForFunction(
              (t: string) => document.body?.innerText?.includes(t),
              waitForText,
              { timeout: waitTimeout },
            );
            waitMsg += `\nText "${waitForText}" appeared.`;
          } catch {
            waitMsg += `\nText "${waitForText}" NOT found after ${waitTimeout}ms.`;
          }
        }

        const navMsg = navigated ? `\nNavigated to: ${afterUrl}` : "";
        const dialogText = mgr.dialogNotice(mgr.resolveTab({ tabId, owner, force }));
        return {
          content: [
            {
              type: "text",
              text: `Clicked: ${sel}${navMsg}${waitMsg}${feedbackText}${dialogText}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: decorateRefError(error, sel) }],
        };
      }
    },
  });

  // fill ----------------------------------------------------------------------
  register({
    name: "fill",
    title: "Fill Form",
    description: `Fill one or more form fields on the page. Auto-detects field types (text, select, checkbox, radio). Pass submitSelector to click a submit button after filling. Each field accepts selector or snapshot ref. Use for any form interaction (login, search, registration, checkout) — do NOT use click on form elements; fill handles all input types correctly. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.`,
    toolset: "core",
    inputSchema: {
      fields: z
        .array(
          z.object({
            selector: z
              .string()
              .optional()
              .describe(
                "CSS selector. For radios: match the group (e.g. 'input[name=size]') — value param picks which option.",
              ),
            ref: z
              .string()
              .optional()
              .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
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
      ...tabTargetForce,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({
      fields,
      submitSelector,
      skipMissing = false,
      timeout = 10000,
      tabId,
      owner,
      force,
      frame,
    }) => {
      // Batched kind-detection: one evaluate call checks existence for ALL
      // CSS-selector fields and auto-detects kinds for fields lacking an
      // explicit `kind`.  Ref-based selectors are resolved individually via
      // locator — aria-ref is a Playwright-internal engine, invisible to
      // page.evaluate/querySelectorAll.
      type FieldKind = "text" | "check" | "radio" | "select";

      try {
        // Resolve per-field selector/ref pairs.
        for (const f of fields as any[]) {
          f.selector = toSelector({ selector: f.selector, ref: f.ref });
        }

        const page = await mgr.getPage({ tabId, owner, force });
        const ctx = resolveFrame(page, frame);

        // Split selectors: CSS pass through evaluate; refs through locator.
        const allSelectors = fields.map((f: { selector: string }) => f.selector);
        const cssSelectors = allSelectors.filter((s: string) => !s.startsWith("aria-ref="));
        const refSelectors = allSelectors.filter((s: string) => s.startsWith("aria-ref="));

        // Batch existence check for CSS selectors.
        const cssInfoMap: Record<string, { tag: string; type: string } | null> =
          cssSelectors.length > 0 ? await ctx.evaluate(detectFieldsInPage, cssSelectors) : {};

        // Individual existence check for ref selectors via locator.
        const refInfoMap: Record<string, { tag: string; type: string } | null> = {};
        for (const sel of refSelectors) {
          let handle: any = null;
          try {
            await ctx.locator(sel).waitFor({ state: "attached", timeout });
            handle = await ctx.locator(sel).elementHandle({ timeout });
            if (handle) {
              refInfoMap[sel] = await handle.evaluate((el: Element) => ({
                tag: el.tagName.toLowerCase(),
                type: (el as HTMLInputElement).type || "",
              }));
            } else {
              refInfoMap[sel] = null;
            }
          } catch {
            refInfoMap[sel] = null;
          } finally {
            if (handle) await handle.dispose().catch(() => {});
          }
        }

        const infoMap: Record<string, { tag: string; type: string } | null> = {
          ...cssInfoMap,
          ...refInfoMap,
        };

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
          const hasAriaRef = missing.some((s: string) => s.startsWith("aria-ref="));
          const hint = hasAriaRef ? " Ref may be stale — take a fresh snapshot." : "";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Selector(s) not found: ${missing.join(", ")}.${hint} Use skipMissing=true to ignore missing fields.`,
              },
            ],
          };
        }

        const filled: Array<{ selector: string; kind: string }> = [];
        const skipped: string[] = [];

        // Capture URL before any field mutation for navigation detection.
        const urlBefore = page.url();

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
            await execFillField(page, env, {
              selector: f.selector,
              value: f.value,
              kind,
              frame,
              timeout,
            });
            filled.push({
              selector: f.selector,
              kind:
                kind === "check" && interpretCheckboxValue(f.value) === "selectByValue"
                  ? "check-by-value"
                  : kind,
            });
            if (f.submit) await ctx.locator(f.selector).press("Enter");
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
                  text: `Failed on field "${f.selector}": ${decorateRefError(err, f.selector)}\nFilled before failure: ${filled.map((x) => x.selector).join(", ") || "(none)"}`,
                },
              ],
            };
          }
        }
        if (submitSelector) {
          await ctx.locator(submitSelector).click({ timeout });
        }
        await afterAction(page, env);

        const urlAfter = page.url();
        const resolved = mgr.resolveTab({ tabId, owner, force });
        if (urlAfter !== urlBefore) {
          mgr.setTabLastUrl(resolved, urlAfter);
        }
        const feedback = await actionFeedback(page, resolved, {
          navigated: urlAfter !== urlBefore,
        });
        const feedbackText = feedback ? `\n${feedback}` : "";

        const lines = [`Filled ${filled.length}/${fields.length} field(s).`];
        if (filled.length) {
          const byKind = filled.map((x) => `${x.selector} [${x.kind}]`).join(", ");
          lines.push(`  ok: ${byKind}`);
        }
        if (skipped.length) lines.push(`  skipped: ${skipped.join(", ")}`);
        if (submitSelector) {
          lines.push(`Clicked submit: ${submitSelector}`);
          if (urlAfter !== urlBefore) lines.push(`Navigated to: ${urlAfter}`);
        }
        if (feedbackText) lines.push(feedbackText.trimStart());
        const dialogText = mgr.dialogNotice(mgr.resolveTab({ tabId, owner, force }));
        if (dialogText) lines.push(dialogText.trimStart());
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
    description: `Scroll the page (or a specific scrollable element) up or down by a pixel amount. Optionally extract visible text after scrolling with readAfterScroll (saves a follow-up get_page_text call). Pass selector or snapshot ref to target a scrollable container instead of the window. Use to reveal lazy-loaded content or read long pages in segments. Do NOT use as a substitute for navigation — use go_to_url to load a new page. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.

CONTEXT BUDGET — when readAfterScroll=true, extracted text capped at maxChars (default 3K).`,
    toolset: "core",
    inputSchema: {
      direction: z.enum(["up", "down"]).describe("Scroll direction: 'up' or 'down'."),
      pixels: z
        .number()
        .default(500)
        .optional()
        .describe("Number of pixels to scroll. Default: 500."),
      selector: z
        .string()
        .optional()
        .describe("CSS selector of a scrollable element. Omit to scroll the window."),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
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
      ...tabTargetForce,
      ...frameTarget,
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
      selector,
      ref,
      readAfterScroll = false,
      maxChars = 3000,
      tabId,
      owner,
      force,
      frame,
    }) => {
      let sel: string | null = null;
      try {
        sel = selector || ref ? toSelector({ selector, ref }) : null;
        const page = await mgr.getPage({ tabId, owner, force });
        const ctx = resolveFrame(page, frame);

        const result = await execScroll(page, env, {
          selector: sel ?? undefined,
          direction,
          pixels,
          frame,
        });

        // Snapshot feedback: silent when readAfterScroll already reports page text.
        const scrollFeedback = await actionFeedback(page, mgr.resolveTab({ tabId, owner, force }), {
          silent: readAfterScroll,
        });
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
        const posInfo = `\nPosition: ${Math.round(result.after)}px / ${result.pageHeight}px (${Math.min(pct, 100)}% through ${sel ? "element" : "page"})`;

        let pageText = "";
        if (readAfterScroll) {
          try {
            const rawText: string =
              (
                await ctx.evaluate(extractPageContent, {
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

        const feedbackSuffix = scrollFeedback ? `\n${scrollFeedback}` : "";
        const dialogText = mgr.dialogNotice(mgr.resolveTab({ tabId, owner, force }));
        return {
          content: [
            {
              type: "text",
              text: `Scrolled ${direction} by ${pixels} pixels${suffix}.${posInfo}${pageText}${feedbackSuffix}${dialogText}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [
            { type: "text", text: sel ? decorateRefError(error, sel) : cleanErrorMessage(error) },
          ],
        };
      }
    },
  });

  // wait_for ------------------------------------------------------------------
  register({
    name: "wait_for",
    title: "Wait for Condition",
    description: `Wait for a condition before proceeding: a CSS selector (or snapshot ref) to appear, text to appear on the page, or text to disappear. On timeout, reports the current page URL and title for diagnosis. Use after navigation or clicks to wait for dynamic content to load. Do NOT use as a sleep substitute — the timeout is a should-not-happen guard, not a pacing mechanism. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe("CSS selector to wait for (e.g. '#results', '.loaded')."),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
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
      ...tabTarget,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      selector,
      ref,
      text,
      textGone,
      timeout = 10000,
      tabId,
      owner,
      force,
      frame,
    }) => {
      let sel: string | undefined;
      try {
        sel = selector || ref ? toSelector({ selector, ref }) : undefined;
        const page = await mgr.getPage({ tabId, owner, force });
        const ctx = resolveFrame(page, frame);

        if (!sel && !text && !textGone) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "At least one of 'selector' (or 'ref'), 'text', or 'textGone' must be provided.",
              },
            ],
          };
        }

        const start = Date.now();
        const conditions: Promise<void>[] = [];

        if (sel) {
          conditions.push(ctx.waitForSelector(sel, { timeout }).then(() => undefined));
        }
        if (text) {
          conditions.push(
            ctx
              .waitForFunction((t: string) => document.body?.innerText?.includes(t), text, {
                timeout,
              })
              .then(() => undefined),
          );
        }
        if (textGone) {
          conditions.push(
            ctx
              .waitForFunction((t: string) => !document.body?.innerText?.includes(t), textGone, {
                timeout,
              })
              .then(() => undefined),
          );
        }

        await Promise.all(conditions);
        const elapsed = Date.now() - start;

        const parts: string[] = [];
        if (sel) parts.push(`selector "${sel}"`);
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
          const page = await mgr.getPage({ tabId, owner });
          const url = page.url();
          const title = await page.title().catch(() => "");
          context = `\nCurrent page: ${url}${title ? ` — ${title}` : ""}`;
        } catch {
          /* */
        }
        const msg = sel ? decorateRefError(error, sel) : cleanErrorMessage(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `wait_for timed out or failed: ${msg}${context}`,
            },
          ],
        };
      }
    },
  });

  // handle_dialog -------------------------------------------------------------
  register({
    name: "handle_dialog",
    title: "Handle Dialog",
    description: `Set the dialog policy for a tab before an action that triggers alert/confirm/prompt. Playwright dialogs block the triggering action until resolved, so the policy must be armed in advance — the dialog is handled the instant it fires. Default policy is dismiss.

Call without an action to view the current policy and last dialog.`,
    toolset: "core",
    inputSchema: {
      action: z
        .enum(["accept", "dismiss"])
        .optional()
        .describe(
          "Policy for dialogs (alert/confirm/prompt) that this tab raises during subsequent actions. Omit to view current policy + last dialog.",
        ),
      promptText: z
        .string()
        .optional()
        .describe("Text to enter for prompt() dialogs when action is accept."),
      once: z
        .boolean()
        .optional()
        .describe("Apply the policy to only the next dialog, then revert to dismiss."),
      ...tabTarget,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ action, promptText, once, tabId, owner, force }) => {
      try {
        const resolved = mgr.resolveTab({ tabId, owner, force });

        // No action — view mode: report current policy and last dialog.
        if (!action) {
          const policy = mgr.getDialogPolicy(resolved);
          const last = mgr.getLastDialog(resolved);
          const lines: string[] = [];
          lines.push(
            policy
              ? `Dialog policy for tab ${resolved}: ${policy.action}${policy.promptText ? ` (prompt text: "${policy.promptText}")` : ""}${policy.once ? ", once" : ""}.`
              : `Dialog policy for tab ${resolved}: default (dismiss).`,
          );
          if (last) {
            const age = Math.round((Date.now() - last.at) / 1000);
            const pt = last.promptText ? ` promptText="${last.promptText}"` : "";
            lines.push(
              `Last dialog (${age}s ago): ${last.type} "${last.message}" — ${last.action}${last.autoHandled ? " (auto-handled)" : ""}${pt}.`,
            );
          } else {
            lines.push("No dialog has appeared on this tab.");
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Action mode — arm the policy for future dialogs on this tab.
        mgr.setDialogPolicy(resolved, { action, promptText, once: once ?? false });
        const pt = promptText ? ` (prompt text: "${promptText}")` : "";
        const onceStr = once ? ", once" : "";
        return {
          content: [
            {
              type: "text",
              text: `Dialog policy for tab ${resolved}: ${action}${pt}${onceStr}. Dialogs raised by the next action(s) will be ${action === "accept" ? "accepted" : "dismissed"}.`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  });

  // upload_file ---------------------------------------------------------------
  register({
    name: "upload_file",
    title: "Upload File",
    description: `Upload one or more files through a file input element. Supports direct file-input selection and "file chooser" mode for custom upload buttons that open a native file picker. All file paths must be absolute paths on the MCP server host.

Errors: missing file paths, selector timeout, element not found.`,
    toolset: "core",
    inputSchema: {
      ...tabTargetForce,
      selector: z
        .string()
        .optional()
        .describe("CSS selector of the file input (input[type=file]) or upload trigger button."),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
      files: z.array(z.string()).min(1).describe("Absolute paths on the MCP server host."),
      viaChooser: z
        .boolean()
        .optional()
        .describe(
          "Click the target and catch the file chooser instead of setting input files directly. For custom upload buttons that open a picker.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ selector, ref, files, viaChooser, tabId, owner, force }) => {
      let sel = "";
      try {
        sel = toSelector({ selector, ref });

        // Reject non-absolute paths — relative paths are ambiguous on the
        // MCP server host and the spec requires absolute host paths.
        const nonAbsolute = (files as string[]).filter((f) => !f.startsWith("/"));
        if (nonAbsolute.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `File paths must be absolute (start with /). Rejected: ${nonAbsolute.join(", ")}`,
              },
            ],
          };
        }

        // Validate every file exists and is a regular file (not a directory).
        const missing: string[] = [];
        const dirs: string[] = [];
        for (const f of files as string[]) {
          try {
            const st = await fs.stat(f);
            if (!st.isFile()) dirs.push(f);
          } catch {
            missing.push(f);
          }
        }
        if (dirs.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Paths are directories (not files): ${dirs.join(", ")}`,
              },
            ],
          };
        }
        if (missing.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `File(s) not found on server: ${missing.join(", ")}`,
              },
            ],
          };
        }

        const page = await mgr.getPage({ tabId, owner, force });

        if (viaChooser) {
          try {
            const [chooser] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 10000 }),
              page.locator(sel).click(),
            ]);
            await chooser.setFiles(files);
          } catch (err) {
            const raw = (err as Error).message;
            // filechooser timeout: the click likely succeeded but no
            // file picker appeared (wrong target, browser config, etc.).
            // Separate this from a click failure so the agent knows what happened.
            if (/filechooser.*timeout/i.test(raw)) {
              const currentUrl = page.url().substring(0, 200);
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Clicked ${sel} but no file chooser appeared within 10s. The click may have fired — verify the target opens a native file picker.\nCurrent URL: ${currentUrl}`,
                  },
                ],
              };
            }
            throw err;
          }
        } else {
          await page.locator(sel).setInputFiles(files, { timeout: 10000 });
        }

        await afterAction(page, env);

        const mode = viaChooser ? "via chooser" : "direct";
        const resolved = mgr.resolveTab({ tabId, owner, force });
        const feedback = await actionFeedback(page, resolved);
        const feedbackText = feedback ? `\n${feedback}` : "";
        const dialogText = mgr.dialogNotice(resolved);

        return {
          content: [
            {
              type: "text",
              text: `Uploaded ${files.length} file(s) to ${sel} (${mode}):\n  ${files.join("\n  ")}${feedbackText}${dialogText}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: decorateRefError(error, sel) }],
        };
      }
    },
  });

  // press_key -----------------------------------------------------------------
  register({
    name: "press_key",
    title: "Press Key",
    description: `Press a keyboard key or key combination. Target a specific element (focuses it first) or press at the page level. Supports all standard Playwright key names and combinations.

Examples: "Enter", "Escape", "Control+A", "Shift+Tab", "ArrowDown", "PageDown", "Backspace", "Delete", "Tab", "F1", "Control+C".

Errors: unknown key name, selector timeout.`,
    toolset: "core",
    inputSchema: {
      ...tabTargetForce,
      key: z
        .string()
        .describe("Playwright key or combo: Enter, Escape, Control+A, Shift+Tab, ArrowDown."),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector of the element to focus before pressing. Omit for page-level keypress.",
        ),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ key, selector, ref, tabId, owner, force }) => {
      let sel: string | undefined;
      try {
        sel = selector || ref ? toSelector({ selector, ref }) : undefined;
        const page = await mgr.getPage({ tabId, owner, force });
        const urlBefore = page.url();

        await execPressKey(page, env, { selector: sel, key });

        const urlAfter = page.url();
        const target = sel ? ` on ${sel}` : "";
        const resolved = mgr.resolveTab({ tabId, owner, force });
        if (urlAfter !== urlBefore) {
          mgr.setTabLastUrl(resolved, urlAfter);
        }
        const feedback = await actionFeedback(page, resolved);
        const feedbackText = feedback ? `\n${feedback}` : "";
        const dialogText = mgr.dialogNotice(resolved);

        return {
          content: [
            {
              type: "text",
              text: `Pressed "${key}"${target}.${feedbackText}${dialogText}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        const raw = error.message;
        // Playwright "Unknown key" errors: "Unknown key: \"foo\""
        if (/unknown key/i.test(raw)) {
          const keyName = key.length > 30 ? `${key.slice(0, 30)}…` : key;
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown key "${keyName}". Examples: Enter, Escape, Control+A, Shift+Tab, ArrowDown, PageDown.`,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: sel ? decorateRefError(error, sel) : cleanErrorMessage(error),
            },
          ],
        };
      }
    },
  });
}
