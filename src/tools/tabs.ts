import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import { cleanErrorMessage } from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // list_tabs -----------------------------------------------------------------
  register({
    name: "list_tabs",
    title: "List Tabs",
    description: `List open browser tabs with URL, title, and metadata. Filter by owner, profile, or look up a single tab by ID. Use to check tab state before interacting with a specific tab — every page-operating tool accepts an optional tabId. Do NOT use to get the current page content; use get_page_text instead.

CONTEXT BUDGET — tab list grows with session activity. Filter with owner or profile to narrow results.`,
    toolset: "tabs",
    inputSchema: {
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Get info for a specific tab (replaces get_current_url)."),
      owner: z.string().optional().describe("Filter to tabs with this owner tag."),
      profile: z.string().optional().describe("Filter to tabs in this profile."),
    },
    outputSchema: {
      tabs: z.array(
        z.object({
          tabId: z.number(),
          url: z.string(),
          title: z.string(),
          active: z.boolean(),
          profile: z.string().nullable(),
          owner: z.string().nullable(),
        }),
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({ tabId, owner, profile }) => {
      try {
        let tabs = await mgr.listTabs();
        if (tabId) {
          const t = tabs.find((t) => t.tabId === tabId);
          if (!t)
            return { isError: true, content: [{ type: "text", text: `Tab ${tabId} not found.` }] };
          const info = {
            tabId: t.tabId,
            url: t.url,
            title: t.title,
            active: t.active,
            profile: t.profile ?? null,
            owner: t.owner ?? null,
          };
          return {
            content: [
              {
                type: "text",
                text: `Tab ${t.tabId}: ${t.url}\nTitle: ${t.title}${t.profile ? `\nProfile: ${t.profile}` : ""}${t.owner ? `\nOwner: ${t.owner}` : ""}`,
              },
            ],
            structuredContent: { tabs: [info] },
          };
        }
        if (owner) tabs = tabs.filter((t) => t.owner === owner);
        if (profile) tabs = tabs.filter((t) => t.profile === profile);
        if (tabs.length === 0) {
          return {
            content: [{ type: "text", text: "No matching tabs." }],
            structuredContent: { tabs: [] },
          };
        }
        const lines = tabs.map(
          (t) =>
            `[Tab ${t.tabId}]${t.active ? " *" : ""}${t.profile ? ` [${t.profile}]` : ""}${t.owner ? ` (owner=${t.owner})` : ""}  ${t.url}  —  ${t.title}`,
        );
        const structured = tabs.map((t) => ({
          tabId: t.tabId,
          url: t.url,
          title: t.title,
          active: t.active,
          profile: t.profile ?? null,
          owner: t.owner ?? null,
        }));
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { tabs: structured },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // new_tab -------------------------------------------------------------------
  register({
    name: "new_tab",
    title: "New Tab",
    description: `Open a new browser tab, optionally navigating to a URL. Returns the tab ID for use with tabId parameters in other tools. Pass an owner tag for multi-agent tab management (close_tabs by owner later). Pass a profile name to open the tab in an isolated BrowserContext with its own cookies/localStorage.`,
    toolset: "tabs",
    inputSchema: {
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
          "Optional ownership tag (e.g. 'agent:my-scraper-1'). Lets you clean up only your own tabs later via close_tabs.",
        ),
      profile: z
        .string()
        .optional()
        .describe(
          "Open the tab in this profile's isolated BrowserContext (shares its cookies/localStorage). Must be an active profile created via create_profile.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ url, owner, profile }) => {
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
  });

  // close_tabs ----------------------------------------------------------------
  register({
    name: "close_tabs",
    title: "Close Tabs",
    description: `Close browser tabs by tabId, owner tag, or the current active tab (default). Use for per-agent cleanup after a task — this only closes specific tabs, not the whole browser. For full session teardown, use stop_browser. Passing both tabId and owner closes the specific tab AND all tabs owned by that owner.`,
    toolset: "tabs",
    inputSchema: {
      tabId: z.number().int().min(1).optional().describe("Close a specific tab by ID."),
      owner: z.string().optional().describe("Close all tabs with this owner tag."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ tabId, owner }) => {
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
  });
}
