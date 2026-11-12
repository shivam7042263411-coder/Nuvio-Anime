import type { CacheService } from "../cache/service.js";
import type { Config } from "../config.js";
import { AppError, NotFoundError, isProviderError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { AniListProvider, StreamingEpisode } from "../metadata/anilist.js";
import type { MetadataService } from "../metadata/service.js";
import type { AnimeMetadata } from "../metadata/types.js";
import { effectiveTmdbMatch } from "../metadata/types.js";
import { buildEpisodeId, parseEpisodeId } from "./ids.js";
import type { Episode, EpisodeCatalogue, SeasonSummary } from "./types.js";

const MAX_ANILIST_EPISODES = 2000;

interface EpisodesServiceOptions {
  metadata: MetadataService;
  anilist: AniListProvider;
  cache: CacheService;
  config: Config;
  logger: Logger;
}

export interface EpisodePage {
  animeId: string;
  kind: "tv" | "movie";
  source: "tmdb" | "anilist";
  seasonNumber: number | null;
  seasons: SeasonSummary[];
  episodes: Episode[];
  complete: boolean;
  page: number;
  limit: number;
  total: number;
  warnings: string[];
}

export class EpisodesService {
  constructor(private readonly options: EpisodesServiceOptions) {}

  async list(
    animeId: string,
    options: { season?: number; page: number; limit: number }
  ): Promise<EpisodePage & { cached: boolean; stale: boolean }> {
    const catalogue = await this.getCatalogue(animeId, options.season);
    const total = catalogue.episodes.length;
    const start = (options.page - 1) * options.limit;
    const episodes = catalogue.episodes.slice(start, start + options.limit);

    return {
      animeId: catalogue.animeId,
      kind: catalogue.kind,
      source: catalogue.source,
      seasonNumber:
        catalogue.kind === "movie"
          ? null
          : options.season ??
            (catalogue.kind === "tv" ? catalogue.episodes[0]?.seasonNumber ?? null : null),
      seasons: catalogue.seasons,
      episodes,
      complete: catalogue.complete,
      page: options.page,
      limit: options.limit,
      total,
      warnings: catalogue.warnings,
      cached: catalogue.cached,
      stale: catalogue.stale
    };
  }

  async getEpisode(episodeId: string): Promise<{
    episode: Episode;
    cached: boolean;
    stale: boolean;
    warnings: string[];
  }> {
    const parsed = parseEpisodeId(episodeId);
    if (!parsed) {
      throw new NotFoundError("Episode was not found", "episode_not_found");
    }

    const animeId = `${parsed.prefix}:${parsed.animeNumber}`;
    const catalogue = await this.getCatalogue(
      animeId,
      parsed.seasonNumber ?? undefined
    );

    const episode = catalogue.episodes.find((item) => {
      if (item.episodeNumber !== parsed.episodeNumber) return false;
      if (parsed.seasonNumber === null) return true;
      return item.seasonNumber === parsed.seasonNumber;
    });

    if (!episode) {
      throw new NotFoundError(`Episode ${episodeId} was not found`, "episode_not_found");
    }

    return {
      episode,
      cached: catalogue.cached,
      stale: catalogue.stale,
      warnings: catalogue.warnings
    };
  }

  /** Metadata is normally already in cache from the episode lookup. */
  async getAnimeForEpisode(animeId: string): Promise<AnimeMetadata> {
    const result = await this.options.metadata.getAnime(animeId);
    return result.value;
  }

  async getCatalogue(
    animeId: string,
    requestedSeason?: number
  ): Promise<EpisodeCatalogue & { cached: boolean; stale: boolean }> {
    const cacheKey = `catalogue:v1:${animeId}:s${requestedSeason ?? "default"}`;
    const result = await this.options.cache.remember(
      cacheKey,
      this.options.config.cache.episodeTtl,
      () => this.buildCatalogue(animeId, requestedSeason),
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    return {
      ...result.value,
      warnings: result.stale
        ? unique([
            ...result.value.warnings,
            "Upstream provider failed; serving a stale episode catalogue."
          ])
        : result.value.warnings,
      cached: result.cached,
      stale: result.stale
    };
  }

  private async buildCatalogue(
    animeId: string,
    requestedSeason?: number
  ): Promise<EpisodeCatalogue> {
    const animeResult = await this.options.metadata.getAnime(animeId);
    const anime = animeResult.value;

    if (isMovie(anime)) {
      if (requestedSeason !== undefined && requestedSeason !== 0 && requestedSeason !== 1) {
        throw new AppError(
          400,
          "season_unavailable",
          `Anime ${anime.id} is a movie and has no season ${requestedSeason}`
        );
      }
      return this.movieCatalogue(anime, animeResult.warnings);
    }

    const tmdbMatch = effectiveTmdbMatch(anime);
    if (tmdbMatch && tmdbMatch.mediaType === "tv") {
      try {
        return await this.tmdbCatalogue(anime, tmdbMatch, requestedSeason, animeResult.warnings);
      } catch (error) {
        this.options.logger.warn("tmdb season catalogue failed", {
          animeId,
          requestedSeason,
          error
        });
        if (requestedSeason !== undefined || anime.anilistId === null) {
          throw error;
        }
        const fallback = await this.anilistCatalogue(anime);
        fallback.warnings = unique([
          ...fallback.warnings,
          ...animeResult.warnings,
          "TMDB season data was unavailable; using the AniList episode list."
        ]);
        return fallback;
      }
    }

    if (anime.anilistId !== null) {
      if (requestedSeason !== undefined && requestedSeason !== 1) {
        throw new AppError(
          400,
          "season_unavailable",
          `AniList does not provide a season ${requestedSeason} for ${anime.id}; request the episode catalogue without a season filter.`
        );
      }
      const catalogue = await this.anilistCatalogue(anime);
      catalogue.warnings = unique([...catalogue.warnings, ...animeResult.warnings]);
      return catalogue;
    }

    throw new AppError(
      404,
      "anime_not_found",
      `No episode catalogue is available for ${anime.id}`
    );
  }

  private movieCatalogue(anime: AnimeMetadata, warnings: string[]): EpisodeCatalogue {
    const episode: Episode = {
      id: buildEpisodeId(anime.id, null, 1),
      animeId: anime.id,
      seasonNumber: null,
      episodeNumber: 1,
      title: anime.titles.preferred,
      overview: anime.description,
      airDate: formatDate(anime.startDate),
      runtimeMinutes: anime.durationMinutes,
      image: anime.images.banner ?? anime.images.posterLarge ?? anime.images.poster,
      kind: "movie",
      available: true,
      metadataAvailable: Boolean(anime.titles.preferred),
      source: effectiveTmdbMatch(anime) ? "tmdb" : "anilist"
    };

    return {
      animeId: anime.id,
      kind: "movie",
      source: episode.source,
      seasons: [],
      episodes: [episode],
      complete: true,
      warnings
    };
  }

  private async tmdbCatalogue(
    anime: AnimeMetadata,
    match: { id: number; mediaType: "tv" | "movie" },
    requestedSeason: number | undefined,
    warnings: string[]
  ): Promise<EpisodeCatalogue> {
    const seasons = await this.options.metadata.getTmdbSeasons(anime);
    if (seasons.length === 0) {
      throw new AppError(502, "provider_error", "TMDB returned no seasons for this anime");
    }

    const seasonNumber =
      requestedSeason ?? seasons.find((season) => season.seasonNumber > 0)?.seasonNumber ?? seasons[0]!.seasonNumber;

    const season = seasons.find((item) => item.seasonNumber === seasonNumber);
    if (!season) {
      throw new AppError(
        400,
        "season_unavailable",
        `Season ${seasonNumber} is not available for ${anime.id}`,
        { details: { availableSeasons: seasons.map((item) => item.seasonNumber) } }
      );
    }

    const key = `tmdb:episodes:${match.mediaType}:${match.id}:${seasonNumber}`;
    const episodeResult = await this.options.cache.remember(
      key,
      this.options.config.cache.episodeTtl,
      () => this.options.metadata.tmdb.getSeasonEpisodes(match.id, seasonNumber),
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    const episodes = episodeResult.value.map((episode) => ({
      id: buildEpisodeId(anime.id, episode.seasonNumber, episode.episodeNumber),
      animeId: anime.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      overview: episode.overview,
      airDate: episode.airDate,
      runtimeMinutes: episode.runtimeMinutes ?? anime.durationMinutes,
      image: episode.image ?? anime.images.banner,
      kind: episode.seasonNumber === 0 ? ("special" as const) : ("tv" as const),
      available: true,
      metadataAvailable: Boolean(episode.title || episode.overview || episode.image),
      source: "tmdb" as const
    }));

    return {
      animeId: anime.id,
      kind: "tv",
      source: "tmdb",
      seasons,
      episodes,
      complete: episodes.length >= season.episodeCount,
      warnings: episodeResult.stale
        ? unique([...warnings, "TMDB season data was stale."])
        : warnings
    };
  }

  private async anilistCatalogue(anime: AnimeMetadata): Promise<EpisodeCatalogue> {
    if (anime.anilistId === null) {
      throw new AppError(404, "anime_not_found", `No AniList catalogue for ${anime.id}`);
    }

    const key = `anilist:streaming:${anime.anilistId}`;
    const streamingResult = await this.options.cache.remember(
      key,
      this.options.config.cache.episodeTtl,
      () => this.options.anilist.getStreamingEpisodes(anime.anilistId!),
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    const streaming = streamingResult.value;
    const count = Math.min(
      Math.max(anime.episodeCount ?? 0, streaming.length),
      MAX_ANILIST_EPISODES
    );

    const episodes: Episode[] = [];
    for (let number = 1; number <= count; number += 1) {
      const source: StreamingEpisode | undefined = streaming[number - 1];
      episodes.push({
        id: buildEpisodeId(anime.id, null, number),
        animeId: anime.id,
        seasonNumber: null,
        episodeNumber: number,
        title: source?.title ?? null,
        overview: null,
        airDate: null,
        runtimeMinutes: anime.durationMinutes,
        image: source?.thumbnail ?? null,
        kind: "tv",
        available: true,
        metadataAvailable: Boolean(source?.title || source?.thumbnail),
        source: "anilist"
      });
    }

    return {
      animeId: anime.id,
      kind: "tv",
      source: "anilist",
      seasons: [],
      episodes,
      complete: anime.episodeCount !== null && streaming.length >= anime.episodeCount,
      warnings: streamingResult.stale
        ? ["AniList episode data was stale."]
        : []
    };
  }
}

function isMovie(anime: AnimeMetadata): boolean {
  return anime.format === "MOVIE" || anime.tmdbMediaType === "movie";
}

function formatDate(date: AnimeMetadata["startDate"]): string | null {
  if (!date?.year) return null;
  const month = date.month ? String(date.month).padStart(2, "0") : "01";
  const day = date.day ? String(date.day).padStart(2, "0") : "01";
  return `${date.year}-${month}-${day}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
