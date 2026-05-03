import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const EnvSchema = z
  .object({
    BROWSER_MODE: z
      .string()
      .transform((arg) => arg.toLowerCase())
      .refine((arg) => arg === "steel" || arg === "local", {
        message:
          "BROWSER_MODE must be either 'steel' or 'local' (case insensitive)",
      })
      .default("steel"),
    STEEL_API_KEY: z.string().optional(),
    // Override to point at a self-hosted Steel instance (e.g. http://steel.local:3000).
    // When set, STEEL_API_KEY is optional.
    STEEL_BASE_URL: z.string().optional(),
    // Maximum bytes before auto-switching inline output to file mode (default 500 KB).
    MAX_INLINE_BYTES: z.coerce.number().default(512000),
    // Directory for file-mode outputs (screenshots, page text, etc.).
    OUTPUT_DIR: z.string().default("/tmp/steel-mcp"),
    // Default JPEG quality for screenshots (1–100).
    DEFAULT_SCREENSHOT_QUALITY: z.coerce.number().min(1).max(100).default(80),
    // Default viewport dimensions.
    DEFAULT_VIEWPORT_WIDTH: z.coerce.number().default(1280),
    DEFAULT_VIEWPORT_HEIGHT: z.coerce.number().default(720),
    // Seconds to wait after each action tool (for slow-loading pages).
    GLOBAL_WAIT_SECONDS: z.coerce.number().default(0),
    // Session auto-release timeout in ms. Safety net if stop_browser is never
    // called. Default: 5 minutes. Set higher for long-running tasks.
    SESSION_TIMEOUT_MS: z.coerce.number().default(300000),
    // When true, blocks images/fonts/CSS in Steel sessions for faster
    // text-only scraping. Default: false.
    OPTIMIZE_BANDWIDTH: z
      .string()
      .transform((v) => v.toLowerCase() === "true")
      .default(false),
    // Public-facing Steel URL (e.g. https://steel.example.com).
    // Rewrites debug/interactive/viewer URLs so they are accessible remotely.
    // Does NOT affect the CDP WebSocket connection — that always uses the
    // internal STEEL_BASE_URL / session.websocketUrl.
    STEEL_PUBLIC_URL: z.string().optional(),
    // Auto-close tabs that have had no tool activity for this many ms.
    // Keeps concurrent-agent sessions from leaking tabs. Default: 5 min.
    // Set 0 to disable the idle sweeper entirely.
    TAB_IDLE_TIMEOUT_MS: z.coerce.number().default(300000),
    // How often the idle sweeper runs (ms). Default: 60s.
    TAB_IDLE_SWEEP_INTERVAL_MS: z.coerce.number().default(60000),
    // Directory for persistent profile state (cookies, localStorage).
    // Defaults to $OUTPUT_DIR/profiles — override for a custom location.
    PROFILES_DIR: z.string().optional(),
    // Path to credentials store (JSON). Used by store_credential / use_credential.
    // Defaults to $OUTPUT_DIR/credentials.json — override for a custom location.
    CREDENTIALS_FILE: z.string().optional(),
    // Passphrase for encrypting credentials at rest (AES-256-GCM).
    // If not set, credentials are stored in plain JSON (homelab-only).
    CREDENTIALS_PASSPHRASE: z.string().optional(),
    // Relay server port for receiving cookies/credentials from the browser extension.
    // Set to 0 to disable the relay server entirely. Default: 3001.
    RELAY_PORT: z.coerce.number().default(3001),
    // Shared secret for authenticating relay requests from the extension.
    // Required when RELAY_PORT > 0. Extension sends this as Bearer token.
    RELAY_SECRET: z.string().optional(),
    // Public-facing URL for the relay server. Shown to users so they can
    // configure the Steel Cookie Push extension. If not set, defaults to
    // http://localhost:<RELAY_PORT>. Set when the MCP server runs on a
    // remote machine (e.g. http://10.1.1.5:3001).
    RELAY_PUBLIC_URL: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    // Derive persistent paths from OUTPUT_DIR if not explicitly set.
    PROFILES_DIR: env.PROFILES_DIR ?? `${env.OUTPUT_DIR}/profiles`,
    CREDENTIALS_FILE: env.CREDENTIALS_FILE ?? `${env.OUTPUT_DIR}/credentials.json`,
  }))
  .refine(
    (env) => {
      // STEEL_API_KEY is required for Steel Cloud (no STEEL_BASE_URL).
      // Self-hosted instances (STEEL_BASE_URL set) typically don't need a key.
      if (env.BROWSER_MODE === "steel" && !env.STEEL_BASE_URL) {
        return !!env.STEEL_API_KEY;
      }
      return true;
    },
    {
      message:
        "STEEL_API_KEY must be set when BROWSER_MODE is 'steel' and STEEL_BASE_URL is not set (Steel Cloud mode).",
      path: ["STEEL_API_KEY"],
    }
  );
