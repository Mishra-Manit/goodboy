/**
 * Shared msw server for tests that hit the Fireworks API. Importers are
 * responsible for calling `server.listen / resetHandlers / close` in their
 * own `beforeAll / afterEach / afterAll` hooks, so unrelated test files
 * don't pay the server startup cost.
 */

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

export const server = setupServer();

/** Stub the next Fireworks request with the given content + HTTP status. */
export function mockFireworksResponse(content: string | null, status = 200): void {
  server.use(
    http.post(FIREWORKS_URL, () => {
      if (status !== 200) return new HttpResponse("upstream error", { status });
      return HttpResponse.json({ choices: [{ message: { content } }] });
    }),
  );
}

/** Stub the next Fireworks request to fail at the transport layer. */
export function mockFireworksNetworkError(): void {
  server.use(http.post(FIREWORKS_URL, () => HttpResponse.error()));
}
