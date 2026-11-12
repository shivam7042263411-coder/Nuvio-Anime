import { createHash } from "node:crypto";
import type { Config } from "../../config.js";
import type { Episode } from "../../episodes/types.js";
import type { Logger } from "../../logger.js";
import type { MetadataService } from "../../metadata/service.js";
import type { AnimeMetadata } from "../../metadata/types.js";
import { sanitizeHeaders } from "../normalize.js";
import type {
  ProviderResult,
  Source,
  SourceContext,
  SourceLabel,
  SourceProvider
} from "../types.js";
import {
  audioLabel,
  parseDownloadLinks,
  parsePlayButtons,
  type DownloadLink,
  type PlayButton,
  type SubtitleCandidate
} from "./parse.js";
import {
  resolveEpisodePlan,
  uniqueTitles,
  type MatchProfile,
  type PlanFailure
} from "./matching.js";
import {
  AnimePaheRequestError,
  AnimePaheScraper,
  type AnimePaheHttp
} from "./scraper.js";
import type { EmbeddedSubtitle, ProviderSubtitleResult, SubtitleTrack } from "../../subtitles/types.js";

interface Resolution {
  sources: Source[];
  tracks: SubtitleTrack[];
  embedded: EmbeddedSubtitle[];
  warnings: string[];
}

interface DiscoveredSubtitle extends SubtitleCandidate {
  headers: Record<string, string>;
}

interface SourceJob {
  source: Source;
  subtitles: DiscoveredSubtitle[];
}

export interface AnimePaheProviderOptions {
  http: AnimePaheHttp;
  metadata: Pick<MetadataService, "getTmdbSeasons">;
  config: Config;
  logger: Logger;
}

/**
 * Optional provider that resolves AnimePahe's public play page and its
 * Sub/Dub/DL links. It never bypasses a challenge, login, CAPTCHA or rate
 * limit. The provider is disabled unless the operator explicitly enables it.
 */
export class AnimePaheProvider implements SourceProvider {
  readonly id = "animepahe";
  readonly name = "AnimePahe";

  private readonly scraper: AnimePaheScraper;
  private readonly resolutions = new Map<
    string,
    { expiresAt: number; promise: Promise<Resolution> }
  >();

  constructor(private readonly options: AnimePaheProviderOptions) {
    this.scraper = new AnimePaheScraper({
      http: options.http,
      logger: options.logger,
      baseUrl: options.config.sources.animepahe.baseUrl,
      userAgent: options.config.sources.animepahe.userAgent,
      maxSearchPages: options.config.sources.animepahe.maxSearchPages,
      maxDownloadOptions: options.config.sources.animepahe.maxDownloadOptions
    });
  }

  isConfigured(): boolean {
    return this.options.config.sources.animepahe.enabled;
  }

  async getSources(context: SourceContext): Promise<ProviderResult> {
    const resolution = await this.resolve(context);
    return { sources: resolution.sources, warnings: resolution.warnings };
  }

  async getSubtitles(context: SourceContext): Promise<ProviderSubtitleResult> {
    const resolution = await this.resolve(context);
    return {
      tracks: resolution.tracks,
      embedded: resolution.embedded,
      warnings: resolution.warnings
    };
  }

  private resolve(context: SourceContext): Promise<Resolution> {
    if (!this.isConfigured()) {
      return Promise.resolve(emptyResolution("AnimePahe provider is disabled."));
    }

    const key = context.episode.id;
    const cached = this.resolutions.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = this.resolveUncached(context);
    this.resolutions.set(key, {
      expiresAt: Date.now() + Math.max(5, this.options.config.cache.sourcesTtl) * 1000,
      promise
    });
    void promise.catch(() => {
      if (this.resolutions.get(key)?.promise === promise) this.resolutions.delete(key);
    });
    this.pruneResolutions();
    return promise;
  }

