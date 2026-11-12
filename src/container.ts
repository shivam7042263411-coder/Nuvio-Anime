import type { Pool } from "pg";
import { MemoryCache } from "./cache/memory.js";
import { PostgresCache } from "./cache/postgres.js";
import { CacheService } from "./cache/service.js";
import type { Config } from "./config.js";
import { EpisodesService } from "./episodes/service.js";
import { HttpClient } from "./http/client.js";
import { Logger } from "./logger.js";
import { AniListProvider } from "./metadata/anilist.js";
import { PostgresMatchRepository, type MatchRepository } from "./metadata/repository.js";
import { MetadataService } from "./metadata/service.js";
import { TmdbProvider } from "./metadata/tmdb.js";
import { CatalogSourceProvider } from "./sources/catalog.js";
import { SourcesService } from "./sources/service.js";
import type { SourceProvider } from "./sources/types.js";
import { AnimePaheProvider } from "./sources/animepahe/provider.js";
import { SubtitlesService } from "./subtitles/service.js";
import { APP_VERSION } from "./version.js";

export interface Container {
  config: Config;
  logger: Logger;
  pool: Pool | null;
  cache: CacheService;
  metadata: MetadataService;
  episodes: EpisodesService;
  sources: SourcesService;
  subtitles: SubtitlesService;
  sourceProviders: SourceProvider[];
  matchRepository: MatchRepository | null;
  startedAt: number;
  version: string;
}

export function createContainer(
  config: Config,
  logger: Logger,
  pool: Pool | null
): Container {
  const http = new HttpClient({
    timeoutMs: config.http.timeoutMs,
    maxConcurrency: config.http.maxConcurrency,
    retries: config.http.retries,
    userAgent: `animepahe-api/${APP_VERSION} (+https://antideploy.app)`,
    logger
  });

  const memory = new MemoryCache(config.cache.memoryMaxEntries);
  const postgresCache = pool ? new PostgresCache(pool) : undefined;
  const cache = new CacheService({
    memory,
    postgres: postgresCache,
    logger,
    defaultStaleSeconds: config.cache.staleTtl
  });

  const anilist = new AniListProvider(http, config.anilist.url);
  const tmdb = new TmdbProvider(http, {
    ...config.tmdb,
    baseUrl: config.tmdb.url
  });
  const matchRepository = pool ? new PostgresMatchRepository(pool) : null;

  const metadata = new MetadataService({
    anilist,
    tmdb,
    cache,
    matchRepository,
    config,
    logger
  });

  const episodes = new EpisodesService({
    metadata,
    anilist,
    cache,
    config,
    logger
  });

  const sourceProviders: SourceProvider[] = [
    new CatalogSourceProvider(pool, config.sources.catalogEnabled, logger),
    new AnimePaheProvider({
      http,
      metadata,
      config,
      logger
    })
  ];

  const sources = new SourcesService({
    episodeService: episodes,
    providers: sourceProviders,
    cache,
    config,
    logger
  });

  const subtitles = new SubtitlesService({
    pool,
    cache,
    episodeService: episodes,
    config,
    logger,
    providers: sourceProviders
  });

  return {
    config,
    logger,
    pool,
    cache,
    metadata,
    episodes,
    sources,
    subtitles,
    sourceProviders,
    matchRepository,
    startedAt: Date.now(),
    version: APP_VERSION
  };
}
