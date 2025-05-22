import dotenv from "dotenv";
import { z } from "zod";

export const supportedOpenAIModels = [
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
export type OpenAIChatModelId =
  | "o1"
  | "o1-2024-12-17"
  | "o1-mini"
  | "o1-mini-2024-09-12"
  | "o1-preview"
  | "o1-preview-2024-09-12"
  | "o3-mini"
  | "o3-mini-2025-01-31"
  | "o3"
  | "o3-2025-04-16"
  | "o4-mini"
  | "o4-mini-2025-04-16"
  | "gpt-4.1"
  | "gpt-4.1-2025-04-14"
  | "gpt-4.1-mini"
  | "gpt-4.1-mini-2025-04-14"
  | "gpt-4.1-nano"
  | "gpt-4.1-nano-2025-04-14"
  | "gpt-4o"
  | "gpt-4o-2024-05-13"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-2024-11-20"
  | "gpt-4o-audio-preview"
  | "gpt-4o-audio-preview-2024-10-01"
  | "gpt-4o-audio-preview-2024-12-17"
  | "gpt-4o-search-preview"
  | "gpt-4o-search-preview-2025-03-11"
  | "gpt-4o-mini-search-preview"
  | "gpt-4o-mini-search-preview-2025-03-11"
  | "gpt-4o-mini"
  | "gpt-4o-mini-2024-07-18"
  | "gpt-4-turbo"
  | "gpt-4-turbo-2024-04-09"
  | "gpt-4-turbo-preview"
  | "gpt-4-0125-preview"
  | "gpt-4-1106-preview"
  | "gpt-4"
  | "gpt-4-0613"
  | "gpt-4.5-preview"
  | "gpt-4.5-preview-2025-02-27"
  | "gpt-3.5-turbo-0125"
  | "gpt-3.5-turbo"
  | "gpt-3.5-turbo-1106"
  | "chatgpt-4o-latest";

export const supportedAnthropicModels = [
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-latest",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-haiku-latest",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-latest",
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
];

export type AnthropicMessagesModelId =
  | "claude-3-7-sonnet-20250219"
  | "claude-3-5-sonnet-latest"
  | "claude-3-5-sonnet-20241022"
  | "claude-3-5-sonnet-20240620"
  | "claude-3-5-haiku-latest"
  | "claude-3-5-haiku-20241022"
  | "claude-3-opus-latest"
  | "claude-3-opus-20240229"
  | "claude-3-sonnet-20240229"
  | "claude-3-haiku-20240307";

dotenv.config();

export const EnvSchema = z
  .object({
    MCP_MODE: z
      .string()
      .transform((arg) => arg.toLowerCase())
      .refine((arg) => arg === "agent" || arg === "toolset" || arg === "both", {
        message:
          "MCP_MODE environment variable must be either 'agent' or 'tool' or 'both' (case insensitive)",
      })
      .default("both")
      .optional(),
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
    MODEL_NAME: z
      .string()
      .transform((val) => val.toLowerCase())
      .refine(
        (val) =>
          supportedOpenAIModels
            .concat(supportedAnthropicModels)
            .map((m) => m.toLowerCase())
            .includes(val),
        {
          message: "MODEL_NAME must be a supported OpenAI or Anthropic model.",
        }
      )
      .optional(),
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
      if (env.ANTHROPIC_API_KEY && env.MODEL_NAME) {
        return supportedAnthropicModels.includes(
          env.MODEL_NAME as AnthropicMessagesModelId
        );
      }
      return true;
    },
    {
      message: "MODEL_NAME must be a supported OpenAI or Anthropic model.",
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
