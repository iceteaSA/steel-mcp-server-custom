import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import { loadCredentials, saveCredentials, type Credential } from "../credentials-store.js";
import { cleanErrorMessage } from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // credentials ---------------------------------------------------------------
  register({
    name: "credentials",
    title: "Manage Credentials",
    description: `Manage stored credentials: list all (passwords masked), store, update, or delete by name. Call with no arguments to list; pass name+url+username+password to store/update; pass name+remove=true to delete (destructive, cannot be undone). Use for managing credentials consumed by use_credential. Do NOT use to fill login forms directly — use use_credential for that.`,
    toolset: "auth",
    inputSchema: {
      name: z.string().optional().describe("Credential name. Omit to list all."),
      url: z
        .string()
        .optional()
        .describe(
          "URL pattern or domain to associate with this credential (e.g., 'github.com', 'https://console.aws.amazon.com').",
        ),
      username: z.string().optional().describe("Username or email."),
      password: z.string().optional().describe("Password."),
      extra: z
        .string()
        .optional()
        .describe(
          'Additional fields as JSON string (e.g., \'{"otp_secret": "...", "company": "..."}\').',
        ),
      remove: z
        .boolean()
        .optional()
        .describe("Set true to delete this credential instead of storing/updating it."),
    },
    outputSchema: {
      credentials: z
        .array(z.object({ name: z.string(), username: z.string(), url: z.string() }))
        .optional(),
      message: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false, // store/update/delete modes mutate
      destructiveHint: true, // delete mode is destructive
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async ({ name, url, username, password, extra, remove }) => {
      try {
        const creds = await loadCredentials(env);

        // List mode — no name provided
        if (!name) {
          if (creds.length === 0) {
            return {
              content: [{ type: "text", text: "No stored credentials." }],
              structuredContent: { credentials: [] },
            };
          }
          const lines = creds.map(
            (c) =>
              `  ${c.name}: ${c.username} @ ${c.url}${c.extra ? ` (+${Object.keys(c.extra).length} extra)` : ""}`,
          );
          const structured = creds.map((c) => ({
            name: c.name,
            username: c.username,
            url: c.url,
          }));
          return {
            content: [{ type: "text", text: "Credentials:\n" + lines.join("\n") }],
            structuredContent: { credentials: structured },
          };
        }

        if (remove) {
          const idx = creds.findIndex((c) => c.name === name);
          if (idx === -1)
            return {
              content: [{ type: "text", text: `Credential "${name}" not found.` }],
              structuredContent: { message: `Credential "${name}" not found.` },
            };
          creds.splice(idx, 1);
          await saveCredentials(creds, env);
          return {
            content: [{ type: "text", text: `Credential "${name}" deleted.` }],
            structuredContent: { message: `Credential "${name}" deleted.` },
          };
        }

        if (!url || !username || !password) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "url, username, and password are required for storing a credential.",
              },
            ],
          };
        }

        const existing = creds.findIndex((c) => c.name === name);
        const now = new Date().toISOString();
        let parsedExtra: Record<string, string> | undefined;
        if (extra) {
          try {
            parsedExtra = JSON.parse(extra);
          } catch {
            parsedExtra = { raw: extra };
          }
        }
        const cred: Credential = {
          name,
          url,
          username,
          password,
          ...(parsedExtra ? { extra: parsedExtra } : {}),
          createdAt: existing >= 0 ? creds[existing].createdAt : now,
          updatedAt: now,
        };

        if (existing >= 0) {
          creds[existing] = cred;
        } else {
          creds.push(cred);
        }
        await saveCredentials(creds, env);
        const msg = `Credential "${name}" ${existing >= 0 ? "updated" : "stored"} for ${url}.`;
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { message: msg },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // use_credential ------------------------------------------------------------
  register({
    name: "use_credential",
    title: "Use Credential",
    description: `Retrieve a stored credential by name and optionally auto-fill a login form on the current page. Without selectors: returns the credential info (username + masked password + extra fields). With selectors: fills the form fields and optionally clicks submit — use for logging into sites where you've stored credentials via the credentials tool. Do NOT use for sites where you don't have saved credentials — use fill with manual values instead.`,
    toolset: "auth",
    inputSchema: {
      name: z.string().describe("Name of the stored credential to use."),
      usernameSelector: z
        .string()
        .optional()
        .describe("CSS selector for the username/email input field."),
      passwordSelector: z
        .string()
        .optional()
        .describe("CSS selector for the password input field."),
      submitSelector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the submit/login button. If provided, clicks it after filling.",
        ),
      tabId: z.number().int().min(1).optional().describe("Optional tab ID for the page to fill."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({ name, usernameSelector, passwordSelector, submitSelector, tabId }) => {
      try {
        const creds = await loadCredentials(env);
        const cred = creds.find((c) => c.name === name);
        if (!cred) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Credential "${name}" not found. Use credentials tool to save it first.`,
              },
            ],
          };
        }

        // If no selectors, just return the credential info
        if (!usernameSelector && !passwordSelector) {
          const info: Record<string, string> = {
            name: cred.name,
            url: cred.url,
            username: cred.username,
            password: "***" + cred.password.slice(-3),
          };
          if (cred.extra) Object.assign(info, cred.extra);
          return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        }

        // Fill the form
        const page = await mgr.getPage(tabId);
        const filled: string[] = [];

        if (usernameSelector) {
          await page.fill(usernameSelector, cred.username);
          filled.push("username");
        }
        if (passwordSelector) {
          await page.fill(passwordSelector, cred.password);
          filled.push("password");
        }
        if (submitSelector) {
          await page.click(submitSelector);
          filled.push("submitted");
        }

        await globalWait(env);
        return {
          content: [{ type: "text", text: `Credential "${name}" applied: ${filled.join(", ")}.` }],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
