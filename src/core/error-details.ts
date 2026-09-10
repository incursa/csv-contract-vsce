/** Retain driver diagnostics, including plain ODBC objects and nested SQL errors. */
export function errorDetails(error: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map(visit);
    const entries = Object.getOwnPropertyNames(value).filter((key) => key !== "stack");
    return Object.fromEntries(entries.map((key) => [key,
      /password|pwd|token|secret|connectionString/i.test(key) ? "[redacted]" : visit((value as Record<string, unknown>)[key])
    ]));
  };
  let text: string;
  if (error instanceof Error) {
    const fields = visit(error) as Record<string, unknown>;
    delete fields.message;
    text = error.message + (Object.keys(fields).length ? `\n${JSON.stringify(fields, null, 2)}` : "");
  } else text = typeof error === "string" ? error : JSON.stringify(visit(error), null, 2) ?? String(error);
  return text.replace(/((?:Password|Pwd|AccessToken)\s*=\s*)(?:\{[^}]*\}|[^;\r\n]*)/gi, "$1[redacted]");
}
