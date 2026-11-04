import { z } from "zod";
import type { BrowserManager } from "../manager.js";
import { formatCaptchaResult, solveCaptcha } from "../captcha.js";
import type { ToolRegistrar } from "./shared.js";
import { frameTarget, resolveFrame, tabTarget } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager): void {
  register({
    name: "solve_captcha",
    title: "Solve CAPTCHA",
    description:
      "Block until the current CAPTCHA is solved or a clear failure occurs. Reuses an existing token and waits for an active CapSolver extension solve before any paid REST task. Otherwise uses CAPSOLVER_API_KEY for reCAPTCHA v2/v3 or Turnstile ProxyLess tasks and injects the token plus data-callback. Other types report unsupported. Returns type, public site key, seconds, injected yes/no and error; never returns the token. Use captcha_status for pre-flight balance/configuration. Navigation and action tools already wait for extension solves; call this tool after their failure line, not in parallel. A token does not prove the site accepted it; inspect the page after success.",
    toolset: "core",
    inputSchema: {
      ...tabTarget,
      ...frameTarget,
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(300000)
        .optional()
        .describe(
          "Total solve budget in ms, including extension wait and REST polling. Default: CAPTCHA_WAIT_TOTAL_MS or 90000.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ tabId, owner, frame, timeoutMs }) => {
      try {
        const page = await mgr.getPage({ tabId, owner });
        const result = await solveCaptcha(resolveFrame(page, frame), { timeoutMs });
        const line = formatCaptchaResult(result) || "CAPTCHA none detected";
        return {
          ...(result.status !== "solved" && result.status !== "none" ? { isError: true } : {}),
          content: [
            {
              type: "text",
              text: `${line}\nType: ${result.type}; site key: ${result.siteKey || "unavailable"}; seconds: ${result.seconds}; injected: ${result.injected ? "yes" : "no"}${result.error ? `; error: ${result.error}` : ""}`,
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "CAPTCHA solve failed: could not access the requested tab or frame. Check list_tabs and snapshot.",
            },
          ],
        };
      }
    },
  });
}
