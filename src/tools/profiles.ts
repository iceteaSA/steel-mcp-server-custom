import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { cleanErrorMessage, isValidProfileName } from "../helpers.js";

export function register(server: McpServer, mgr: BrowserManager, _env: Env): void {
  // create_profile ------------------------------------------------------------
  server.tool(
    "create_profile",
    `Create an isolated browser profile with separate cookies/localStorage. Auto-restores saved state if available. Returns a tabId for the profile's initial page. Use new_tab(profile: name) for additional tabs in this profile.`,
    {
      name: z
        .string()
        .refine((n) => isValidProfileName(n), {
          message: "Must be 1-64 alphanumeric characters, hyphens, or underscores.",
        })
        .describe(
          "Profile name (e.g., 'shopping', 'research', 'agent-1'). Must be unique among active profiles.",
        ),
      url: z
        .string()
        .optional()
        .describe("Optional URL to navigate to immediately after creating the profile."),
    },
    async ({ name, url }) => {
      try {
        const { tabId, restored } = await mgr.createProfile(name, url);
        const parts = [`Profile "${name}" created. Tab ID: ${tabId}`];
        if (restored) parts.push("(restored saved cookies/localStorage)");
        if (url) parts.push(`Navigated to ${url}`);
        return { content: [{ type: "text", text: parts.join(" ") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // list_profiles -------------------------------------------------------------
  server.tool(
    "list_profiles",
    `List all browser profiles — both active (with live BrowserContexts) and saved (on disk). Shows tab count for active profiles and last saved timestamp for persisted ones.`,
    {},
    async () => {
      try {
        const profiles = await mgr.listProfiles();
        if (profiles.length === 0) {
          return {
            content: [{ type: "text", text: "No profiles. Use create_profile to create one." }],
          };
        }
        const lines = profiles.map((p) => {
          const status = p.active
            ? `active (${p.tabCount} tab${p.tabCount !== 1 ? "s" : ""})`
            : "saved";
          const saved = p.savedAt ? ` | saved: ${p.savedAt}` : "";
          return `  ${p.name}: ${status}${saved}`;
        });
        return { content: [{ type: "text", text: "Profiles:\n" + lines.join("\n") }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // save_profile --------------------------------------------------------------
  server.tool(
    "save_profile",
    `Persist a profile's cookies and localStorage to disk as JSON. The saved state can be restored later by create_profile with the same name. Useful for preserving login sessions across browser restarts.`,
    {
      name: z
        .string()
        .refine((n) => isValidProfileName(n), {
          message: "Must be 1-64 alphanumeric characters, hyphens, or underscores.",
        })
        .describe("Name of the active profile to save."),
    },
    async ({ name }) => {
      try {
        const savedPath = await mgr.saveProfile(name);
        return { content: [{ type: "text", text: `Profile "${name}" saved to ${savedPath}` }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // delete_profile ------------------------------------------------------------
  server.tool(
    "delete_profile",
    `Delete a browser profile. Closes its BrowserContext and all tabs. Optionally removes the saved state from disk.`,
    {
      name: z
        .string()
        .refine((n) => isValidProfileName(n), {
          message: "Must be 1-64 alphanumeric characters, hyphens, or underscores.",
        })
        .describe("Name of the profile to delete."),
      removeSaved: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also remove the saved profile JSON from disk. Default: false (keep saved state for future restoration).",
        ),
    },
    async ({ name, removeSaved }) => {
      try {
        await mgr.deleteProfile(name, removeSaved);
        const extra = removeSaved ? " (saved state also removed)" : "";
        return { content: [{ type: "text", text: `Profile "${name}" deleted${extra}.` }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );
}
