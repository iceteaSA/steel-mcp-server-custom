#!/usr/bin/env node

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Browser, BrowserContext, Beam } from "beam";
import { Steel } from "steel-sdk";
import { AnthropicMessagesModelId, EnvSchema, OpenAIChatModelId } from "./env";
import { z } from "zod";

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
- go to url
*/

class BeamClass {
  initialized: boolean = false;
  public beam: Beam | undefined;
  public context: BrowserContext | undefined;
  private browser: Browser | undefined;
  private steelClient: Steel | undefined;
  // private run:
  constructor() {}

  async initialize() {
    const env = EnvSchema.parse(process.env);

    if (env.BROWSER_MODE === "steel") {
      this.steelClient = new Steel({
        ...(env.STEEL_API_KEY ? { steelAPIKey: env.STEEL_API_KEY } : {}),
      });

      const session = await this.steelClient.sessions.create();

      const connectUrl = "wss://connect.steel.dev";
      const cdpUrl = `${connectUrl}?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`;
      // Create a Browser instance with CDP URL - this will use setupRemoteCdpBrowser internally
      this.browser = new Browser({
        cdpUrl,
        browserClass: "chromium",
        headless: false,
      });
    } else {
      this.browser = new Browser({
        headless: false,
      });
    }

    this.context = new BrowserContext({
      browser: this.browser,
      config: {},
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
  }
}

const mcpBeam = new BeamClass();

server.tool(
  "test",
  "this is a test tool that should be run when the user says to run the test tool.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();

      if (!mcpBeam.beam || !mcpBeam.context) {
        throw new Error("Beam not initialized");
      }

      await mcpBeam.beam.run({
        task: "Go to news.ycombinator.com and click on the 1st AI / LLM related article",
      });

      const page = await mcpBeam.context.getCurrentPage();

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
