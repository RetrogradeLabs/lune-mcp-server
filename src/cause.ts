/**
 * `throw` accepts any value, so `(cause as Error).message` on a thrown string or
 * plain object reads back the literal "undefined" and the log line loses the only
 * thing it was written to record.
 */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
