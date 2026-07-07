import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

export const EnvSchema = z
  .object({
    BROWSER_MODE: z
      .string()
      .transform((arg) => arg.toLowerCase())
      .refine((arg) => arg === "steel" || arg === "local", {
        message: "BROWSER_MODE must be either 'steel' or 'local' (case insensitive)",
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
    // Root directory under which file-mode outputs are allowed to write.
    // When set, outputPath supplied to tools (get_screenshot, evaluate, etc.)
    // is realpath-resolved and must resolve under this directory; otherwise
    // the call is rejected. Defaults to OUTPUT_DIR, so only files written
    // inside the output area are permitted out of the box. Set to "" or "*"
    // to disable the check (escape hatch — the MCP service account can then
    // write anywhere it has permission).
    OUTPUT_ROOT: z.string().default(""),
    // Root directory under which upload_file source paths must resolve.
    // Defaults to OUTPUT_DIR; realpath-resolves each upload path and rejects
    // anything that escapes this root (defeats ../ traversal + symlinks).
    // Set to "" or "*" to disable the check (escape hatch — trust the agent).
    UPLOAD_ROOT: z.string().default(""),
    // Default JPEG quality for screenshots (1–100).
    DEFAULT_SCREENSHOT_QUALITY: z.coerce.number().min(1).max(100).default(80),
    // Default viewport dimensions.
    DEFAULT_VIEWPORT_WIDTH: z.coerce.number().default(1280),
    DEFAULT_VIEWPORT_HEIGHT: z.coerce.number().default(720),
    // Seconds to wait after each action tool (for slow-loading pages).
    GLOBAL_WAIT_SECONDS: z.coerce.number().default(0),
    // Maximum time in ms to wait for network idle + DOM quiet after actions.
    // Set 0 to disable post-action settle detection entirely.
    SETTLE_TIMEOUT_MS: z.coerce.number().default(5000),
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
    // remote machine (e.g. http://your-host:3001).
    RELAY_PUBLIC_URL: z.string().optional(),
    // Address the relay HTTP server binds to. Defaults to localhost-only.
    // Use 0.0.0.0 to accept connections from other machines (only when the
    // relay is behind a reverse proxy or firewall, since auth is Bearer-token
    // based and not TLS-wrapped at the HTTP layer).
    RELAY_BIND_ADDR: z.string().default("127.0.0.1"),
    // Comma-separated toolset names to activate (core is always active).
    // Valid: core, tabs, extract, media, network, auth, debug, ai.
    // Default (unset): all toolsets. Overridden by --toolsets CLI flag.
    // Use to reduce the tool surface for context-budget-constrained agents.
    TOOLSETS: z.string().optional(),
    // OpenAI-compatible endpoint for the act / extract_ai tools.
    // Base URL is used as-is; append /v1 yourself if the provider expects it.
    ACT_LLM_BASE_URL: z.string().optional(),
    // Model name sent to the LLM endpoint (e.g. gemma3, qwen2.5).
    ACT_LLM_MODEL: z.string().optional(),
    // Optional API key. When unset, no Authorization header is sent (ollama).
    ACT_LLM_API_KEY: z.string().optional(),
    // Maximum number of request/response events to keep for get_network.
    // Set 0 to disable network capture entirely (no listeners, empty results).
    NETWORK_BUFFER_SIZE: z.coerce.number().min(0).default(500),
  })
  .transform((env) => ({
    ...env,
    // Derive persistent paths from OUTPUT_DIR if not explicitly set.
    PROFILES_DIR: env.PROFILES_DIR ?? `${env.OUTPUT_DIR}/profiles`,
    CREDENTIALS_FILE: env.CREDENTIALS_FILE ?? `${env.OUTPUT_DIR}/credentials.json`,
    // Resolve containment roots: "*" disables the check (escape hatch);
    // otherwise callers must realpath-resolve under this directory. Default
    // to OUTPUT_DIR so the security guard is on out of the box.
    OUTPUT_ROOT: env.OUTPUT_ROOT === "*" ? "*" : env.OUTPUT_ROOT || env.OUTPUT_DIR,
    UPLOAD_ROOT: env.UPLOAD_ROOT === "*" ? "*" : env.UPLOAD_ROOT || env.OUTPUT_DIR,
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
    },
  );
