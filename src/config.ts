import { existsSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string | null;
  corsOrigins: string[];
  trustProxy: boolean;
  logLevel: LogLevel;
  rateLimit: {
    enabled: boolean;
    windowSeconds: number;
    max: number;
  };
  anilist: {
    url: string;
  };
  tmdb: {
    enabled: boolean;
    apiKey: string | null;
    accessToken: string | null;
    url: string;
    imageBaseUrl: string;
  };
  cache: {
    searchTtl: number;
    animeTtl: number;
    episodeTtl: number;
    matchTtl: number;
    sourcesTtl: number;
    subtitlesTtl: number;
    staleTtl: number;
    memoryMaxEntries: number;
  };
  http: {
    timeoutMs: number;
    maxConcurrency: number;
    retries: number;
  };
  sources: {
    catalogEnabled: boolean;
    /** Maximum time one provider may spend resolving an episode. */
    providerTimeoutMs: number;
    animepahe: {
      enabled: boolean;
      baseUrl: string;
      userAgent: string;
      deadlineMs: number;
      maxSearchPages: number;
      maxDownloadOptions: number;
    };
  };
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function readUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = (env[name] ?? fallback).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function readOriginList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CORS_ORIGINS ?? "";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "") return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
}

let envLoaded = false;

/** Load .env for local development. Antideploy injects variables directly. */
export function loadLocalEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const path = `${process.cwd()}/.env`;
  if (!existsSync(path)) return;
  try {
    // Node 20.12+ / 22. Available on the deployment runtime too.
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not hide the real startup error.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnvRaw = (env.NODE_ENV ?? "development").toLowerCase();
  const nodeEnv =
    nodeEnvRaw === "production" || nodeEnvRaw === "test"
      ? (nodeEnvRaw as "production" | "test")
      : "development";

  const databaseUrl = (env.DATABASE_URL ?? "").trim() || null;
  if (nodeEnv === "production" && !databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. On Antideploy, add a Postgres database to the application; the platform injects DATABASE_URL."
    );
  }

  const apiKey = (env.TMDB_API_KEY ?? "").trim() || null;
  const accessToken = (env.TMDB_ACCESS_TOKEN ?? "").trim() || null;

  return {
    nodeEnv,
    port: readInt(env, "PORT", 3000, { min: 1, max: 65535 }),
    databaseUrl,
    corsOrigins: readOriginList(env),
    trustProxy: readBool(env, "TRUST_PROXY", false),
    logLevel: readLogLevel(env),
    rateLimit: {
      enabled: readBool(env, "RATE_LIMIT_ENABLED", true),
      windowSeconds: readInt(env, "RATE_LIMIT_WINDOW_SECONDS", 60, { min: 1, max: 3600 }),
      max: readInt(env, "RATE_LIMIT_MAX", 90, { min: 1, max: 100000 })
    },
    anilist: {
      url: readUrl(env, "ANILIST_API_URL", "https://graphql.anilist.co")
    },
    tmdb: {
      enabled: Boolean(apiKey || accessToken),
      apiKey,
      accessToken,
      url: readUrl(env, "TMDB_API_URL", "https://api.themoviedb.org/3"),
      imageBaseUrl: readUrl(env, "TMDB_IMAGE_BASE_URL", "https://image.tmdb.org/t/p")
    },
    cache: {
      searchTtl: readInt(env, "SEARCH_CACHE_TTL", 300, { min: 1 }),
      animeTtl: readInt(env, "ANIME_CACHE_TTL", 21600, { min: 1 }),
      episodeTtl: readInt(env, "EPISODE_CACHE_TTL", 21600, { min: 1 }),
      matchTtl: readInt(env, "MATCH_CACHE_TTL", 86400, { min: 1 }),
      sourcesTtl: readInt(env, "SOURCES_CACHE_TTL", 60, { min: 1 }),
      subtitlesTtl: readInt(env, "SUBTITLES_CACHE_TTL", 120, { min: 1 }),
      staleTtl: readInt(env, "STALE_CACHE_TTL", 604800, { min: 0 }),
      memoryMaxEntries: readInt(env, "MEMORY_CACHE_MAX_ENTRIES", 500, { min: 10, max: 100000 })
    },
    http: {
      timeoutMs: readInt(env, "HTTP_TIMEOUT_MS", 8000, { min: 500, max: 60000 }),
      maxConcurrency: readInt(env, "HTTP_MAX_CONCURRENCY", 6, { min: 1, max: 50 }),
      retries: readInt(env, "HTTP_RETRIES", 2, { min: 0, max: 5 })
    },
    sources: {
      catalogEnabled: readBool(env, "SOURCE_CATALOG_ENABLED", true),
      providerTimeoutMs: readInt(env, "SOURCE_PROVIDER_TIMEOUT_MS", 45000, {
        min: 1000,
        max: 120000
      }),
      animepahe: {
        enabled: readBool(env, "SOURCE_ANIMEPAHE_ENABLED", false),
        baseUrl: readUrl(env, "ANIMEPAHE_BASE_URL", "https://animepahe.pw"),
        userAgent:
          (env.ANIMEPAHE_USER_AGENT ?? "").trim() ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        deadlineMs: readInt(env, "ANIMEPAHE_DEADLINE_MS", 45000, {
          min: 5000,
          max: 55000
        }),
        maxSearchPages: readInt(env, "ANIMEPAHE_MAX_SEARCH_PAGES", 2, {
          min: 1,
          max: 5
        }),
        maxDownloadOptions: readInt(env, "ANIMEPAHE_MAX_DOWNLOAD_OPTIONS", 4, {
          min: 0,
          max: 10
        })
      }
    }
  };
}
