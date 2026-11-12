import type { Source, SourceLabel, StreamType } from "./types.js";

/** Runtime shape accepted from a provider before validation. */
type SourceLike = Partial<Record<keyof Source, unknown>>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLabel(value: unknown): SourceLabel | null {
  const label = text(value).toLowerCase();
  if (label === "sub") return "Sub";
  if (label === "dub") return "Dub";
  if (label === "dl") return "DL";
  return null;
}

function normalizeStreamType(value: unknown): StreamType | null {
  const type = text(value).toLowerCase();
  if (type === "hls" || type === "m3u8") return "hls";
  if (type === "dash" || type === "mpd") return "dash";
  if (type === "mp4") return "mp4";
  return null;
}

function normalizeExpiry(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Enforce the shared `Source` contract at the provider boundary.
 *
 * Providers are independent modules, so a future one may return malformed or
 * unsupported data. Invalid entries are dropped (and counted) instead of being
 * forwarded to clients; valid entries are canonicalized so the API response
 * stays identical no matter which provider produced it.
 */
export function normalizeProviderSources(
  sources: readonly SourceLike[],
  fallbackProviderId: string
): { sources: Source[]; dropped: number } {
  const list = Array.isArray(sources) ? sources : [];
  const normalized: Source[] = [];
  let dropped = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      continue;
    }

    const url = text(raw.url);
    const label = normalizeLabel(raw.label);
    const type = normalizeStreamType(raw.type);
    const provider = text(raw.provider) || fallbackProviderId;
    const quality = text(raw.quality) || null;

    if (!/^https?:\/\//i.test(url) || raw.delivery !== "stream" || !label || !type) {
      dropped += 1;
      continue;
    }

    const source: Source = {
      id: text(raw.id) || `${provider}:${label}:${quality ?? "na"}:${url}`,
      provider,
      label,
      language: text(raw.language) || null,
      quality,
      type,
      delivery: "stream",
      url,
      headers: sanitizeHeaders(
        raw.headers && typeof raw.headers === "object"
          ? (raw.headers as Record<string, string>)
          : null
      ),
      expiresAt: normalizeExpiry(raw.expiresAt),
      // Anything that does not explicitly opt out is treated as temporary, so
      // signed or unknown URLs are never written to the shared cache.
      temporary: raw.temporary !== false
    };

    const providerName = text(raw.providerName);
    if (providerName) source.providerName = providerName;
    const name = text(raw.name);
    if (name) source.name = name;
    const size = text(raw.size);
    if (size) source.size = size;

    normalized.push(source);
  }

  return { sources: normalized, dropped };
}

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
