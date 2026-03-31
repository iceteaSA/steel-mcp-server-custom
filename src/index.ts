#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Browser, BrowserContext, Beam } from "beam";
import { Steel } from "steel-sdk";
import { AnthropicMessagesModelId, EnvSchema, OpenAIChatModelId } from "./env";
import { z } from "zod";

// -----------------------------------------------------------------------------
// LLM helper
// -----------------------------------------------------------------------------
function getLLM(
  env: z.infer<typeof EnvSchema>,
  openAIModelName?: OpenAIChatModelId,
  anthropicModelName?: AnthropicMessagesModelId
) {
  if (env.OPENAI_API_KEY && openAIModelName) {
    return openai(openAIModelName);
  } else if (env.ANTHROPIC_API_KEY && anthropicModelName) {
    return anthropic(anthropicModelName);
  } else {
    throw new Error(
      "No valid LLM configuration found. Check your API keys and model names."
    );
  }
}

// -----------------------------------------------------------------------------
// MCP server instance
// -----------------------------------------------------------------------------
const server = new McpServer({
  name: "Steel Browser MCP Server",
  version: "1.0.0",
  capabilities: {
    tools: {},
  },
});

const env = EnvSchema.parse(process.env);

// -----------------------------------------------------------------------------
// BeamClass — wraps browser lifecycle (Steel cloud or local)
// -----------------------------------------------------------------------------
class BeamClass {
  initialized: boolean = false;
  public beam: Beam | undefined;
  public context: BrowserContext | undefined;
  private browser: Browser | undefined;
  private steelClient: Steel | undefined;
  public debugUrl: string | undefined;

  constructor() {}

  async initialize() {
    if (this.initialized) {
      return;
    }
    const env = EnvSchema.parse(process.env);

    if (env.BROWSER_MODE === "steel") {
      this.steelClient = new Steel({
        ...(env.STEEL_API_KEY ? { steelAPIKey: env.STEEL_API_KEY } : {}),
        ...(env.STEEL_BASE_URL ? { baseURL: env.STEEL_BASE_URL } : {}),
      });

      const session = await this.steelClient.sessions.create();
      this.debugUrl = session.debugUrl;

      // Resolve the CDP WebSocket URL. If STEEL_BASE_URL is provided, derive
      // the ws(s):// endpoint from it; otherwise fall back to Steel cloud.
      let cdpUrl: string;
      if (env.STEEL_BASE_URL) {
        const base = env.STEEL_BASE_URL.replace(/\/$/, "");
        const wsBase = base.startsWith("https://")
          ? base.replace("https://", "wss://")
          : base.replace("http://", "ws://");
        cdpUrl = `${wsBase}/?sessionId=${session.id}`;
      } else {
        cdpUrl = `wss://connect.steel.dev?apiKey=${env.STEEL_API_KEY}&sessionId=${session.id}`;
      }

      this.browser = new Browser({
        cdpUrl,
        browserClass: "chromium",
        headless: false,
      });
    } else {
      // Local mode — launch a browser directly (no Steel session).
      this.browser = new Browser({
        headless: false,
      });
      this.debugUrl = undefined;
    }

    this.context = new BrowserContext({
      browser: this.browser,
      config: {
        viewport: {
          width: env.DEFAULT_VIEWPORT_WIDTH,
          height: env.DEFAULT_VIEWPORT_HEIGHT,
        },
      },
    });

    const openAIModelName: OpenAIChatModelId =
      env.OPENAI_API_KEY && env.MODEL_NAME
        ? (env.MODEL_NAME as OpenAIChatModelId)
        : "gpt-4o";
    const anthropicModelName: AnthropicMessagesModelId =
      env.ANTHROPIC_API_KEY && env.MODEL_NAME
        ? (env.MODEL_NAME as AnthropicMessagesModelId)
        : "claude-3-7-sonnet-20250219";

    const llm = getLLM(env, openAIModelName, anthropicModelName);

    this.beam = new Beam({
      browser: this.browser,
      context: this.context,
      llm,
      useVision: true,
      keepAlive: true,
      useSteel: false,
    });

    await this.beam.initialize();
    this.initialized = true;
  }

  async stop() {
    if (this.browser) {
      if (typeof this.browser.close === "function") {
        await this.browser.close();
      }
      this.browser = undefined;
    }
    this.context = undefined;
    this.beam = undefined;
    this.initialized = false;
  }
}

const mcpBeam = new BeamClass();

