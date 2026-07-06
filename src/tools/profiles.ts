import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { cleanErrorMessage, isValidProfileName } from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, _env: Env): void {
  // create_profile ------------------------------------------------------------
  register({
    name: "create_profile",
    title: "Create Profile",
    description: `Create an isolated browser profile with its own cookies and localStorage. Auto-restores previously saved state if available. Returns a tab ID for the profile's initial page. Use new_tab(profile: name) to open additional tabs in this profile. Use for multi-account workflows or isolating sessions by identity. Do NOT use for simple tab management — new_tab without a profile is sufficient for that.`,
    toolset: "auth",
    inputSchema: {
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ name, url }) => {
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
  });

  // list_profiles -------------------------------------------------------------
  register({
    name: "list_profiles",
    title: "List Profiles",
    description: `List all browser profiles — both active (with live BrowserContexts and tab counts) and saved (on disk, with last-saved timestamps). Use to discover available profiles before creating duplicates or to check which profiles have persisted state. Do NOT use to check if a specific profile is active — this lists all profiles, use the name to scan the output.`,
    toolset: "auth",
    inputSchema: {},
    outputSchema: {
      profiles: z.array(
        z.object({
          name: z.string(),
          active: z.boolean(),
          tabCount: z.number(),
          savedAt: z.string().nullable(),
        }),
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async () => {
      try {
        const profiles = await mgr.listProfiles();
        if (profiles.length === 0) {
          return {
            content: [{ type: "text", text: "No profiles. Use create_profile to create one." }],
            structuredContent: { profiles: [] },
          };
        }
        const lines = profiles.map((p) => {
          const status = p.active
            ? `active (${p.tabCount} tab${p.tabCount !== 1 ? "s" : ""})`
            : "saved";
          const saved = p.savedAt ? ` | saved: ${p.savedAt}` : "";
          return `  ${p.name}: ${status}${saved}`;
        });
        const structured = profiles.map((p) => ({
          name: p.name,
          active: p.active,
          tabCount: p.tabCount,
          savedAt: p.savedAt ?? null,
        }));
        return {
          content: [{ type: "text", text: "Profiles:\n" + lines.join("\n") }],
          structuredContent: { profiles: structured },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // save_profile --------------------------------------------------------------
  register({
    name: "save_profile",
    title: "Save Profile",
    description: `Persist an active profile's cookies and localStorage to disk as JSON. The saved state is restored automatically by create_profile with the same name in future sessions. Use to preserve login sessions across browser restarts. Do NOT rely on this alone for long-term storage — the JSON file is not encrypted unless CREDENTIALS_PASSPHRASE is set for the credentials store (profiles always store plain).`,
    toolset: "auth",
    inputSchema: {
      name: z
        .string()
        .refine((n) => isValidProfileName(n), {
          message: "Must be 1-64 alphanumeric characters, hyphens, or underscores.",
        })
        .describe("Name of the active profile to save."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({ name }) => {
      try {
        const savedPath = await mgr.saveProfile(name);
        return {
          content: [{ type: "text", text: `Profile "${name}" saved to ${savedPath}` }],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // delete_profile ------------------------------------------------------------
  register({
    name: "delete_profile",
    title: "Delete Profile",
    description: `Delete a browser profile: closes its BrowserContext and all associated tabs. Optionally remove the saved state from disk. This is destructive — all cookies, localStorage, and session data for the profile are lost unless you saved them first. Use for cleanup after a multi-account workflow. Do NOT use to close individual tabs — use close_tabs for that.`,
    toolset: "auth",
    inputSchema: {
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ name, removeSaved }) => {
      try {
        await mgr.deleteProfile(name, removeSaved);
        const extra = removeSaved ? " (saved state also removed)" : "";
        return {
          content: [{ type: "text", text: `Profile "${name}" deleted${extra}.` }],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
