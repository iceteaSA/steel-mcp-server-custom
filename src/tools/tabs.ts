import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import { cleanErrorMessage } from "../helpers.js";

export function register(server: McpServer, mgr: BrowserManager, env: Env): void {
  // list_tabs -----------------------------------------------------------------
  server.tool(
    "list_tabs",
    "List open tabs. Filter by owner, profile, or get one tab's details via tabId.",
    {
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Get info for a specific tab (replaces get_current_url)."),
      owner: z.string().optional().describe("Filter to tabs with this owner tag."),
      profile: z.string().optional().describe("Filter to tabs in this profile."),
    },
    async ({ tabId, owner, profile }) => {
      try {
        let tabs = await mgr.listTabs();
        if (tabId) {
          const t = tabs.find((t) => t.tabId === tabId);
          if (!t)
            return { isError: true, content: [{ type: "text", text: `Tab ${tabId} not found.` }] };
          return {
            content: [
              {
                type: "text",
                text: `Tab ${t.tabId}: ${t.url}\nTitle: ${t.title}${t.profile ? `\nProfile: ${t.profile}` : ""}${t.owner ? `\nOwner: ${t.owner}` : ""}`,
              },
            ],
          };
        }
        if (owner) tabs = tabs.filter((t) => t.owner === owner);
        if (profile) tabs = tabs.filter((t) => t.profile === profile);
        if (tabs.length === 0) {
          return { content: [{ type: "text", text: "No matching tabs." }] };
        }
        const lines = tabs.map(
          (t) =>
            `[Tab ${t.tabId}]${t.active ? " *" : ""}${t.profile ? ` [${t.profile}]` : ""}${t.owner ? ` (owner=${t.owner})` : ""}  ${t.url}  —  ${t.title}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // new_tab -------------------------------------------------------------------
  server.tool(
    "new_tab",
    `Open a new tab, optionally navigating to a URL. Returns tab ID. Pass owner tag for multi-agent cleanup via close_tabs.`,
    {
      url: z
        .string()
        .optional()
        .describe(
          "URL to navigate to immediately after opening. Optional — omit to open a blank tab.",
        ),
      owner: z
        .string()
        .optional()
        .describe(
          "Optional ownership tag (e.g. 'agent:my-scraper-1'). Lets you clean up only your own tabs later via close_tabs_by_owner.",
        ),
      profile: z
        .string()
        .optional()
        .describe(
          "Open the tab in this profile's isolated BrowserContext (shares its cookies/localStorage). Must be an active profile created via create_profile.",
        ),
    },
    async ({ url, owner, profile }) => {
      try {
        const { tabId, page } = await mgr.newTab(url, owner, profile);
        await globalWait(env);
        const finalUrl = page.url();
        const title = await page.title();
        const ownerSuffix = owner ? ` (owner=${owner})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Opened Tab ${tabId}${ownerSuffix}${url ? `\nURL: ${finalUrl}\nTitle: ${title}` : " (blank)"}`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // close_tabs ----------------------------------------------------------------
  server.tool(
    "close_tabs",
    "Close tabs by tabId, owner tag, or both. Use instead of stop_browser for cleanup.",
    {
      tabId: z.number().int().min(1).optional().describe("Close a specific tab by ID."),
      owner: z.string().optional().describe("Close all tabs with this owner tag."),
    },
    async ({ tabId, owner }) => {
      try {
        if (!tabId && !owner) {
          // Default: close the active tab
          const tabs = await mgr.listTabs();
          const active = tabs.find((t) => t.active);
          if (!active)
            return { isError: true, content: [{ type: "text", text: "No active tab to close." }] };
          await mgr.closeTab(active.tabId);
          const remaining = await mgr.listTabs();
          const nowActive = remaining.find((t) => t.active);
          const suffix = nowActive
            ? `\nNow on Tab ${nowActive.tabId}: ${nowActive.url}`
            : "\nNo tabs remaining.";
          return { content: [{ type: "text", text: `Closed Tab ${active.tabId}.${suffix}` }] };
        }
        const parts: string[] = [];
        if (owner) {
          const closed = await mgr.closeTabsByOwner(owner);
          parts.push(
            closed.length === 0
              ? `No tabs with owner=${owner}.`
              : `Closed ${closed.length} tab(s) owned by ${owner}: ${closed.join(", ")}`,
          );
        }
        if (tabId) {
          await mgr.closeTab(tabId);
          parts.push(`Closed Tab ${tabId}.`);
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );
}
