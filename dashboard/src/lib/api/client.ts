/** Shared fetch wrapper. Throws `Error("API <status>: <body>")` on non-2xx. */

import type { ZodType } from "zod";

const defaultHeaders: HeadersInit = { "Content-Type": "application/json" };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...defaultHeaders, ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function requestJson<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const result = schema.safeParse(await request<unknown>(path, init));
  if (!result.success) throw new Error("Unexpected response from server");
  return result.data;
}

export async function requestText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.text();
}
