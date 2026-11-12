import { MemoryCache } from "../src/cache/memory.js";
import { CacheService } from "../src/cache/service.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { Container } from "../src/container.js";
import type { AnimeMetadata } from "../src/metadata/types.js";
import type { Logger } from "../src/logger.js";
import { Logger as LoggerClass } from "../src/logger.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_MAX: "1000",
    ...overrides
  });
}

export function silentLogger(): Logger {
  return new LoggerClass("error", () => undefined);
}

export function testCache(config: Config, postgres?: ConstructorParameters<typeof CacheService>[0]["postgres"]) {
  return new CacheService({
    memory: new MemoryCache(config.cache.memoryMaxEntries),
    postgres,
    logger: silentLogger(),
    defaultStaleSeconds: 60
  });
}

export function animeFixture(overrides: Partial<AnimeMetadata> = {}): AnimeMetadata {
  return {
    id: "anilist:1",
    source: "anilist",
    anilistId: 1,
    malId: 1,
    tmdbId: null,
    tmdbMediaType: null,
    titles: {
      romaji: "Naruto",
      english: "Naruto",
      native: "ナルト",
      preferred: "Naruto"
    },
    synonyms: ["NARUTO"],
    description: "A ninja story.",
    format: "TV",
    status: "FINISHED",
    episodeCount: 220,
    durationMinutes: 23,
    season: { name: "FALL", year: 2002 },
    startDate: { year: 2002, month: 10, day: 3 },
    endDate: { year: 2007, month: 2, day: 8 },
    genres: ["Action", "Adventure"],
    averageScore: 80,
    popularity: 100000,
    isAdult: false,
    images: {
      poster: "https://anilist.example/poster.jpg",
      posterLarge: "https://anilist.example/poster-large.jpg",
      banner: null,
      color: "#e5b13a"
    },
    studios: ["Pierrot"],
    externalLinks: [],
    trailer: null,
    tmdbMatch: null,
    ...overrides
  };
}

export function fakeContainer(overrides: Partial<Container> = {}): Container {
  const config = testConfig();
  const cache = testCache(config);
  const logger = silentLogger();
  return {
    config,
    logger,
    pool: null,
    cache,
    metadata: {
      search: async () => ({
        value: {
          results: [animeFixture()],
          page: 1,
          perPage: 20,
          total: 1,
          lastPage: 1,
          hasNextPage: false
        },
        cached: false,
        stale: false,
        warnings: []
      }),
      getAnime: async () => ({
        value: animeFixture(),
        cached: false,
        stale: false,
        warnings: []
      }),
      getTmdbSeasons: async () => [],
      tmdb: {}
    } as unknown as Container["metadata"],
    episodes: {
      list: async () => ({
        animeId: "anilist:1",
        kind: "tv",
        source: "anilist",
        seasonNumber: null,
        seasons: [],
        episodes: [
          {
            id: "anilist:1:e1",
            animeId: "anilist:1",
            seasonNumber: null,
            episodeNumber: 1,
            title: "Enter Naruto",
            overview: null,
            airDate: null,
            runtimeMinutes: 23,
            image: null,
            kind: "tv",
            available: true,
            metadataAvailable: true,
            source: "anilist"
          }
        ],
        complete: true,
        page: 1,
        limit: 50,
        total: 1,
        warnings: [],
        cached: false,
        stale: false
      }),
      getEpisode: async () => ({
        episode: {
          id: "anilist:1:e1",
          animeId: "anilist:1",
          seasonNumber: null,
          episodeNumber: 1,
          title: "Enter Naruto",
          overview: null,
          airDate: null,
          runtimeMinutes: 23,
          image: null,
          kind: "tv",
          available: true,
          metadataAvailable: true,
          source: "anilist"
        },
        cached: false,
        stale: false,
        warnings: []
      }),
      getAnimeForEpisode: async () => animeFixture(),
      getCatalogue: async () => ({
        animeId: "anilist:1",
        kind: "tv",
        source: "anilist",
        seasons: [],
        episodes: [],
        complete: true,
        warnings: [],
        cached: false,
        stale: false
      })
    } as unknown as Container["episodes"],
    sources: {
      getSources: async () => ({
        episodeId: "anilist:1:e1",
        sources: [],
        providers: [],
        warnings: [],
        cached: false,
        stale: false
      })
    } as unknown as Container["sources"],
    subtitles: {
      getSubtitles: async () => ({
        episodeId: "anilist:1:e1",
        tracks: [],
        embedded: [],
        warnings: [],
        cached: false,
        stale: false
      })
    } as unknown as Container["subtitles"],
    sourceProviders: [],
    matchRepository: null,
    startedAt: Date.now(),
    version: "test",
    ...overrides
  };
}
