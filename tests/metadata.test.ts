import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/http/client.js";
import type { AniListProvider } from "../src/metadata/anilist.js";
import { MetadataService } from "../src/metadata/service.js";
import { TmdbProvider } from "../src/metadata/tmdb.js";
import type { AnimeMetadata } from "../src/metadata/types.js";
import { animeFixture, silentLogger, testCache, testConfig } from "./helpers.js";

function setup(options: { configured?: boolean } = {}) {
  const config = testConfig();
  const cache = testCache(config);
  const anilist = {
    search: vi.fn(),
    getById: vi.fn(),
    getStreamingEpisodes: vi.fn()
  } as unknown as AniListProvider;
  const tmdb = {
    isConfigured: options.configured ?? true,
    searchCandidates: vi.fn(),
    getDetails: vi.fn(),
    getDetailsAny: vi.fn(),
    getSeasons: vi.fn(),
    getSeasonEpisodes: vi.fn()
  } as unknown as TmdbProvider;
  const service = new MetadataService({
    anilist,
    tmdb,
    cache,
    matchRepository: null,
    config,
    logger: silentLogger()
  });
  return { service, anilist, tmdb };
}

function tmdbFixture(overrides: Partial<AnimeMetadata> = {}): AnimeMetadata {
  return animeFixture({
    id: "tmdb:1429",
    source: "tmdb",
    anilistId: null,
    malId: null,
    tmdbId: 1429,
    tmdbMediaType: "tv",
    titles: {
      romaji: "Shingeki no Kyojin",
      english: "Attack on Titan",
      native: null,
      preferred: "Attack on Titan"
    },
    images: {
      poster: "https://tmdb.example/poster.jpg",
      posterLarge: "https://tmdb.example/poster-large.jpg",
      banner: "https://tmdb.example/backdrop.jpg",
      color: null
    },
    tmdbMatch: null,
    ...overrides
  });
}

afterEach(() => vi.useRealTimers());

