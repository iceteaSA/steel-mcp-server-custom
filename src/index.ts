#!/usr/bin/env node

import { openai } from "@ai-sdk/openai";
import { Memory } from "@mastra/memory";
import {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Browser, BrowserContext, Beam } from "beam";
import { z } from "zod";

import dotenv, { config } from "dotenv";
import {
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Steel } from "steel-sdk";

dotenv.config();

const supportedOpenAIModels = [
  "o1",
  "o1-2024-12-17",
  "o1-mini",
  "o1-mini-2024-09-12",
  "o1-preview",
  "o1-preview-2024-09-12",
  "o3-mini",
  "o3-mini-2025-01-31",
  "o3",
  "o3-2025-04-16",
  "o4-mini",
  "o4-mini-2025-04-16",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-4o-audio-preview",
  "gpt-4o-audio-preview-2024-10-01",
  "gpt-4o-audio-preview-2024-12-17",
  "gpt-4o-search-preview",
  "gpt-4o-search-preview-2025-03-11",
  "gpt-4o-mini-search-preview",
  "gpt-4o-mini-search-preview-2025-03-11",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-turbo-preview",
  "gpt-4-0125-preview",
  "gpt-4-1106-preview",
  "gpt-4",
  "gpt-4-0613",
  "gpt-4.5-preview",
  "gpt-4.5-preview-2025-02-27",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-1106",
  "chatgpt-4o-latest",
];

// Create an MCP server
const server = new McpServer({
  name: "Steel-MCP-Server",
  version: "1.0.0",
  capabilities: {
    tools: {},
  },
});

/*
- get screenshot
- agent / prompt
- scroll down
- scroll up
- go back
- go forward
- refresh
- google search
*/

/*
env vars
- browser mode ( steel by default )
- useVision ( true by default )
- LLM API KEY ( anthropic / openai )
- model name ( gpt-4o by default )
- steel api key
*/

class BeamClass {
  initialized: boolean = false;
  public beam: Beam | undefined;
  private browser: Browser | undefined;
  public context: BrowserContext | undefined;
  private steelClient: Steel | undefined;
  // private run:
  constructor() {}

  async initialize() {
    const env = z
      .object({
        BROWSER_MODE: z
          .string()
          .transform((arg) => arg.toLowerCase())
          .refine((arg) => arg === "steel" || arg === "local", {
            message:
              "BROWSER_MODE environment variable must be either 'STEEL' or 'LOCAL' (case insensitive)",
          })
          .default("steel"),
        OPENAI_API_KEY: z.string().optional(),
        ANTHROPIC_API_KEY: z.string().optional(),
        MODEL_NAME: z.string().optional(),
        STEEL_API_KEY: z.string().optional(),
      })
      .refine((env) => env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY, {
        message:
          "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set in the environment.",
        path: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      })
      .refine(
        (env) => {
          if (env.OPENAI_API_KEY && env.MODEL_NAME) {
            return supportedOpenAIModels.includes(env.MODEL_NAME);
          }
          return true;
        },
        {
          message: "MODEL_NAME must be a supported OpenAI model.",
          path: ["MODEL_NAME"],
        }
      )
      .refine(
        (env) => {
          if (env.BROWSER_MODE === "steel") {
            return !!env.STEEL_API_KEY;
          }
          return true;
        },
        {
          message:
            "STEEL_API_KEY must be set when BROWSER_MODE is 'steel' ( steel is set by default ).",
          path: ["STEEL_API_KEY"],
        }
      );

    const result = env.parse(process.env);

    this.steelClient = new Steel({
      ...(result.STEEL_API_KEY ? { steelAPIKey: result.STEEL_API_KEY } : {}),
    });

    const session = await this.steelClient.sessions.create();

    const connectUrl = "wss://connect.steel.dev";
    const cdpUrl = `${connectUrl}?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;

    // Create a Browser instance with CDP URL - this will use setupRemoteCdpBrowser internally
    this.browser = new Browser({
      // cdpUrl,
      // browserClass: "chromium",
      headless: false,
    });

    this.context = new BrowserContext({
      browser: this.browser,
      config: {},
    });

    openai("gpt-4o-audio-preview");

    this.beam = new Beam({
      browser: this.browser,
      context: this.context,
      llm: openai("gpt-4o"),
      useVision: true,
      keepAlive: true,
      useSteel: false,
    });

    await this.beam.initialize();
  }
}

const beam = new BeamClass();

server.tool(
  "test",
  "this is a test tool that should be run when the user says to run the test tool.",
  {},
  async () => {
    try {
      await beam.initialize();

      await beam.beam!.run({
        task: "Go to news.ycombinator.com and click on the 1st AI / LLM related article",
      });

      const page = await beam.context!.getCurrentPage();

      const screenshot = await page.screenshot();

      const scroll = await page.evaluate(`window.scrollBy(0, 500)`);

      return {
        content: [
          {
            type: "text",
            text: "success",
          },
          {
            type: "image",
            data: screenshot.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    } catch (err) {
      const error = err as Error;
      return {
        isError: true,
        content: [
          { type: "text", text: error.message },
          {
            type: "text",
            text: "Chat with the error tools to learn more about this error.",
          },
        ],
      };
    }
  }
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP Filesystem Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