  private async resolveUncached(context: SourceContext): Promise<Resolution> {
    const warnings: string[] = [];

    try {
      const isMovie = isMovieEpisode(context.anime, context.episode);
      const seasons = isMovie
        ? []
        : await this.loadSeasons(context.anime, warnings);
      const profile = buildProfile(context.anime, seasons);

      const outcome = await resolveEpisodePlan(
        profile,
        isMovie,
        isMovie ? 1 : context.episode.seasonNumber,
        isMovie ? 1 : context.episode.episodeNumber,
        (query) => this.scraper.search(query)
      );

      if (!outcome.plan) {
        warnings.push(planWarning(outcome.failure));
        return emptyResolution(warnings);
      }

      const plan = outcome.plan;
      const release = await this.scraper.findEpisode(
        plan.entry.session,
        plan.episode,
        plan.isMovie
      );

      if (!release) {
        warnings.push(
          plan.isMovie
            ? "AnimePahe has no release for this movie; it may not be uploaded yet."
            : "AnimePahe has no release for this episode yet."
        );
        return emptyResolution(warnings);
      }

      const playPage = await this.scraper.playPage(plan.entry.session, release.session);
      const buttons = parsePlayButtons(playPage.html);
      const downloads = parseDownloadLinks(
        playPage.html,
        this.options.config.sources.animepahe.maxDownloadOptions
      );

      if (buttons.length === 0 && downloads.length === 0) {
        warnings.push(
          "AnimePahe returned no Sub/Dub or DL source for this episode. It may be removed, region-blocked or still being processed."
        );
        return emptyResolution(warnings);
      }

      const deadline = Date.now() + this.options.config.sources.animepahe.deadlineMs;
      const jobs: Array<Promise<SourceJob | null>> = [];
      const seen = new Set<string>();

      for (const button of buttons) {
        if (seen.has(button.url)) continue;
        seen.add(button.url);
        jobs.push(this.resolveButton(button, deadline));
      }

      for (const download of downloads) {
        if (seen.has(download.url)) continue;
        seen.add(download.url);
        jobs.push(this.resolveDownload(download, deadline));
      }

      const results = await Promise.allSettled(jobs);
      const sources: Source[] = [];
      const subtitleTracks: SubtitleTrack[] = [];
      const subtitleUrls = new Set<string>();
      let failed = 0;

      for (const result of results) {
        if (result.status === "rejected" || !result.value) {
          failed += 1;
          continue;
        }

        sources.push(result.value.source);
        for (const subtitle of result.value.subtitles) {
          if (subtitleUrls.has(subtitle.url)) continue;
          subtitleUrls.add(subtitle.url);
          subtitleTracks.push({
            id: `animepahe:${hashId(subtitle.url)}`,
            language: subtitle.language || "und",
            label: subtitle.label || subtitle.language || "Subtitles",
            format: subtitle.format,
            url: subtitle.url,
            headers: sanitizeHeaders(subtitle.headers),
            isDefault: false,
            source: this.id,
            selectable: true
          });
        }
      }

      if (sources.length === 0) {
        warnings.push("AnimePahe could not resolve any of its source links for this episode.");
      } else if (failed > 0) {
        warnings.push("Some AnimePahe source links were unavailable.");
      }

      // Hardcoded subtitles are not exposed by AnimePahe, so embedded is empty.
      return {
        sources,
        tracks: subtitleTracks,
        embedded: [],
        warnings
      };
    } catch (error) {
      this.logFailure(error);
      warnings.push(requestWarning(error));
      return emptyResolution(warnings);
    }
  }

  private async resolveButton(
    button: PlayButton,
    deadline: number
  ): Promise<SourceJob | null> {
    const playback = await this.scraper.resolveKwik(button.url);
    if (!playback) return null;

    let candidates = playback.subtitles;
    if (Date.now() < deadline) {
      candidates = mergeCandidates(
        candidates,
        await this.scraper.probeHlsSubtitles(playback.url, playback.headers)
      );
    }

    return {
      source: this.toSource({
        url: playback.url,
        type: playback.type,
        headers: playback.headers,
        label: audioLabel(button.audio),
        quality: button.quality || null,
        name: joinName([button.fansub, button.av1 ? "AV1" : ""]),
        size: null
      }),
      subtitles: candidates.map((candidate) => ({
        ...candidate,
        headers: playback.headers
      }))
    };
  }

  private async resolveDownload(
    download: DownloadLink,
    deadline: number
  ): Promise<SourceJob | null> {
    const playback = await this.scraper.resolveDownload(download.url);
    if (!playback) return null;

    let candidates = playback.subtitles;
    if (playback.type === "hls" && Date.now() < deadline) {
      candidates = mergeCandidates(
        candidates,
        await this.scraper.probeHlsSubtitles(playback.url, playback.headers)
      );
    }

    return {
      source: this.toSource({
        url: playback.url,
        type: playback.type,
        headers: playback.headers,
        label: "DL",
        language: download.audio === "eng" ? "en" : "ja",
        quality: download.quality || null,
        name: joinName([download.source, download.size ? `(${download.size})` : ""]),
        size: download.size || null
      }),
      subtitles: candidates.map((candidate) => ({
        ...candidate,
        headers: playback.headers
      }))
    };
  }