// -----------------------------------------------------------------------------
// Helper: resolve inline vs file output mode
// -----------------------------------------------------------------------------
async function writeToFile(
  data: Buffer | string,
  defaultPath: string,
  outputPath?: string
): Promise<string> {
  const dir = env.OUTPUT_DIR;
  await fs.mkdir(dir, { recursive: true });
  const filePath = outputPath ?? path.join(dir, defaultPath);
  await fs.writeFile(filePath, data);
  return filePath;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

// agent_prompt ----------------------------------------------------------------
const agentPromptTool = server.tool(
  "agent_prompt",
  `Use this tool for any high-level, multi-step, or vague browser task.
Examples: 'Go to nytimes.com and click the first article about AI', 'Search for OpenAI on Google and click the first result', 'Log in to my account and take a screenshot'.
The agent interprets and executes the task using browser automation and LLM reasoning.
This is the recommended tool for most user actions.`,
  {
    task: z
      .string()
      .describe(
        "A detailed description of the task or prompt for the agent to perform. Be as specific as possible for best results."
      ),
  },
  async ({ task }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.beam) throw new Error("Beam not initialized");
      await mcpBeam.beam.run({ task });
      return {
        content: [{ type: "text", text: `Agent task completed: ${task}` }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// get_screenshot --------------------------------------------------------------
const getScreenshotTool = server.tool(
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
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();

      const effectiveQuality = quality ?? env.DEFAULT_SCREENSHOT_QUALITY;
      const effectiveMaxInlineBytes = maxInlineBytes ?? env.MAX_INLINE_BYTES;

      // Apply scale by temporarily resizing the viewport.
      // Playwright uses setViewportSize({ width, height }) — no deviceScaleFactor.
      const origVp = page.viewportSize() ?? {
        width: env.DEFAULT_VIEWPORT_WIDTH,
        height: env.DEFAULT_VIEWPORT_HEIGHT,
      };
      if (scale !== 1.0) {
        await page.setViewportSize({
          width: Math.round(origVp.width * scale),
          height: Math.round(origVp.height * scale),
        });
      }

      const screenshotOpts: Parameters<typeof page.screenshot>[0] = {
        type: format,
        fullPage,
      };
      if (format === "jpeg") screenshotOpts.quality = effectiveQuality;
      if (clip) screenshotOpts.clip = clip;

      const buffer = await page.screenshot(screenshotOpts);

      // Restore original viewport
      if (scale !== 1.0) {
        await page.setViewportSize(origVp);
      }

      // Auto-downgrade to file if too large
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
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// get_page_text ---------------------------------------------------------------
const getPageTextTool = server.tool(
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
        "Maximum characters to return inline. Truncates with a notice. Default: 10000. Set to 0 for no limit (use with outputMode: 'file')."
      ),
    outputMode: z
      .enum(["inline", "file"])
      .default("inline")
      .optional()
      .describe(
        "Return text inline (default) or save to file and return path. Use 'file' to avoid loading large text into context."
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
      .describe(
        "Append link URLs in brackets after each anchor's text. Default: false."
      ),
  },
  async ({
    selector,
    maxChars = 10000,
    outputMode = "inline",
    outputPath,
    includeLinks = false,
  }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();

      let text: string;

      if (includeLinks) {
        text = await page.evaluate((sel: string | null) => {
          const root = sel
            ? document.querySelector(sel)
            : document.body;
          if (!root) return "";
          const walk = (node: Element): string => {
            if (node.tagName === "A") {
              const href = (node as HTMLAnchorElement).href;
              return `${node.textContent?.trim()} [${href}]`;
            }
            return Array.from(node.childNodes)
              .map((n) =>
                n.nodeType === 3
                  ? n.textContent ?? ""
                  : walk(n as Element)
              )
              .join(" ");
          };
          return walk(root as Element);
        }, selector ?? null);
      } else {
        text = await page.evaluate((sel: string | null) => {
          const root = sel
            ? document.querySelector(sel)
            : document.body;
          return (root as HTMLElement)?.innerText ?? "";
        }, selector ?? null);
      }

      text = text.replace(/\s+/g, " ").trim();

      if (outputMode === "file") {
        const defaultName = `page_text_${Date.now()}.txt`;
        const filePath = await writeToFile(
          Buffer.from(text, "utf8"),
          defaultName,
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
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// scroll_down -----------------------------------------------------------------
const scrollDownTool = server.tool(
  "scroll_down",
  "Scroll down the page by a specified number of pixels (default 500). Use this for precise, atomic scrolling. For scrolling as part of a larger task (e.g., 'scroll down and click the blue button'), use agent_prompt instead.",
  {
    pixels: z
      .number()
      .describe("Number of pixels to scroll down. Default is 500.")
      .default(500)
      .optional(),
  },
  async ({ pixels = 500 }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.evaluate(`window.scrollBy(0, ${pixels})`);
      return {
        content: [{ type: "text", text: `Scrolled down by ${pixels} pixels.` }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// scroll_up -------------------------------------------------------------------
const scrollUpTool = server.tool(
  "scroll_up",
  "Scroll up the page by a specified number of pixels (default 500). Use this for precise, atomic scrolling. For scrolling as part of a larger task (e.g., 'scroll up and click the first link'), use agent_prompt instead.",
  {
    pixels: z
      .number()
      .describe("Number of pixels to scroll up. Default is 500.")
      .default(500)
      .optional(),
  },
  async ({ pixels = 500 }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.evaluate(`window.scrollBy(0, -${pixels})`);
      return {
        content: [{ type: "text", text: `Scrolled up by ${pixels} pixels.` }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// go_back ---------------------------------------------------------------------
const goBackTool = server.tool(
  "go_back",
  "Go back to the previous page in the browser history. For multi-step navigation (e.g., 'go back and then click a button'), use agent_prompt instead.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.goBack();
      return {
        content: [{ type: "text", text: "Went back to the previous page." }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// go_forward ------------------------------------------------------------------
const goForwardTool = server.tool(
  "go_forward",
  "Go forward to the next page in the browser history. For multi-step navigation (e.g., 'go forward and then fill a form'), use agent_prompt instead.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.goForward();
      return {
        content: [{ type: "text", text: "Went forward to the next page." }],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// refresh ---------------------------------------------------------------------
const refreshTool = server.tool(
  "refresh",
  "Reload the current page. For refreshing as part of a larger workflow (e.g., 'refresh and then take a screenshot'), use agent_prompt instead.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.reload();
      return { content: [{ type: "text", text: "Page reloaded." }] };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// google_search ---------------------------------------------------------------
const googleSearchTool = server.tool(
  "google_search",
  `Perform a Google search for the given query and navigate to the results page.

CONTEXT BUDGET — returns an inline screenshot of the results page. For searching and then interacting with results (e.g., clicking a link), use agent_prompt instead.`,
  {
    query: z
      .string()
      .describe(
        "The search query to use on Google. For searching and clicking/interacting, use agent_prompt instead."
      ),
  },
  async ({ query }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await page.goto(url);
      const screenshot = await page.screenshot();
      return {
        content: [
          {
            type: "image",
            data: (screenshot as Buffer).toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// go_to_url -------------------------------------------------------------------
const goToUrlTool = server.tool(
  "go_to_url",
  "Navigate the browser directly to the specified URL. For navigation followed by further actions (e.g., 'go to this URL and click a button'), use agent_prompt instead.",
  {
    url: z
      .string()
      .describe(
        "The URL to navigate to. For navigation and further actions, use agent_prompt instead."
      ),
  },
  async ({ url }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      await page.goto(url);
      return { content: [{ type: "text", text: `Navigated to ${url}` }] };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// start_browser ---------------------------------------------------------------
const startBrowserTool = server.tool(
  "start_browser",
  "Start the browser if it is not already running. Returns a Steel debug URL when running in steel mode.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: "Browser started." },
      ];
      if (mcpBeam.debugUrl) {
        content.push({
          type: "text",
          text: `Steel Debug URL: ${mcpBeam.debugUrl}`,
        });
      }
      return { content };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// stop_browser ----------------------------------------------------------------
const stopBrowserTool = server.tool(
  "stop_browser",
  "Stop the browser and clean up resources.",
  {},
  async () => {
    try {
      await mcpBeam.stop();
      return { content: [{ type: "text", text: "Browser stopped." }] };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  }
);

// -----------------------------------------------------------------------------
// Tool mode configuration (MCP_MODE env var)
// -----------------------------------------------------------------------------
const agentTools = [agentPromptTool];

const browserTools = [
  getScreenshotTool,
  getPageTextTool,
  scrollDownTool,
  scrollUpTool,
  goBackTool,
  goForwardTool,
  refreshTool,
  googleSearchTool,
  goToUrlTool,
  startBrowserTool,
  stopBrowserTool,
];

if (env.MCP_MODE === "agent") {
  agentTools.forEach((tool) => tool.enable());
  browserTools.forEach((tool) => tool.disable());
} else if (env.MCP_MODE === "toolset") {
  agentTools.forEach((tool) => tool.disable());
  browserTools.forEach((tool) => tool.enable());
} else {
  // "both" — all tools enabled (default)
  agentTools.forEach((tool) => tool.enable());
  browserTools.forEach((tool) => tool.enable());
}

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
  console.error("Received SIGINT, cleaning up browser sessions...");
  await mcpBeam.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Received SIGTERM, cleaning up browser sessions...");
  await mcpBeam.stop();
  process.exit(0);
});
