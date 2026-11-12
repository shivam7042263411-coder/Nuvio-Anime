import type { Source } from "./types.js";

export function sanitizeHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (key.length > 100 || value.length > 2000) continue;
    out[key] = value;
  }
  return out;
}

function headerKey(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map((key) => `${key.toLowerCase()}=${headers[key]}`)
    .join("&");
}

/**
 * Equivalent means the same playable URL, label, quality and playback headers.
 * The provider name is deliberately not part of the identity so the same stream
 * surfaced by two providers is not repeated.
 */
function equivalenceKey(source: Source): string {
  return [
    source.label,
    source.quality ?? "",
    source.url,
    headerKey(source.headers)
  ].join("|");
}

export function dedupeAndSortSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = equivalenceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const labelRank: Record<string, number> = { Sub: 0, Dub: 1, DL: 2 };
  return unique.sort((a, b) => {
    const label = (labelRank[a.label] ?? 9) - (labelRank[b.label] ?? 9);
    if (label !== 0) return label;
    const quality = (parseInt(b.quality ?? "", 10) || 0) - (parseInt(a.quality ?? "", 10) || 0);
    if (quality !== 0) return quality;
    return a.provider.localeCompare(b.provider);
  });
}