  private toSource(input: {
    url: string;
    type: "hls" | "mp4";
    headers: Record<string, string>;
    label: SourceLabel;
    language?: string;
    quality: string | null;
    name: string | null;
    size: string | null;
  }): Source {
    return {
      id: `animepahe:${hashId(`${input.url}|${input.label}|${input.quality ?? ""}`)}`,
      provider: this.id,
      providerName: this.name,
      label: input.label,
      language: input.language ?? (input.label === "Dub" ? "en" : "ja"),
      quality: input.quality,
      type: input.type,
      delivery: "stream",
      url: input.url,
      headers: sanitizeHeaders(input.headers),
      expiresAt: null,
      temporary: true,
      name: input.name ?? undefined,
      size: input.size
    };
  }

  private async loadSeasons(
    anime: AnimeMetadata,
    warnings: string[]
  ): Promise<MatchProfile["seasons"]> {
    try {
      const seasons = await this.options.metadata.getTmdbSeasons(anime);
      return seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount: season.episodeCount
      }));
    } catch (error) {
      this.options.logger.warn("animepahe season metadata failed", {
        provider: this.id,
        error
      });
      warnings.push("AnimePahe season metadata was unavailable; title matching was used on its own.");
      return [];
    }
  }

  private logFailure(error: unknown): void {
    this.options.logger.warn("animepahe provider failed", {
      provider: this.id,
      kind: error instanceof AnimePaheRequestError ? error.kind : "unexpected",
      status: error instanceof AnimePaheRequestError ? error.status : null
    });
  }

  private pruneResolutions(): void {
    if (this.resolutions.size <= 200) return;
    const now = Date.now();
    for (const [key, value] of this.resolutions) {
      if (value.expiresAt <= now) this.resolutions.delete(key);
      if (this.resolutions.size <= 150) break;
    }
  }
}

function emptyResolution(warning?: string | string[]): Resolution {
  const warnings = Array.isArray(warning) ? warning : warning ? [warning] : [];
  return {
    sources: [],
    tracks: [],
    embedded: [],
    warnings
  };
}

function buildProfile(
  anime: AnimeMetadata,
  seasons: MatchProfile["seasons"]
): MatchProfile {
  return {
    titles: uniqueTitles([
      anime.titles.preferred,
      anime.titles.romaji ?? "",
      anime.titles.english ?? "",
      anime.titles.native ?? "",
      ...anime.synonyms
    ]),
    year: anime.season.year ?? anime.startDate?.year ?? null,
    kind: anime.format === "MOVIE" || anime.tmdbMediaType === "movie" ? "movie" : "tv",
    seasons
  };
}

function isMovieEpisode(anime: AnimeMetadata, episode: Episode): boolean {
  return (
    episode.kind === "movie" ||
    anime.format === "MOVIE" ||
    anime.tmdbMediaType === "movie"
  );
}

function planWarning(failure: PlanFailure | null): string {
  switch (failure) {
    case "no_search_results":
      return "AnimePahe returned no search results for this anime.";
    case "movie_mismatch":
      return "AnimePahe's best match was not a movie; it was not used.";
    case "no_specials":
      return "AnimePahe lists no matching specials; season 1 was not substituted.";
    case "no_episode":
      return "AnimePahe has no matching episode, or the episode has not been released.";
    case "no_match":
    default:
      return "AnimePahe has no matching entry for this anime.";
  }
}

function requestWarning(error: unknown): string {
  if (!(error instanceof AnimePaheRequestError)) {
    return "AnimePahe returned an unexpected response; no sources were used.";
  }

  if (error.kind === "blocked") {
    return "AnimePahe is showing a Cloudflare challenge from this network; the provider did not bypass it.";
  }
  if (error.kind === "network") {
    return "AnimePahe could not be reached; the provider timed out or the network failed.";
  }
  if (error.kind === "http") {
    return `AnimePahe returned HTTP ${error.status ?? "error"} while resolving this episode.`;
  }
  return "AnimePahe returned an unexpected response; no sources were used.";
}

function mergeCandidates(
  first: SubtitleCandidate[],
  second: SubtitleCandidate[]
): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = [];
  const seen = new Set<string>();
  for (const item of [...first, ...second]) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function joinName(parts: Array<string | null | undefined>): string | null {
  const value = parts
    .map((part) => (part ? String(part).trim() : ""))
    .filter(Boolean)
    .join(" \u00b7 ");
  return value || null;
}

function hashId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 20);
}
