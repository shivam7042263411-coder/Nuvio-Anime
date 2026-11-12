import type { Pool } from "pg";
import type { Logger } from "../logger.js";
import { sanitizeHeaders } from "./normalize.js";
import type { ProviderResult, Source, SourceContext, SourceLabel, SourceProvider, StreamType } from "./types.js";

interface SourceRow {
  id: string;
  provider_id: string;
  label: "sub" | "dub" | "dl";
  language: string | null;
  quality: string | null;
  stream_type: StreamType;
  url: string;
  headers: Record<string, string> | null;
  expires_at: string | Date | null;
}

/**
 * Reads only rows an operator deliberately added to authorized_sources.
 * No scraping, no Cloudflare bypass, no CAPTCHA solving, no login handling.
 */
export class CatalogSourceProvider implements SourceProvider {
  readonly id = "catalog";
  readonly name = "Authorized source catalogue";

  constructor(
    private readonly pool: Pool | null,
    private readonly enabled: boolean,
    private readonly logger: Logger
  ) {}

  isConfigured(): boolean {
    return this.enabled && this.pool !== null;
  }

  async getSources(context: SourceContext): Promise<ProviderResult> {
    if (!this.pool) return { sources: [], warnings: [] };

    const result = await this.pool.query<SourceRow>(
      `select id, provider_id, label, language, quality, stream_type, url, headers, expires_at
       from authorized_sources
       where provider_id = $1
         and anime_id = $2
         and season_number is not distinct from $3::integer
         and episode_number = $4::numeric
         and enabled = true
         and (expires_at is null or expires_at > now() + interval '15 seconds')`,
      [this.id, context.anime.id, context.episode.seasonNumber, context.episode.episodeNumber]
    );

    const sources: Source[] = [];
    for (const row of result.rows) {
      if (!/^https?:\/\//i.test(row.url)) {
        this.logger.warn("ignoring authorized source with a non-http url", {
          sourceId: row.id,
          provider: row.provider_id
        });
        continue;
      }

      sources.push({
        id: row.id,
        provider: row.provider_id,
        providerName: this.name,
        label: normalizeLabel(row.label),
        language: row.language,
        quality: row.quality,
        type: row.stream_type,
        delivery: "stream",
        url: row.url,
        headers: sanitizeHeaders(row.headers),
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        temporary: true
      });
    }

    return { sources, warnings: [] };
  }
}

function normalizeLabel(label: "sub" | "dub" | "dl"): SourceLabel {
  if (label === "dub") return "Dub";
  if (label === "dl") return "DL";
  return "Sub";
}
