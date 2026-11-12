import { NotFoundError, ProviderError } from "../errors.js";
import type { HttpClient } from "../http/client.js";
import type { AnimeMetadata, TmdbMediaType, TmdbSearchCandidate } from "./types.js";

interface TmdbSearchItem {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  first_air_date?: string;
  release_date?: string;
  popularity?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string | null;
  vote_average?: number | null;
  adult?: boolean;
  media_type?: string;
}

interface TmdbDetails {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  release_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  status?: string;
  genres?: Array<{ id: number; name: string }>;
  production_companies?: Array<{ id: number; name: string }>;
  seasons?: Array<{
    season_number: number;
    name: string;
    overview?: string | null;
    poster_path?: string | null;
    air_date?: string | null;
    episode_count: number;
  }>;
  external_ids?: {
    imdb_id?: string | null;
    tvdb_id?: number | null;
    tvrage_id?: number | null;
    facebook_id?: string | null;
    instagram_id?: string | null;
    twitter_id?: string | null;
  };
}

export interface TmdbSeasonSummary {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  airDate: string | null;
  overview: string | null;
  poster: string | null;
}

export interface TmdbEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
  image: string | null;
}

export class TmdbProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly options: {
      enabled: boolean;
      apiKey: string | null;
      accessToken: string | null;
      baseUrl: string;
      imageBaseUrl: string;
    }
  ) {}

  get isConfigured(): boolean {
    return this.options.enabled;
  }

  async searchCandidates(
    query: string,
    preferredType?: TmdbMediaType
  ): Promise<TmdbSearchCandidate[]> {
    this.assertConfigured();
    const types: TmdbMediaType[] = preferredType ? [preferredType] : ["tv", "movie"];

    const pages = await Promise.all(
      types.map((type) => this.searchType(query, type))
    );
    return pages.flat();
  }

  async getDetails(id: number, mediaType: TmdbMediaType): Promise<AnimeMetadata> {
    this.assertConfigured();
    const details = await this.fetchDetails(id, mediaType);
    return mapDetails(details, mediaType, this.options.imageBaseUrl);
  }

  async getDetailsAny(id: number): Promise<AnimeMetadata> {
    this.assertConfigured();
    try {
      return await this.getDetails(id, "tv");
    } catch (error) {
      if (error instanceof ProviderError && error.upstreamStatus === 404) {
        try {
          return await this.getDetails(id, "movie");
        } catch (movieError) {
          if (movieError instanceof ProviderError && movieError.upstreamStatus === 404) {
            throw new NotFoundError(`TMDB id ${id} was not found`, "anime_not_found");
          }
          throw movieError;
        }
      }
      throw error;
    }
  }

  async getSeasons(id: number, mediaType: TmdbMediaType): Promise<TmdbSeasonSummary[]> {
    this.assertConfigured();
    const details = await this.fetchDetails(id, mediaType);
    return (details.seasons ?? [])
      .map((season) => ({
        seasonNumber: season.season_number,
        name: season.name ?? null,
        episodeCount: season.episode_count,
        airDate: season.air_date ?? null,
        overview: season.overview ?? null,
        poster: season.poster_path
          ? `${this.options.imageBaseUrl}/w500${season.poster_path}`
          : null
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  }

  async getSeasonEpisodes(
    id: number,
    seasonNumber: number
  ): Promise<TmdbEpisode[]> {
    this.assertConfigured();
    const params = new URLSearchParams();
    this.addKey(params);
    const query = params.toString();
    const data = await this.http.json<{
      season_number: number;
      episodes: Array<{
        episode_number: number;
        season_number?: number;
        name?: string;
        overview?: string | null;
        air_date?: string | null;
        runtime?: number | null;
        still_path?: string | null;
      }>;
    }>(`${this.options.baseUrl}/tv/${id}/season/${seasonNumber}${query ? `?${query}` : ""}`, {
      headers: this.headers(),
      provider: "tmdb"
    });

    return (data.episodes ?? []).map((episode) => ({
      seasonNumber: episode.season_number ?? data.season_number ?? seasonNumber,
      episodeNumber: episode.episode_number,
      title: episode.name?.trim() ? episode.name : null,
      overview: episode.overview?.trim() ? episode.overview : null,
      airDate: episode.air_date || null,
      runtimeMinutes: episode.runtime ?? null,
      image: episode.still_path
        ? `${this.options.imageBaseUrl}/w780${episode.still_path}`
        : null
    }));
  }

  private async searchType(query: string, mediaType: TmdbMediaType): Promise<TmdbSearchCandidate[]> {
    const params = new URLSearchParams({
      query,
      language: "en-US",
      include_adult: "false",
      page: "1"
    });
    this.addKey(params);

    const data = await this.http.json<{ results?: TmdbSearchItem[] }>(
      `${this.options.baseUrl}/search/${mediaType}?${params.toString()}`,
      { headers: this.headers(), provider: "tmdb" }
    );

    return (data.results ?? []).map((item) => {
      const isMovie = mediaType === "movie";
      return {
        id: item.id,
        mediaType,
        titles: uniqueTitles([
          item.name ?? item.title,
          item.original_name ?? item.original_title
        ]),
        year: parseYear(isMovie ? item.release_date : item.first_air_date),
        popularity: item.popularity ?? 0,
        posterPath: item.poster_path ?? null,
        backdropPath: item.backdrop_path ?? null,
        overview: item.overview?.trim() ? item.overview : null,
        voteAverage: item.vote_average ?? null,
        adult: item.adult ?? false
      };
    });
  }

  private async fetchDetails(id: number, mediaType: TmdbMediaType): Promise<TmdbDetails> {
    const params = new URLSearchParams({
      language: "en-US",
      append_to_response: "external_ids"
    });
    this.addKey(params);

    return this.http.json<TmdbDetails>(
      `${this.options.baseUrl}/${mediaType}/${id}?${params.toString()}`,
      { headers: this.headers(), provider: "tmdb" }
    );
  }

  private headers(): Record<string, string> {
    if (!this.options.accessToken) return {};
    return { Authorization: `Bearer ${this.options.accessToken}` };
  }

  private addKey(params: URLSearchParams): void {
    if (this.options.apiKey) params.set("api_key", this.options.apiKey);
  }

  private assertConfigured(): void {
    if (!this.options.enabled) {
      throw new ProviderError("tmdb", "TMDB is not configured", { status: 503 });
    }
  }
}

function mapDetails(
  details: TmdbDetails,
  mediaType: TmdbMediaType,
  imageBaseUrl: string
): AnimeMetadata {
  const isMovie = mediaType === "movie";
  const title = details.name ?? details.title ?? details.original_name ?? details.original_title;
  if (!title) {
    throw new NotFoundError(`TMDB ${mediaType} ${details.id} has no title`, "anime_not_found");
  }

  const date = isMovie ? details.release_date : details.first_air_date;
  const year = parseYear(date);
  const runtime = isMovie ? details.runtime ?? null : details.episode_run_time?.[0] ?? null;

  const externalLinks: Array<{ site: string; url: string; type: string | null }> = [];
  setLink(externalLinks, "IMDb", details.external_ids?.imdb_id ? `https://www.imdb.com/title/${details.external_ids.imdb_id}` : null);
  setLink(externalLinks, "TheTVDB", details.external_ids?.tvdb_id ? `https://thetvdb.com/series/${details.external_ids.tvdb_id}` : null);

  return {
    id: `tmdb:${details.id}`,
    source: "tmdb",
    anilistId: null,
    malId: null,
    tmdbId: details.id,
    tmdbMediaType: mediaType,
    titles: {
      romaji: details.original_name ?? details.original_title ?? null,
      english: title,
      native: null,
      preferred: title
    },
    synonyms: uniqueTitles([
      details.name ?? details.title,
      details.original_name ?? details.original_title
    ]),
    description: details.overview?.trim() ? details.overview : null,
    format: isMovie ? "MOVIE" : "TV",
    status: details.status ?? null,
    episodeCount: details.number_of_episodes ?? null,
    durationMinutes: runtime,
    season: { name: null, year },
    startDate: year ? { year, month: null, day: null } : null,
    endDate: null,
    genres: (details.genres ?? []).map((genre) => genre.name),
    averageScore: null,
    popularity: null,
    isAdult: false,
    images: {
      poster: details.poster_path ? `${imageBaseUrl}/w500${details.poster_path}` : null,
      posterLarge: details.poster_path ? `${imageBaseUrl}/original${details.poster_path}` : null,
      banner: details.backdrop_path ? `${imageBaseUrl}/original${details.backdrop_path}` : null,
      color: null
    },
    studios: (details.production_companies ?? []).map((company) => company.name),
    externalLinks,
    trailer: null,
    tmdbMatch: null
  };
}

function setLink(
  links: Array<{ site: string; url: string; type: string | null }>,
  site: string,
  url: string | null
): void {
  if (url) links.push({ site, url, type: "info" });
}

function uniqueTitles(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const title = value?.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

function parseYear(date: string | undefined | null): number | null {
  if (!date) return null;
  const match = /^(\d{4})/.exec(date);
  return match ? Number(match[1]) : null;
}
