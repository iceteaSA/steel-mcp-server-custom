import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait } from "../utils.js";
import { loadCredentials, saveCredentials, type Credential } from "../credentials-store.js";
import { cleanErrorMessage } from "../helpers.js";

export function register(server: McpServer, mgr: BrowserManager, env: Env): void {
  // credentials ---------------------------------------------------------------
  server.tool(
    "credentials",
    `Manage stored credentials. Call with no args to list all (passwords masked). Provide name+url+username+password to store/update. Set remove=true to delete.`,
    {
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
    async ({ name, url, username, password, extra, remove }) => {
      try {
        const creds = await loadCredentials(env);

        // List mode — no name provided
        if (!name) {
          if (creds.length === 0)
            return { content: [{ type: "text", text: "No stored credentials." }] };
          const lines = creds.map(
            (c) =>
              `  ${c.name}: ${c.username} @ ${c.url}${c.extra ? ` (+${Object.keys(c.extra).length} extra)` : ""}`,
          );
          return { content: [{ type: "text", text: "Credentials:\n" + lines.join("\n") }] };
        }

        if (remove) {
          const idx = creds.findIndex((c) => c.name === name);
          if (idx === -1)
            return { content: [{ type: "text", text: `Credential "${name}" not found.` }] };
          creds.splice(idx, 1);
          await saveCredentials(creds, env);
          return { content: [{ type: "text", text: `Credential "${name}" deleted.` }] };
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
        return {
          content: [
            {
              type: "text",
              text: `Credential "${name}" ${existing >= 0 ? "updated" : "stored"} for ${url}.`,
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // use_credential ------------------------------------------------------------
  server.tool(
    "use_credential",
    `Retrieve a stored credential by name and optionally auto-fill a login form on the current page.

Without selectors: returns the credential (username + password + any extra fields).
With selectors: fills the form fields on the page and optionally clicks submit.`,
    {
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
    async ({ name, usernameSelector, passwordSelector, submitSelector, tabId }) => {
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
  );
}
