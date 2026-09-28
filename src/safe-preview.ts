/** One line of printable text: no terminal escapes or control characters from a model-written argument. */
export function safePreview(value: unknown, limit = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "";
  const clean = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "\u00b7")
    .replace(/\n/g, "⏎ ");
  return clean.length > limit ? `${clean.slice(0, limit)}… (${clean.length - limit} more chars)` : clean;
}
