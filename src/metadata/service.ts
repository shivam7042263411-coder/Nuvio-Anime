import { createHash } from "node:crypto";
import type { CacheService } from "../cache/service.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { AniListProvider } from "./anilist.js";
import { pickBestMatch, type MatchCandidate } from "./matching.js";
import type { MatchRepository } from "./repository.js";
import { TmdbProvider } from "./tmdb.js";
import type {
  AnimeMetadata,
  SearchPage,
  TmdbMediaType,
  TmdbSearchCandidate
} from "./types.js";
import { effectiveTmdbMatch } from "./types.js";

export interface FetchResult<T> {
  value: T;
  cached: boolean;
  stale: boolean;
  warnings: string[];
}

interface MetadataServiceOptions {
  anilist: AniListProvider;
  tmdb: TmdbProvider;
  cache: CacheService;
  matchRepository: MatchRepository | null;
  config: Config;
  logger: Logger;
}

export class MetadataService {
  constructor(private readonly options: MetadataServiceOptions) {}

  get tmdb(): TmdbProvider {
    return this.options.tmdb;
  }

  async search(
    query: string,
    page: number,
    perPage: number
  ): Promise<FetchResult<SearchPage>> {
    const key = `search:v1:${createHash("sha1").update(query.trim().toLowerCase()).digest("hex")}:p${page}:l${perPage}`;
    const result = await this.options.cache.remember(
      key,
      this.options.config.cache.searchTtl,
      () => this.options.anilist.search(query, page, perPage),
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    return { ...result, warnings: [] };
  }

  async getAnime(rawId: string): Promise<FetchResult<AnimeMetadata>> {
    const key = `anime:v2:${rawId}`;
    const warnings: string[] = [];

    const result = await this.options.cache.remember(
      key,
      this.options.config.cache.animeTtl,
      async () => {
        const warningsFromLoad: string[] = [];
        let anime: AnimeMetadata;

        if (rawId.startsWith("tmdb:")) {
          anime = await this.loadFromTmdb(Number(rawId.slice(5)), warningsFromLoad);
        } else {
          anime = await this.loadFromAniList(Number(rawId.slice(8)), warningsFromLoad);
        }

        warnings.push(...warningsFromLoad);
        return anime;
      },
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    if (result.cached) warnings.length = 0;
    if (result.stale) warnings.push("Upstream provider failed; serving a stale cached copy.");
    return { ...result, warnings: unique(warnings) };
  }

  /** TMDB seasons are authoritative when a match exists. */
  async getTmdbSeasons(anime: AnimeMetadata): Promise<
    Awaited<ReturnType<TmdbProvider["getSeasons"]>>
  > {
    const match = effectiveTmdbMatch(anime);
    if (!match) return [];
    const key = `tmdb:seasons:${match.mediaType}:${match.id}`;
    const result = await this.options.cache.remember(
      key,
      this.options.config.cache.episodeTtl,
      () => this.options.tmdb.getSeasons(match.id, match.mediaType),
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );
    return result.value;
  }

  private async loadFromAniList(
    id: number,
    warnings: string[]
  ): Promise<AnimeMetadata> {
    const anime = await this.options.anilist.getById(id);
    if (!this.options.tmdb.isConfigured) return anime;

    try {
      const match = await this.getOrCreateMatch(anime);
      if (!match) return anime;

      const tmdb = await this.options.tmdb.getDetails(match.tmdbId, match.mediaType);
      return mergeMetadata(anime, tmdb, match);
    } catch (error) {
      this.options.logger.warn("tmdb enrichment failed", { anilistId: id, error });
      warnings.push("TMDB enrichment was unavailable; showing AniList metadata only.");
      return anime;
    }
  }

  private async loadFromTmdb(id: number, warnings: string[]): Promise<AnimeMetadata> {
    const tmdb = await this.options.tmdb.getDetailsAny(id);
    if (!tmdb.titles.preferred) {
      return { ...tmdb, requestedId: `tmdb:${id}` };
    }

    try {
      const query = buildMatchQuery(tmdb);
      const page = await this.options.anilist.search(tmdb.titles.preferred, 1, 10);
      const candidates = page.results
        .filter((result) => result.anilistId !== null)
        .map((result) => ({
          id: result.anilistId!,
          mediaType: (result.format === "MOVIE" ? "movie" : "tv") as TmdbMediaType,
          titles: unique([
            result.titles.preferred,
            result.titles.romaji ?? "",
            result.titles.english ?? "",
            result.titles.native ?? "",
            ...result.synonyms
          ]),
          year: result.season.year ?? result.startDate?.year ?? null,
          popularity: result.popularity ?? 0
        }));

      const best = pickBestMatch(query, candidates);
      if (!best) return { ...tmdb, requestedId: `tmdb:${id}` };

      const anilist = await this.options.anilist.getById(best.candidate.id);
      const match = {
        tmdbId: tmdb.tmdbId!,
        mediaType: best.candidate.mediaType,
        confidence: best.score,
        matchedTitle: best.candidate.titles[0] ?? null,
        matchedYear: best.candidate.year
      };
      await this.options.matchRepository
        ?.save({ anilistId: best.candidate.id, ...match })
        .catch((error) => {
          this.options.logger.warn("reverse match save failed", { error });
        });
      return {
        ...mergeMetadata(anilist, tmdb, match),
        requestedId: `tmdb:${id}`
      };
    } catch (error) {
      this.options.logger.warn("anilist match for tmdb id failed", { tmdbId: id, error });
      warnings.push("AniList matching was unavailable; showing TMDB metadata only.");
      return { ...tmdb, requestedId: `tmdb:${id}` };
    }
  }

  private async getOrCreateMatch(anime: AnimeMetadata) {
    if (anime.anilistId === null) return null;

    const stored = await this.options.matchRepository
      ?.get(anime.anilistId)
      .catch((error) => {
        this.options.logger.warn("match lookup failed", { error });
        return null;
      });
    if (stored) {
      return {
        tmdbId: stored.tmdbId,
        mediaType: stored.mediaType,
        confidence: stored.confidence,
        matchedTitle: stored.matchedTitle,
        matchedYear: stored.matchedYear
      };
    }

    const cacheKey = `match:v1:${anime.anilistId}`;
    const result = await this.options.cache.remember(
      cacheKey,
      this.options.config.cache.matchTtl,
      async () => {
        const query = buildMatchQuery(anime);
        const candidates = await this.options.tmdb.searchCandidates(
          anime.titles.preferred,
          anime.format === "MOVIE" ? "movie" : "tv"
        );
        const best = pickBestMatch(query, candidates.map(toMatchCandidate));
        if (!best) return null;

        const match = {
          tmdbId: best.candidate.id,
          mediaType: best.candidate.mediaType,
          confidence: best.score,
          matchedTitle: best.candidate.titles[0] ?? null,
          matchedYear: best.candidate.year
        };
        await this.options.matchRepository?.save({
          anilistId: anime.anilistId!,
          ...match
        }).catch((error) => {
          this.options.logger.warn("match save failed", { error });
        });
        return match;
      },
      { staleTtlSeconds: this.options.config.cache.staleTtl }
    );

    if (!result.value) return null;
    return {
      tmdbId: result.value.tmdbId,
      mediaType: result.value.mediaType,
      confidence: result.value.confidence,
      matchedTitle: result.value.matchedTitle,
      matchedYear: result.value.matchedYear
    };
  }
}

function buildMatchQuery(anime: AnimeMetadata) {  return {
    titles: unique([
      anime.titles.preferred,
      anime.titles.romaji ?? "",
      anime.titles.english ?? "",
      anime.titles.native ?? "",
      ...anime.synonyms
    ]),
    year: anime.season.year ?? anime.startDate?.year ?? null,
    format: (anime.format === "MOVIE" ? "movie" : "tv") as TmdbMediaType
  };
}

function toMatchCandidate(candidate: TmdbSearchCandidate): MatchCandidate {
  return {
    id: candidate.id,
    mediaType: candidate.mediaType,
    titles: candidate.titles,
    year: candidate.year,
    popularity: candidate.popularity
  };
}

function mergeMetadata(
  anilist: AnimeMetadata,
  tmdb: AnimeMetadata,
  match: { tmdbId: number; mediaType: TmdbMediaType; confidence: number; matchedTitle: string | null; matchedYear: number | null }
): AnimeMetadata {
  return {
    ...anilist,
    tmdbId: tmdb.tmdbId,
    tmdbMediaType: match.mediaType,
    description: anilist.description ?? tmdb.description,
    episodeCount: anilist.episodeCount ?? tmdb.episodeCount,
    durationMinutes: anilist.durationMinutes ?? tmdb.durationMinutes,
    genres: unique([...anilist.genres, ...tmdb.genres]),
    images: {
      poster: tmdb.images.poster ?? anilist.images.poster,
      posterLarge: tmdb.images.posterLarge ?? anilist.images.posterLarge,
      banner: tmdb.images.banner ?? anilist.images.banner,
      color: anilist.images.color
    },
    studios: anilist.studios.length ? anilist.studios : tmdb.studios,
    externalLinks: dedupeLinks([...anilist.externalLinks, ...tmdb.externalLinks]),
    tmdbMatch: {
      id: match.tmdbId,
      mediaType: match.mediaType,
      confidence: match.confidence,
      matchedTitle: match.matchedTitle,
      matchedYear: match.matchedYear
    }
  };
}

function dedupeLinks(
  links: Array<{ site: string; url: string; type: string | null }>
): Array<{ site: string; url: string; type: string | null }> {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
