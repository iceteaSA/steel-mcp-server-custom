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
    // Override to point at a self-hosted Steel instance (e.g. http://10.1.1.1:3000).
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
    // Public-facing Steel URL (e.g. https://steel.tehan.xyz).
    // Rewrites debug/interactive/viewer URLs so they are accessible remotely.
    // Does NOT affect the CDP WebSocket connection — that always uses the
    // internal STEEL_BASE_URL / session.websocketUrl.
    STEEL_PUBLIC_URL: z.string().optional(),
  })
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
