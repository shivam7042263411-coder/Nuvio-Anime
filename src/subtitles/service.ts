import type { Pool } from "pg";
import { withTimeout } from "../async.js";
import type { CacheService } from "../cache/service.js";
import type { Config } from "../config.js";
import type { EpisodesService } from "../episodes/service.js";
import type { Logger } from "../logger.js";
import type { AnimeMetadata } from "../metadata/types.js";
import { sanitizeHeaders } from "../sources/normalize.js";
import type { SourceProvider } from "../sources/types.js";
import type { SubtitleFormat } from "./parse.js";
import type { EmbeddedSubtitle, SubtitleTrack } from "./types.js";

export type { EmbeddedSubtitle, ProviderSubtitleResult, SubtitleTrack } from "./types.js";

export interface SubtitlesResult {
  episodeId: string;
  tracks: SubtitleTrack[];
  embedded: EmbeddedSubtitle[];
  warnings: string[];
}

interface SubtitleRow {
  id: string;
  provider_id: string;
  kind: "external" | "embedded";
  language: string;
  label: string;
  format: SubtitleFormat | null;
  url: string | null;
  headers: Record<string, string> | null;
  is_default: boolean;
}

export class SubtitlesService {
  constructor(
    private readonly options: {
      pool: Pool | null;
      cache: CacheService;
      episodeService: EpisodesService;
      config: Config;
      logger: Logger;
      providers?: SourceProvider[];
    }
  ) {}

  async getSubtitles(episodeId: string): Promise<SubtitlesResult & { cached: boolean; stale: boolean }> {
    const key = `subtitles:v1:${episodeId}`;
    const result = await this.options.cache.remember(
      key,
      this.options.config.cache.subtitlesTtl,
      () => this.loadSubtitles(episodeId),
      // Subtitle URLs can be signed and expiring.
      { memoryOnly: true }
    );

    return { ...result.value, cached: result.cached, stale: result.stale };
  }

  private async loadSubtitles(episodeId: string): Promise<SubtitlesResult> {
    const { episode, warnings } = await this.options.episodeService.getEpisode(episodeId);
    const tracks: SubtitleTrack[] = [];
    const embedded: EmbeddedSubtitle[] = [];

    if (this.options.pool) {
      const result = await this.options.pool.query<SubtitleRow>(
        `select id, provider_id, kind, language, label, format, url, headers, is_default
         from authorized_subtitles
         where anime_id = $1
           and season_number is not distinct from $2::integer
           and episode_number = $3::numeric
           and enabled = true
         order by is_default desc, language asc, label asc`,
        [episode.animeId, episode.seasonNumber, episode.episodeNumber]
      );

      for (const row of result.rows) {
        if (row.kind === "embedded") {
          // Hardcoded subtitles are reported separately and never as selectable tracks.
          embedded.push({
            language: row.language,
            label: row.label,
            source: row.provider_id,
            selectable: false
          });
          continue;
        }

        if (!row.url || !row.format) {
          this.options.logger.warn("ignoring external subtitle without url/format", {
            subtitleId: row.id
          });
          warnings.push(`Subtitle ${row.label} was skipped because it has no usable file.`);
          continue;
        }

        tracks.push({
          id: row.id,
          language: row.language,
          label: row.label,
          format: row.format,
          url: row.url,
          headers: sanitizeHeaders(row.headers),
          isDefault: row.is_default,
          source: row.provider_id,
          selectable: true
        });
      }
    }

    const providers = (this.options.providers ?? []).filter(
      (provider) => provider.isConfigured() && typeof provider.getSubtitles === "function"
    );

    if (providers.length > 0) {
      let anime: AnimeMetadata | null = null;
      try {
        anime = await this.options.episodeService.getAnimeForEpisode(episode.animeId);
      } catch (error) {
        this.options.logger.warn("subtitle provider context failed", { error });
        warnings.push("Provider subtitle discovery was unavailable.");
      }

      if (anime) {
        const context = { anime, episode };
        const results = await Promise.allSettled(
          providers.map((provider) =>
            withTimeout(
              provider.getSubtitles!(context),
              this.options.config.sources.providerTimeoutMs,
              provider.id
            )
          )
        );

        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]!;
          const provider = providers[index]!;

          if (result.status === "rejected") {
            this.options.logger.warn("subtitle provider failed", {
              provider: provider.id,
              episodeId,
              error: result.reason
            });
            warnings.push(`Subtitle provider ${provider.name} was unavailable.`);
            continue;
          }

          warnings.push(...result.value.warnings);
          const embeddedFacts = result.value.embedded;

          for (const track of result.value.tracks) {
            const normalized = normalizeProviderTrack(track, provider.id);
            if (!normalized) {
              warnings.push(`Subtitle provider ${provider.name} returned an unusable track.`);
              continue;
            }
            tracks.push(normalized);
          }

          for (const fact of embeddedFacts) {
            if (!fact || !fact.language || !fact.label) continue;
            embedded.push({
              language: String(fact.language),
              label: String(fact.label),
              source: provider.id,
              selectable: false
            });
          }
        }
      }
    }

    return {
      episodeId,
      tracks: dedupeTracks(tracks),
      embedded: dedupeEmbedded(embedded),
      warnings
    };
  }
}

function normalizeProviderTrack(track: SubtitleTrack, providerId: string): SubtitleTrack | null {
  if (!track || typeof track.url !== "string" || !/^https?:\/\//i.test(track.url)) return null;
  if (track.format !== "srt" && track.format !== "vtt") return null;
  const language = typeof track.language === "string" && track.language.trim() ? track.language.trim() : "und";
  const label = typeof track.label === "string" && track.label.trim() ? track.label.trim() : language;
  return {
    id: typeof track.id === "string" && track.id ? track.id : track.url,
    language,
    label,
    format: track.format,
    url: track.url,
    headers: sanitizeHeaders(track.headers),
    isDefault: false,
    source: providerId,
    selectable: true
  };
}

function dedupeTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = `${track.language}|${track.label}|${track.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEmbedded(embedded: EmbeddedSubtitle[]): EmbeddedSubtitle[] {
  const seen = new Set<string>();
  return embedded.filter((track) => {
    const key = `${track.language}|${track.label}|${track.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
