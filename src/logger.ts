import type { LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SECRET_KEY = /(authorization|api[-_]?key|access[-_]?token|secret|password|session|cookie|bearer)/i;

export type LogFields = Record<string, unknown>;

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
  ) {}

  child(fields: LogFields): Logger {
    const parent = this;
    return new Logger(this.level, (line) => {
      const parsed = JSON.parse(line) as LogFields;
      parent.sink(JSON.stringify({ ...parsed, ...(redact(fields) as LogFields) }));
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(redact(fields) as LogFields)
    };
    this.sink(JSON.stringify(record));
  }
}

/** Remove credential-shaped fields and shorten absurdly long strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      stack: value.stack ? redact(value.stack, depth + 1) : undefined
    };
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
    } else if (/url$/i.test(key) && typeof child === "string") {
      out[key] = redactUrl(child);
    } else {
      out[key] = redact(child, depth + 1);
    }
  }
  return out;
}

/** Remove query strings and fragments, which often carry signed credentials. */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return input.split("?")[0] ?? input;
  }
}
