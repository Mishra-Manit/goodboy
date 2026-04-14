import { loadEnv } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("llm");

const DEFAULT_MODEL = "accounts/fireworks/models/llama-v3p3-70b-instruct";

interface CompleteOptions {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function complete(
  prompt: string,
  options: CompleteOptions = {}
): Promise<string | null> {
  const apiKey = loadEnv().FIREWORKS_API_KEY;
  if (!apiKey) {
    log.warn("No FIREWORKS_API_KEY set, skipping LLM call");
    return null;
  }

  const { system, model = DEFAULT_MODEL, maxTokens = 256, temperature = 0 } = options;

  const messages = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    { role: "user" as const, content: prompt },
  ];

  try {
    const res = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    });

    if (!res.ok) {
      log.warn(`Fireworks API returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    log.warn("Fireworks API call failed", err);
    return null;
  }
}
