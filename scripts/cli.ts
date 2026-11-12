export function parseFlags(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    if (!rawKey) continue;
    const key = rawKey.trim();
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = "true";
      }
    }
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  }
  return flags;
}

export function required(flags: Map<string, string[]>, name: string): string {
  const value = flags.get(name)?.[0]?.trim();
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

export function optional(flags: Map<string, string[]>, name: string): string | undefined {
  const value = flags.get(name)?.[0]?.trim();
  return value || undefined;
}

export function optionalNumber(
  flags: Map<string, string[]>,
  name: string
): number | undefined {
  const raw = optional(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

export function has(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

export function headers(flags: Map<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of flags.get("header") ?? []) {
    const index = header.indexOf("=");
    if (index <= 0) throw new Error(`--header must look like "Referer=https://example.com/"`);
    out[header.slice(0, index).trim()] = header.slice(index + 1).trim();
  }
  return out;
}
