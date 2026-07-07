import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import type { ToolRegistrar } from "./shared.js";
import { tabTargetForce } from "./shared.js";
import { assertTabOwner } from "./network.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  register({
    name: "intercept",
    title: "Intercept Requests",
    toolset: "intercept",
    description: `Intercept network requests on a tab and fulfill/abort/continue them (mock APIs, block noise, simulate errors). Tab-scoped + owner-isolated. Actions: fulfill (return custom status/body), abort (block), continue (pass through, optional overrides), unroute (remove routes for a pattern), list (show active routes).

CONTEXT BUDGET — small confirmation output.`,
    inputSchema: {
      ...tabTargetForce,
      pattern: z
        .string()
        .optional()
        .describe(
          "URL glob, e.g. **/api/* (Playwright glob). Required for fulfill/abort/continue; for unroute omit to remove ALL routes on the tab; unused for list.",
        ),
      action: z
        .enum(["fulfill", "abort", "continue", "unroute", "list"])
        .describe("What to do with matching requests."),
      status: z.number().optional().describe("fulfill: HTTP status (default 200)."),
      body: z.string().optional().describe("fulfill: response body."),
      contentType: z.string().optional().describe("fulfill: Content-Type (default text/plain)."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("fulfill/continue: response/request headers."),
      errorCode: z.string().optional().describe("abort: Playwright error code (default 'failed')."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({
      tabId,
      owner,
      force,
      pattern,
      action,
      status,
      body,
      contentType,
      headers,
      errorCode,
    }: {
      tabId?: number;
      owner?: string;
      force?: boolean;
      pattern?: string;
      action: string;
      status?: number;
      body?: string;
      contentType?: string;
      headers?: Record<string, string>;
      errorCode?: string;
    }) => {
      try {
        // Ownership chokepoint — throws TabOwnershipError on cross-owner
        // access so no agent can touch another owner's tab routes.
        // MUST run before the pattern guard so cross-owner denial fires
        // regardless of whether the caller passed a pattern.
        const resolved = mgr.resolveTab({ tabId, owner, force });

        // Local owner-auth for tabId-only (no owner) accesses — closes the
        // bypass where resolveTab skips ownership enforcement when owner
        // is absent but tabId targets another owner's tab.
        const auth = assertTabOwner(mgr, resolved, owner, force);
        if (!auth.ok) {
          return { isError: true, content: [{ type: "text", text: auth.error }] };
        }

        // Actions that require a pattern — guard AFTER ownership check.
        if ((action === "fulfill" || action === "abort" || action === "continue") && !pattern) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `pattern is required for action "${action}".`,
              },
            ],
          };
        }

        if (action === "list") {
          const routes = mgr.listRoutes(resolved);
          return {
            content: [{ type: "text", text: JSON.stringify(routes) }],
          };
        }

        if (action === "unroute") {
          const n = await mgr.removeRoutes(resolved, pattern);
          const label = pattern ? `for ${pattern}` : "on this tab";
          return {
            content: [
              {
                type: "text",
                text: `Removed ${n} route(s) ${label}.`,
              },
            ],
          };
        }

        // Arm the route — tab-scoped page.route() only (never context.route).
        const ownerTag = owner ?? mgr.getTabOwner(resolved) ?? "";
        await mgr.addRoute(resolved, ownerTag, pattern!, async (route) => {
          if (action === "fulfill") {
            await route.fulfill({
              status: status ?? 200,
              body: body ?? "",
              contentType: contentType ?? "text/plain",
              headers,
            });
          } else if (action === "abort") {
            await route.abort((errorCode as any) ?? "failed");
          } else {
            // continue — with optional header overrides
            await route.continue(headers ? { headers } : undefined);
          }
        });

        await globalWait(env);
        return {
          content: [
            {
              type: "text",
              text: `Interception armed on ${pattern} (${action}), tab ${resolved}.`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    },
  });
}
