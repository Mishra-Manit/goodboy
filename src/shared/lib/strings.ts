/** First 8 chars of a UUID — used in Telegram messages and dashboard IDs. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