describe("metadata service", () => {
  it("caches search results", async () => {
    const { service, anilist } = setup();
    vi.mocked(anilist.search).mockResolvedValue({
      results: [animeFixture()],
      page: 1,
      perPage: 20,
      total: 1,
      lastPage: 1,
      hasNextPage: false
    });

    const first = await service.search("naruto", 1, 20);
    const second = await service.search("naruto", 1, 20);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(anilist.search).toHaveBeenCalledTimes(1);
  });

  it("enriches AniList metadata with a TMDB match and artwork", async () => {
    const { service, anilist, tmdb } = setup();
    vi.mocked(anilist.getById).mockResolvedValue(
      animeFixture({
        id: "anilist:16498",
        anilistId: 16498,
        titles: {
          romaji: "Shingeki no Kyojin",
          english: "Attack on Titan",
          native: "進撃の巨人",
          preferred: "Attack on Titan"
        },
        season: { name: "SPRING", year: 2013 },
        format: "TV"
      })
    );
    vi.mocked(tmdb.searchCandidates).mockResolvedValue([
      {
        id: 1429,
        mediaType: "tv",
        titles: ["Attack on Titan", "Shingeki no Kyojin"],
        year: 2013,
        popularity: 500,
        posterPath: "/poster.jpg",
        backdropPath: "/backdrop.jpg",
        overview: null,
        voteAverage: 8.7,
        adult: false
      }
    ]);
    vi.mocked(tmdb.getDetails).mockResolvedValue(tmdbFixture());

    const result = await service.getAnime("anilist:16498");

    expect(result.value.id).toBe("anilist:16498");
    expect(result.value.tmdbMatch).toMatchObject({ id: 1429, mediaType: "tv" });
    expect(result.value.images.poster).toBe("https://tmdb.example/poster.jpg");
    expect(result.value.titles.preferred).toBe("Attack on Titan");
  });

  it("keeps AniList data when TMDB is not configured", async () => {
    const { service, anilist, tmdb } = setup({ configured: false });
    vi.mocked(anilist.getById).mockResolvedValue(animeFixture());

    const result = await service.getAnime("anilist:1");

    expect(result.value.tmdbMatch).toBeNull();
    expect(tmdb.searchCandidates).not.toHaveBeenCalled();
  });

  it("resolves a TMDB id to the canonical AniList id", async () => {
    const { service, anilist, tmdb } = setup();
    vi.mocked(tmdb.getDetailsAny).mockResolvedValue(tmdbFixture());
    vi.mocked(anilist.search).mockResolvedValue({
      results: [
        animeFixture({
          id: "anilist:16498",
          anilistId: 16498,
          titles: {
            romaji: "Shingeki no Kyojin",
            english: "Attack on Titan",
            native: null,
            preferred: "Attack on Titan"
          },
          season: { name: "SPRING", year: 2013 }
        })
      ],
      page: 1,
      perPage: 10,
      total: 1,
      lastPage: 1,
      hasNextPage: false
    });
    vi.mocked(anilist.getById).mockResolvedValue(
      animeFixture({
        id: "anilist:16498",
        anilistId: 16498,
        titles: {
          romaji: "Shingeki no Kyojin",
          english: "Attack on Titan",
          native: null,
          preferred: "Attack on Titan"
        },
        season: { name: "SPRING", year: 2013 }
      })
    );

    const result = await service.getAnime("tmdb:1429");

    expect(result.value.id).toBe("anilist:16498");
    expect(result.value.requestedId).toBe("tmdb:1429");
    expect(result.value.tmdbMatch?.id).toBe(1429);
  });

  it("maps a TMDB id missing from both TV and movie to anime_not_found", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status_message: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
    );
    const http = new HttpClient({
      timeoutMs: 1000,
      maxConcurrency: 1,
      retries: 0,
      userAgent: "test",
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const tmdb = new TmdbProvider(http, {
      enabled: true,
      apiKey: "test-key",
      accessToken: null,
      baseUrl: "https://tmdb.test/3",
      imageBaseUrl: "https://image.test/t/p"
    });

    await expect(tmdb.getDetailsAny(999999)).rejects.toMatchObject({
      code: "anime_not_found",
      status: 404
    });
    // TV is tried first, then movie.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("authenticates season episode requests with a v3 API key", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            season_number: 1,
            episodes: [{ episode_number: 1, name: "Winter Is Coming" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const http = new HttpClient({
      timeoutMs: 1000,
      maxConcurrency: 1,
      retries: 0,
      userAgent: "test",
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const tmdb = new TmdbProvider(http, {
      enabled: true,
      apiKey: "test-key",
      accessToken: null,
      baseUrl: "https://tmdb.test/3",
      imageBaseUrl: "https://image.test/t/p"
    });

    const episodes = await tmdb.getSeasonEpisodes(1399, 1);

    expect(episodes).toHaveLength(1);
    const request = JSON.stringify(fetchImpl.mock.calls[0]);
    expect(request).toContain("/tv/1399/season/1");
    expect(request).toContain("api_key=test-key");
    expect(request).not.toContain("Authorization");
  });

  it("serves stale metadata when the provider fails", async () => {
    vi.useFakeTimers();
    const { service, anilist } = setup();
    vi.mocked(anilist.search).mockResolvedValue({
      results: [animeFixture()],
      page: 1,
      perPage: 20,
      total: 1,
      lastPage: 1,
      hasNextPage: false
    });

    await service.search("naruto", 1, 20);
    vi.advanceTimersByTime(301_000);
    vi.mocked(anilist.search).mockRejectedValue(new Error("AniList down"));

    const result = await service.search("naruto", 1, 20);
    expect(result.stale).toBe(true);
    expect(result.value.results).toHaveLength(1);
  });

  it("propagates provider failures when no stale copy exists", async () => {
    const { service, anilist } = setup();
    vi.mocked(anilist.search).mockRejectedValue(new Error("AniList down"));

    await expect(service.search("unknown", 1, 20)).rejects.toThrow("AniList down");
  });
});
