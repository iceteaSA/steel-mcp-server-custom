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

// --- MCP Tools Implementation ---

// 1. Get Screenshot
server.tool(
  "get_screenshot",
  "Take a screenshot of the current page and return it as a base64-encoded PNG. Use this for visual confirmation of the current browser state. For screenshots after complex navigation or actions, use the agent_prompt tool to perform those actions first.",
  {},
  async () => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      const screenshot = await page.screenshot();
      return {
        content: [
          { type: "text", text: "Screenshot taken." },
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

// 2. Agent / Prompt
server.tool(
  "agent_prompt",
  "Use this tool for any high-level, multi-step, or vague browser task. For example: 'Go to nytimes.com and click the first article about AI', 'Search for OpenAI on Google and click the first result', or 'Log in to my account and take a screenshot'. The agent will interpret and execute the task using browser automation and LLM reasoning. This is the recommended tool for most user actions.",
  {
    task: {
      type: "string",
      description:
        "A detailed description of the task or prompt for the agent to perform. Be as specific as possible for best results.",
    },
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

// 3. Scroll Down
server.tool(
  "scroll_down",
  "Scroll down the page by a specified number of pixels (default 500). Use this for precise, atomic scrolling. For scrolling as part of a larger task (e.g., 'scroll down and click the blue button'), use agent_prompt instead.",
  {
    pixels: {
      type: "number",
      description: "Number of pixels to scroll down. Default is 500.",
      default: 500,
      optional: true,
    },
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

// 4. Scroll Up
server.tool(
  "scroll_up",
  "Scroll up the page by a specified number of pixels (default 500). Use this for precise, atomic scrolling. For scrolling as part of a larger task (e.g., 'scroll up and click the first link'), use agent_prompt instead.",
  {
    pixels: {
      type: "number",
      description: "Number of pixels to scroll up. Default is 500.",
      default: 500,
      optional: true,
    },
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

// 5. Go Back
server.tool(
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

// 6. Go Forward
server.tool(
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

// 7. Refresh
server.tool(
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

// 8. Google Search
server.tool(
  "google_search",
  "Perform a Google search for the given query and navigate to the results page. For searching and then interacting with results (e.g., clicking a link), use agent_prompt instead.",
  {
    query: {
      type: "string",
      description:
        "The search query to use on Google. For searching and clicking/interacting, use agent_prompt instead.",
    },
  },
  async ({ query }) => {
    try {
      await mcpBeam.initialize();
      if (!mcpBeam.context) throw new Error("Beam not initialized");
      const page = await mcpBeam.context.getCurrentPage();
      const url = `https://www.google.com/search?q=${encodeURIComponent(
        query
      )}`;
      await page.goto(url);
      return {
        content: [{ type: "text", text: `Searched Google for '${query}'.` }],
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

// 9. Go to URL
server.tool(
  "go_to_url",
  "Navigate the browser directly to the specified URL. For navigation followed by further actions (e.g., 'go to this URL and click a button'), use agent_prompt instead.",
  {
    url: {
      type: "string",
      description:
        "The URL to navigate to. For navigation and further actions, use agent_prompt instead.",
    },
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
