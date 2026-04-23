/**
 * Fireworks LLM client used for non-pi work (intent classification, branch
 * name slugging). Exposes `complete` (raw text) and `structuredOutput`
 * (JSON validated through a Zod schema at the trust boundary).
 */

import type { ZodType } from "zod";
import { loadEnv } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("llm");

const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const DEFAULT_MODEL = "accounts/fireworks/models/kimi-k2p6";
export const LIGHT_MODEL = "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface CompleteOptions {
  readonly system?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface StructuredOutputOptions<T> {
  readonly system: string;
  readonly prompt: string;
  readonly schema: ZodType<T>;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

// --- Public API ---

/** Raw text completion. Returns `null` on any failure (network, non-2xx, empty body). */
export async function complete(
  prompt: string,
  options: CompleteOptions = {},
): Promise<string | null> {
  const { system, model = DEFAULT_MODEL, maxTokens = 256, temperature = 0 } = options;

  const messages: readonly ChatMessage[] = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    { role: "user" as const, content: prompt },
  ];

  const raw = await fireworksRequest(messages, { model, maxTokens, temperature });
  return raw;
}

/** JSON completion validated through a Zod schema. Throws on network, parse, or schema failure. */
export async function structuredOutput<T>(options: StructuredOutputOptions<T>): Promise<T> {
  const {
    system,
    prompt,
    schema,
    model = DEFAULT_MODEL,
    maxTokens = 512,
    temperature = 0,
  } = options;

  const messages: readonly ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  const raw = await fireworksRequest(messages, {
    model,
    maxTokens,
    temperature,
    jsonMode: true,
  });

  if (!raw) {
    throw new Error("LLM returned empty response in structured output mode");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error("LLM returned invalid JSON", { raw });
    throw new Error("LLM returned invalid JSON");
  }


  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.error("LLM output failed schema validation", {
      raw,
      errors: result.error.issues,
    });
    throw new Error(`LLM output failed schema validation: ${result.error.message}`);
  }

  return result.data;
}

// --- Internal ---

interface RequestOptions {
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly jsonMode?: boolean;
}

async function fireworksRequest(
  messages: readonly ChatMessage[],
  options: RequestOptions,
): Promise<string | null> {
  const apiKey = loadEnv().FIREWORKS_API_KEY;

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
  };

  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  try {
    const res = await fetch(FIREWORKS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      log.warn(`Fireworks API returned ${res.status}`, { body: text });
      return null;
    }

    const data = (await res.json()) as {
      choices: ReadonlyArray<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    log.warn("Fireworks API call failed", err);
    return null;
  }
}
