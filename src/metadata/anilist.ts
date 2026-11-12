import { ProviderError } from "../errors.js";
import type { HttpClient } from "../http/client.js";
import { NotFoundError } from "../errors.js";
import type { AnimeMetadata, SearchPage } from "./types.js";

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native userPreferred }
  synonyms
  description(asHtml: false)
  format
  status
  episodes
  duration
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  genres
  averageScore
  popularity
  isAdult
  coverImage { extraLarge large color }
  bannerImage
  studios(isMain: true) { nodes { id name } }
  externalLinks { id url site type }
  trailer { id site }
`;

const SEARCH_QUERY = `
  query Search($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

const MEDIA_QUERY = `
  query Media($id: Int) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
    }
  }
`;

const STREAMING_QUERY = `
  query Streaming($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      streamingEpisodes { title thumbnail url site }
    }
  }
`;

interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
  userPreferred: string | null;
}

interface AniListDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

interface AniListMedia {
  id: number;
  idMal: number | null;
  title: AniListTitle;
  synonyms: string[] | null;
  description: string | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  startDate: AniListDate | null;
  endDate: AniListDate | null;
  genres: string[] | null;
  averageScore: number | null;
  popularity: number | null;
  isAdult: boolean;
  coverImage: { extraLarge: string | null; large: string | null; color: string | null } | null;
  bannerImage: string | null;
  studios: { nodes: Array<{ id: number; name: string }> } | null;
  externalLinks: Array<{ id: number; url: string; site: string; type: string | null }> | null;
  trailer: { id: string; site: string } | null;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; status?: number }>;
}

export interface StreamingEpisode {
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  site: string | null;
}

export class AniListProvider {
  constructor(
    private readonly http: HttpClient,
    private readonly endpoint: string
  ) {}

  async search(query: string, page: number, perPage: number): Promise<SearchPage> {
    const response = await this.request<{
      Page: {
        pageInfo: {
          total: number;
          currentPage: number;
          lastPage: number;
          hasNextPage: boolean;
          perPage: number;
        };
        media: AniListMedia[];
      };
    }>(SEARCH_QUERY, { search: query, page, perPage });

    const pageInfo = response.Page.pageInfo;
    const results = dedupeById(
      (response.Page.media ?? []).filter(Boolean).map(mapAnime)
    );

    return {
      results,
      page: pageInfo.currentPage,
      perPage: pageInfo.perPage,
      total: pageInfo.total,
      lastPage: pageInfo.lastPage,
      hasNextPage: pageInfo.hasNextPage
    };
  }

  async getById(id: number): Promise<AnimeMetadata> {
    const response = await this.request<{ Media: AniListMedia | null }>(MEDIA_QUERY, { id });
    if (!response.Media) {
      throw new NotFoundError(`AniList anime ${id} was not found`, "anime_not_found");
    }
    return mapAnime(response.Media);
  }

  async getStreamingEpisodes(id: number): Promise<StreamingEpisode[]> {
    const response = await this.request<{
      Media: { id: number; streamingEpisodes: StreamingEpisode[] | null } | null;
    }>(STREAMING_QUERY, { id });

    if (!response.Media) {
      throw new NotFoundError(`AniList anime ${id} was not found`, "anime_not_found");
    }

    return (response.Media.streamingEpisodes ?? []).map((episode) => ({
      title: episode.title ?? null,
      thumbnail: episode.thumbnail ?? null,
      url: episode.url ?? null,
      site: episode.site ?? null
    }));
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.http.json<GraphQlResponse<T>>(this.endpoint, {
      method: "POST",
      body: { query, variables },
      provider: "anilist",
      retry: true
    });

    if (response.errors?.length) {
      const message = response.errors[0]?.message ?? "AniList returned an error";
      throw new ProviderError("anilist", `AniList: ${message}`, {
        upstreamStatus: response.errors[0]?.status ?? null
      });
    }
    if (!response.data) {
      throw new ProviderError("anilist", "AniList returned an empty response");
    }
    return response.data;
  }
}

function mapAnime(media: AniListMedia): AnimeMetadata {
  const preferred =
    media.title.userPreferred ??
    media.title.english ??
    media.title.romaji ??
    media.title.native ??
    `AniList ${media.id}`;

  return {
    id: `anilist:${media.id}`,
    source: "anilist",
    anilistId: media.id,
    malId: media.idMal,
    tmdbId: null,
    tmdbMediaType: null,
    titles: {
      romaji: media.title.romaji,
      english: media.title.english,
      native: media.title.native,
      preferred
    },
    synonyms: media.synonyms ?? [],
    description: media.description ? cleanDescription(media.description) : null,
    format: media.format,
    status: media.status,
    episodeCount: media.episodes,
    durationMinutes: media.duration,
    season: { name: media.season, year: media.seasonYear },
    startDate: media.startDate,
    endDate: media.endDate,
    genres: media.genres ?? [],
    averageScore: media.averageScore,
    popularity: media.popularity,
    isAdult: media.isAdult,
    images: {
      poster: media.coverImage?.large ?? null,
      posterLarge: media.coverImage?.extraLarge ?? null,
      banner: media.bannerImage ?? null,
      color: media.coverImage?.color ?? null
    },
    studios: media.studios?.nodes.map((studio) => studio.name) ?? [],
    externalLinks: (media.externalLinks ?? []).map((link) => ({
      site: link.site,
      url: link.url,
      type: link.type
    })),
    trailer: media.trailer
      ? {
          id: media.trailer.id,
          site: media.trailer.site,
          url:
            media.trailer.site.toLowerCase() === "youtube"
              ? `https://www.youtube.com/watch?v=${media.trailer.id}`
              : `https://${media.trailer.site.toLowerCase()}.com/watch?v=${media.trailer.id}`
        }
      : null,
    tmdbMatch: null
  };
}

function cleanDescription(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function dedupeById(items: AnimeMetadata[]): AnimeMetadata[] {
  const map = new Map<string, AnimeMetadata>();
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item);
  return [...map.values()];
}
