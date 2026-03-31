#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { Steel } from "steel-sdk";
import { EnvSchema } from "./env";
import { z } from "zod";

// -----------------------------------------------------------------------------
// MCP server instance
// -----------------------------------------------------------------------------
const server = new McpServer(
  { name: "Steel Browser MCP Server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const env = EnvSchema.parse(process.env);

// -----------------------------------------------------------------------------
// BrowserManager — wraps Playwright browser lifecycle (Steel or local)
// -----------------------------------------------------------------------------

type ConsoleMessage = { level: string; text: string; timestamp: number };

class BrowserManager {
  private browser: Browser | undefined;
  private browserContext: BrowserContext | undefined;
  private currentPage: Page | undefined;
  private steelClient: Steel | undefined;
  private sessionId: string | undefined;
  public debugUrl: string | undefined;
  public consoleLogs: ConsoleMessage[] = [];
  public initialized = false;

  async initialize() {
    if (this.initialized) return;

    if (env.BROWSER_MODE === "steel") {
      // The Steel SDK requires steelAPIKey at construction time.
      // For self-hosted instances, pass a placeholder — the server ignores it.
      this.steelClient = new Steel({
        steelAPIKey: env.STEEL_API_KEY ?? "local",
        ...(env.STEEL_BASE_URL ? { baseURL: env.STEEL_BASE_URL } : {}),
      });

      const session = await this.steelClient.sessions.create();
      this.sessionId = session.id;
      this.debugUrl = session.debugUrl;

      // Derive CDP WebSocket URL from STEEL_BASE_URL if set, else use Steel Cloud.
      let wsUrl: string;
      if (env.STEEL_BASE_URL) {
        const base = env.STEEL_BASE_URL.replace(/\/$/, "");
        wsUrl = base.startsWith("https://")
          ? base.replace("https://", "wss://")
          : base.replace("http://", "ws://");
        wsUrl = `${wsUrl}/?sessionId=${session.id}`;
      } else {
        wsUrl = `wss://connect.steel.dev?apiKey=${env.STEEL_API_KEY}&sessionId=${session.id}`;
      }

      this.browser = await chromium.connectOverCDP(wsUrl);
      // Use the existing context created by Steel, or create one.
      const contexts = this.browser.contexts();
      this.browserContext =
        contexts.length > 0 ? contexts[0] : await this.browser.newContext();
    } else {
      // Local mode — launch Playwright Chromium directly.
      this.browser = await chromium.launch({ headless: false });
      this.browserContext = await this.browser.newContext({
        viewport: {
          width: env.DEFAULT_VIEWPORT_WIDTH,
          height: env.DEFAULT_VIEWPORT_HEIGHT,
        },
      });
    }

    // Open initial page.
    const pages = this.browserContext.pages();
    this.currentPage =
      pages.length > 0 ? pages[0] : await this.browserContext.newPage();

    // Wire up console log capture.
    this.currentPage.on("console", (msg) => {
      this.consoleLogs.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      // Ring buffer — keep at most 500 entries.
      if (this.consoleLogs.length > 500) {
        this.consoleLogs.splice(0, this.consoleLogs.length - 500);
      }
    });

    this.initialized = true;
  }

  async getPage(): Promise<Page> {
    await this.initialize();
    // Return current page if still open, otherwise pick the last open page.
    if (!this.currentPage || this.currentPage.isClosed()) {
      const pages = this.browserContext!.pages();
      this.currentPage =
        pages.length > 0
          ? pages[pages.length - 1]
          : await this.browserContext!.newPage();
    }
    return this.currentPage;
  }

  async stop() {
    if (this.steelClient && this.sessionId) {
      try {
        await this.steelClient.sessions.release(this.sessionId);
      } catch (err) {
        console.error(
          `Failed to release Steel session ${this.sessionId}:`,
          (err as Error).message
        );
      }
      this.sessionId = undefined;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
    }

    this.browserContext = undefined;
    this.currentPage = undefined;
    this.consoleLogs = [];
    this.debugUrl = undefined;
    this.initialized = false;
  }
}

const mgr = new BrowserManager();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function globalWait() {
  if (env.GLOBAL_WAIT_SECONDS > 0) {
    await sleep(env.GLOBAL_WAIT_SECONDS * 1000);
  }
}

async function writeToFile(
  data: Buffer | string,
  defaultName: string,
  outputPath?: string
): Promise<string> {
  const filePath = outputPath ?? path.join(env.OUTPUT_DIR, defaultName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return filePath;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

// get_screenshot --------------------------------------------------------------
server.tool(
  "get_screenshot",
  `Take a screenshot of the current page.

CONTEXT BUDGET — screenshots can be large. Use outputMode: 'file' when you will process or upload the image separately rather than reading it into context. Use 'inline' (default) when you need immediate visual inspection; will auto-downgrade to 'file' if the output exceeds maxInlineBytes.

Reduce size with: scale < 1.0, format: 'jpeg' + lower quality, fullPage: false, or clip to a region.`,
  {
    outputMode: z
      .enum(["inline", "file"])
      .default("inline")
      .optional()
      .describe(
        "How to return the screenshot. 'inline' returns base64 data (auto-downgrades to 'file' if too large). 'file' saves to disk and returns only the path."
      ),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/screenshot_{timestamp}.{format}."
      ),
    format: z
      .enum(["png", "jpeg"])
      .default("png")
      .optional()
      .describe("Image format. JPEG produces smaller files. Default: 'png'."),
    quality: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "JPEG quality 1–100. Only used when format is 'jpeg'. Default: DEFAULT_SCREENSHOT_QUALITY env var (80)."
      ),
    fullPage: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Capture full scrollable page (true) or visible viewport only (false). Default: false."
      ),
    scale: z
      .number()
      .min(0.1)
      .max(3.0)
      .default(1.0)
      .optional()
      .describe(
        "Viewport scale factor applied before capture. Use 0.5 to halve dimensions and file size. Range: 0.1–3.0. Default: 1.0."
      ),
    clip: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Capture only a rectangular region of the page. Optional."),
    maxInlineBytes: z
      .number()
      .optional()
      .describe(
        "Max bytes before auto-switching to file mode. Default: MAX_INLINE_BYTES env var (512000). Set lower to protect context budget."
      ),
  },
  async ({
    outputMode = "inline",
    outputPath,
    format = "png",
    quality,
    fullPage = false,
    scale = 1.0,
    clip,
    maxInlineBytes,
  }) => {
    try {
      const page = await mgr.getPage();
      const effectiveQuality = quality ?? env.DEFAULT_SCREENSHOT_QUALITY;
      const effectiveMaxInlineBytes = maxInlineBytes ?? env.MAX_INLINE_BYTES;

      const origVp = page.viewportSize() ?? {
        width: env.DEFAULT_VIEWPORT_WIDTH,
        height: env.DEFAULT_VIEWPORT_HEIGHT,
      };

      let buffer: Buffer;
      try {
        if (scale !== 1.0) {
          await page.setViewportSize({
            width: Math.round(origVp.width * scale),
            height: Math.round(origVp.height * scale),
          });
        }
        const opts: Parameters<typeof page.screenshot>[0] = {
          type: format,
          fullPage,
        };
        if (format === "jpeg") opts.quality = effectiveQuality;
        if (clip) opts.clip = clip;
        buffer = await page.screenshot(opts);
      } finally {
        if (scale !== 1.0) {
          await page.setViewportSize(origVp).catch(() => {});
        }
      }

      const effectiveMode =
        outputMode === "inline" && buffer.length > effectiveMaxInlineBytes
          ? "file"
          : outputMode;

      if (effectiveMode === "file") {
        const defaultName = `screenshot_${Date.now()}.${format}`;
        const filePath = await writeToFile(buffer, defaultName, outputPath);
        const autoNote =
          outputMode === "inline"
            ? `\n(Auto-switched to file mode: output exceeded ${effectiveMaxInlineBytes.toLocaleString()} bytes)`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Screenshot saved to: ${filePath}\nSize: ${buffer.length.toLocaleString()} bytes${autoNote}`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: "Screenshot taken." },
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: `image/${format}`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// get_page_text ---------------------------------------------------------------
server.tool(
  "get_page_text",
  `Get visible text content from the current page.

CONTEXT BUDGET — page text can be very large. Use maxChars to limit how much is loaded into context. Use a CSS selector to scope to the relevant section. Use outputMode: 'file' to save the full text to disk without loading it into context at all.`,
  {
    selector: z
      .string()
      .optional()
      .describe(
        "CSS selector to scope extraction (e.g. 'article', 'main', '#content'). Defaults to document.body."
      ),
    maxChars: z
      .number()
      .default(10000)
      .optional()
      .describe(
        "Maximum characters to return inline. Default: 10000. Set to 0 for no limit (use with outputMode: 'file')."
      ),
    outputMode: z
      .enum(["inline", "file"])
      .default("inline")
      .optional()
      .describe(
        "Return text inline (default) or save to file and return path."
      ),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/page_text_{timestamp}.txt."
      ),
    includeLinks: z
      .boolean()
      .default(false)
      .optional()
      .describe("Append link URLs in brackets after each anchor's text. Default: false."),
  },
  async ({ selector, maxChars = 10000, outputMode = "inline", outputPath, includeLinks = false }) => {
    try {
      const page = await mgr.getPage();

      let text: string;
      if (includeLinks) {
        text = await page.evaluate((sel: string | null) => {
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return "";
          const walk = (node: Element): string => {
            if (node.tagName === "A") {
              const href = (node as HTMLAnchorElement).href;
              return `${node.textContent?.trim()} [${href}]`;
            }
            return Array.from(node.childNodes)
              .map((n) => (n.nodeType === 3 ? n.textContent ?? "" : walk(n as Element)))
              .join(" ");
          };
          return walk(root as Element);
        }, selector ?? null);
      } else {
        text = await page.evaluate((sel: string | null) => {
          const root = sel ? document.querySelector(sel) : document.body;
          return (root as HTMLElement)?.innerText ?? "";
        }, selector ?? null);
      }

      text = text.replace(/\s+/g, " ").trim();

      if (outputMode === "file") {
        const filePath = await writeToFile(
          Buffer.from(text, "utf8"),
          `page_text_${Date.now()}.txt`,
          outputPath
        );
        return {
          content: [
            {
              type: "text",
              text: `Page text saved to: ${filePath}\nTotal chars: ${text.length.toLocaleString()}`,
            },
          ],
        };
      }

      const truncated = maxChars > 0 && text.length > maxChars;
      const output = truncated ? text.slice(0, maxChars) : text;
      return {
        content: [
          {
            type: "text",
            text:
              output +
              (truncated
                ? `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 with outputMode: "file" to get full content.]`
                : ""),
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// wait_for --------------------------------------------------------------------
server.tool(
  "wait_for",
  `Wait for a condition on the page before proceeding — more reliable than sleeping.

Use after an action that triggers async changes (form submit, click, navigation) when you need to confirm the page has updated before reading or screenshotting.

Conditions (at least one required): selector, text, textGone. Returns elapsed time or error on timeout.`,
  {
    selector: z.string().optional().describe("CSS selector to wait for (e.g. '#results', '.loaded')."),
    text: z.string().optional().describe("Text string to wait for anywhere on the page."),
    textGone: z.string().optional().describe("Text string to wait for to disappear from the page."),
    timeout: z
      .number()
      .min(100)
      .max(60000)
      .default(10000)
      .optional()
      .describe("Maximum time to wait in milliseconds. Default: 10000 (10s). Max: 60000 (60s)."),
  },
  async ({ selector, text, textGone, timeout = 10000 }) => {
    try {
      const page = await mgr.getPage();

      if (!selector && !text && !textGone) {
        return {
          isError: true,
          content: [{ type: "text", text: "At least one of 'selector', 'text', or 'textGone' must be provided." }],
        };
      }

      const start = Date.now();
      const conditions: Promise<void>[] = [];

      if (selector) {
        conditions.push(page.waitForSelector(selector, { timeout }).then(() => undefined));
      }
      if (text) {
        conditions.push(
          page.waitForFunction(
            (t: string) => document.body?.innerText?.includes(t),
            text,
            { timeout }
          ).then(() => undefined)
        );
      }
      if (textGone) {
        conditions.push(
          page.waitForFunction(
            (t: string) => !document.body?.innerText?.includes(t),
            textGone,
            { timeout }
          ).then(() => undefined)
        );
      }

      await Promise.all(conditions);
      const elapsed = Date.now() - start;

      const parts: string[] = [];
      if (selector) parts.push(`selector "${selector}"`);
      if (text) parts.push(`text "${text}"`);
      if (textGone) parts.push(`text gone "${textGone}"`);

      return {
        content: [{ type: "text", text: `Condition met: ${parts.join(", ")} — elapsed ${elapsed}ms.` }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: `wait_for timed out or failed: ${error.message}` }],
      };
    }
  }
);

// console_log -----------------------------------------------------------------
server.tool(
  "console_log",
  `Return browser console messages captured since the browser was started or last cleared.

CONTEXT BUDGET — console output can be large on noisy pages. Use the level filter to limit to errors/warnings. Use clear: true to reset the buffer after reading.`,
  {
    level: z
      .enum(["all", "error", "warning", "info", "log"])
      .default("all")
      .optional()
      .describe("Filter by severity. 'all' returns everything. Default: 'all'."),
    maxEntries: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .optional()
      .describe("Maximum number of entries to return (most recent). Default: 50."),
    clear: z
      .boolean()
      .default(false)
      .optional()
      .describe("Clear the captured log buffer after returning results. Default: false."),
  },
  async ({ level = "all", maxEntries = 50, clear = false }) => {
    try {
      await mgr.initialize();

      let logs = mgr.consoleLogs;
      if (level !== "all") logs = logs.filter((m) => m.level === level);
      const slice = logs.slice(-maxEntries);

      if (clear) mgr.consoleLogs = [];

      if (slice.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No console messages captured${level !== "all" ? ` at level '${level}'` : ""}.`,
            },
          ],
        };
      }

      const formatted = slice
        .map((m) => `[${new Date(m.timestamp).toISOString()}] [${m.level.toUpperCase()}] ${m.text}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${slice.length} console message(s)${level !== "all" ? ` (level: ${level})` : ""}:\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// scroll_down -----------------------------------------------------------------
server.tool(
  "scroll_down",
  "Scroll down the page by a specified number of pixels (default 500).",
  {
    pixels: z.number().default(500).optional().describe("Number of pixels to scroll down. Default: 500."),
  },
  async ({ pixels = 500 }) => {
    try {
      const page = await mgr.getPage();
      await page.evaluate(`window.scrollBy(0, ${pixels})`);
      await globalWait();
      return { content: [{ type: "text", text: `Scrolled down by ${pixels} pixels.` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// scroll_up -------------------------------------------------------------------
server.tool(
  "scroll_up",
  "Scroll up the page by a specified number of pixels (default 500).",
  {
    pixels: z.number().default(500).optional().describe("Number of pixels to scroll up. Default: 500."),
  },
  async ({ pixels = 500 }) => {
    try {
      const page = await mgr.getPage();
      await page.evaluate(`window.scrollBy(0, -${pixels})`);
      await globalWait();
      return { content: [{ type: "text", text: `Scrolled up by ${pixels} pixels.` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// go_back ---------------------------------------------------------------------
server.tool(
  "go_back",
  "Go back to the previous page in the browser history.",
  {},
  async () => {
    try {
      const page = await mgr.getPage();
      await page.goBack({ waitUntil: "commit", timeout: 10000 });
      await globalWait();
      return { content: [{ type: "text", text: "Went back to the previous page." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// go_forward ------------------------------------------------------------------
server.tool(
  "go_forward",
  "Go forward to the next page in the browser history.",
  {},
  async () => {
    try {
      const page = await mgr.getPage();
      await page.goForward({ waitUntil: "commit", timeout: 10000 });
      await globalWait();
      return { content: [{ type: "text", text: "Went forward to the next page." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// refresh ---------------------------------------------------------------------
server.tool(
  "refresh",
  "Reload the current page.",
  {},
  async () => {
    try {
      const page = await mgr.getPage();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await globalWait();
      return { content: [{ type: "text", text: "Page reloaded." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// google_search ---------------------------------------------------------------
server.tool(
  "google_search",
  `Perform a Google search for the given query and navigate to the results page.

CONTEXT BUDGET — returns an inline screenshot of the results page. For searching and then interacting with results, use go_to_url + get_page_text or get_screenshot instead.`,
  {
    query: z.string().describe("The search query to use on Google."),
  },
  async ({ query }) => {
    try {
      const page = await mgr.getPage();
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      await globalWait();
      const screenshot = await page.screenshot();
      return {
        content: [
          {
            type: "image",
            data: screenshot.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// go_to_url -------------------------------------------------------------------
server.tool(
  "go_to_url",
  "Navigate the browser to the specified URL.",
  {
    url: z.string().describe("The URL to navigate to."),
  },
  async ({ url }) => {
    try {
      const page = await mgr.getPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await globalWait();
      return { content: [{ type: "text", text: `Navigated to ${url}` }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// start_browser ---------------------------------------------------------------
server.tool(
  "start_browser",
  "Start the browser if it is not already running. Returns a Steel debug URL when running in steel mode.",
  {},
  async () => {
    try {
      await mgr.initialize();
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: "Browser started." },
      ];
      if (mgr.debugUrl) {
        content.push({ type: "text", text: `Steel Debug URL: ${mgr.debugUrl}` });
      }
      return { content };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// stop_browser ----------------------------------------------------------------
server.tool(
  "stop_browser",
  "Stop the browser and clean up resources. Releases the Steel session if one is active.",
  {},
  async () => {
    try {
      await mgr.stop();
      return { content: [{ type: "text", text: "Browser stopped." }] };
    } catch (err) {
      const error = err as Error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
);

// -----------------------------------------------------------------------------
// Server lifecycle
// -----------------------------------------------------------------------------
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Steel MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.error("Received SIGINT, cleaning up...");
  await mgr.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Received SIGTERM, cleaning up...");
  await mgr.stop();
  process.exit(0);
});
