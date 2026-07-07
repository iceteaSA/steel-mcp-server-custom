import { z } from "zod";
import type { Env } from "./manager.js";

/**
 * True when the environment provides both an OpenAI-compatible base URL and
 * a model name, which are the minimum fields needed by llmJson().
 */
export function llmConfigured(env: Env): boolean {
  return !!env.ACT_LLM_BASE_URL && !!env.ACT_LLM_MODEL;
}

interface LlmJsonOptions<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Call an OpenAI-compatible chat endpoint and coerce the response through a
 * Zod schema. Performs one repair retry if JSON parsing or schema validation
 * fails, appending the error to the conversation so the model can correct it.
 */
export async function llmJson<T>(env: Env, opts: LlmJsonOptions<T>): Promise<T> {
  const baseUrl = env.ACT_LLM_BASE_URL!;
  const model = env.ACT_LLM_MODEL!;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let firstParseError: Error | undefined;
  let secondParseError: Error | undefined;
  let firstRaw = "";
  let secondRaw = "";

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  // DeepSeek (and any provider strictly following the OpenAI json_object spec)
  // rejects requests whose prompt messages do not contain the literal word
  // "json" somewhere when response_format.type === "json_object". The
  // upstream spec rule is provider-neutral, so we enforce it here at the
  // chokepoint — harmless for permissive providers (llama.cpp, gemma),
  // required for strict ones (DeepSeek). The repair-retry message below
  // already contains "JSON" so this only matters on the first attempt;
  // idempotent across iterations because the appended instruction sticks.
  const JSON_OBJECT_INSTRUCTION = "Respond with a single valid JSON object and nothing else.";
  if (!messages.some((m) => /json/i.test(m.content))) {
    const sys = messages[0];
    if (sys.role === "system") {
      messages[0] = { ...sys, content: `${sys.content}\n\n${JSON_OBJECT_INSTRUCTION}` };
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (env.ACT_LLM_API_KEY) {
        headers["Authorization"] = `Bearer ${env.ACT_LLM_API_KEY}`;
      }

      const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
      const res = await fetch(`${normalizedBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: opts.maxTokens,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `LLM request failed: ${res.status} ${res.statusText}. Body: ${text.slice(0, 500)}`,
        );
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        const error = new Error(
          `Invalid JSON returned by LLM: ${(err as Error).message}. Content: ${content.slice(0, 500)}`,
        );
        if (attempt === 0) {
          firstParseError = error;
          firstRaw = content;
        } else {
          secondParseError = error;
          secondRaw = content;
        }
        throw error;
      }

      try {
        return opts.schema.parse(parsed);
      } catch (err) {
        const error = new Error(
          `LLM response failed schema validation: ${(err as Error).message}. Content: ${content.slice(0, 500)}`,
        );
        if (attempt === 0) {
          firstParseError = error;
          firstRaw = content;
        } else {
          secondParseError = error;
          secondRaw = content;
        }
        throw error;
      }
    } catch (err) {
      const isParseError = /Invalid JSON|failed schema validation/i.test((err as Error).message);
      if (attempt === 0 && isParseError) {
        messages.push({
          role: "user" as const,
          content: [
            `Your previous response could not be parsed or did not match the requested schema.`,
            `Error: ${(err as Error).message}`,
            `Raw response: ${(firstRaw || "").slice(0, 1000)}`,
            `Return ONLY valid JSON matching the schema, no prose.`,
          ].join("\n"),
        });
        continue;
      }
      if (attempt === 1 && isParseError) {
        throw new Error(
          [
            `LLM request failed after one repair retry.`,
            `First error: ${firstParseError?.message ?? ""}`,
            `Second error: ${(err as Error).message}`,
            `Raw responses:\n---\n${firstRaw}\n---\n${secondRaw}`,
          ].join("\n"),
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    [
      `LLM request failed after one repair retry.`,
      `First error: ${firstParseError?.message ?? ""}`,
      `First raw response: ${firstRaw.slice(0, 500)}`,
      `Second error: ${secondParseError?.message ?? ""}`,
      `Second raw response: ${secondRaw.slice(0, 500)}`,
    ].join("\n"),
  );
}
