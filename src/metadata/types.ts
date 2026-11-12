export type AnimeSource = "anilist" | "tmdb";
export type TmdbMediaType = "tv" | "movie";

export interface AnimeTitleSet {
  romaji: string | null;
  english: string | null;
  native: string | null;
  preferred: string;
}

export interface DateParts {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface AnimeImages {
  poster: string | null;
  posterLarge: string | null;
  banner: string | null;
  color: string | null;
}

export interface TmdbMatch {
  id: number;
  mediaType: TmdbMediaType;
  confidence: number;
  matchedTitle: string | null;
  matchedYear: number | null;
}

export interface TmdbMatchRef {
  id: number;
  mediaType: TmdbMediaType;
}

/** A TMDB-only anime has tmdbId/tmdbMediaType but no confidence-bearing match. */
export function effectiveTmdbMatch(anime: AnimeMetadata): TmdbMatchRef | null {
  if (anime.tmdbMatch) {
    return { id: anime.tmdbMatch.id, mediaType: anime.tmdbMatch.mediaType };
  }
  if (anime.tmdbId !== null && anime.tmdbMediaType !== null) {
    return { id: anime.tmdbId, mediaType: anime.tmdbMediaType };
  }
  return null;
}

export interface AnimeMetadata {
  /** Canonical ID used by every endpoint: anilist:<n> or tmdb:<n>. */
  id: string;
  source: AnimeSource;
  anilistId: number | null;
  malId: number | null;
  tmdbId: number | null;
  tmdbMediaType: TmdbMediaType | null;
  titles: AnimeTitleSet;
  synonyms: string[];
  description: string | null;
  format: string | null;
  status: string | null;
  episodeCount: number | null;
  durationMinutes: number | null;
  /** AniList broadcast season (WINTER/SPRING/SUMMER/FALL), not a season number. */
  season: {
    name: string | null;
    year: number | null;
  };
  startDate: DateParts | null;
  endDate: DateParts | null;
  genres: string[];
  averageScore: number | null;
  popularity: number | null;
  isAdult: boolean;
  images: AnimeImages;
  studios: string[];
  externalLinks: Array<{ site: string; url: string; type: string | null }>;
  trailer: { id: string; site: string; url: string } | null;
  tmdbMatch: TmdbMatch | null;
  /** Present when the caller used an ID that resolved to a different canonical ID. */
  requestedId?: string;
}

export interface SearchPage {
  results: AnimeMetadata[];
  page: number;
  perPage: number;
  total: number;
  lastPage: number;
  hasNextPage: boolean;
}

export interface TmdbSearchCandidate {
  id: number;
  mediaType: TmdbMediaType;
  titles: string[];
  year: number | null;
  popularity: number;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  voteAverage: number | null;
  adult: boolean;
}
