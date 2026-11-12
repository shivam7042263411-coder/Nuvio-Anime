import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EpisodesService } from "../src/episodes/service.js";
import { CatalogSourceProvider } from "../src/sources/catalog.js";
import { SourcesService } from "../src/sources/service.js";
import type { SourceProvider } from "../src/sources/types.js";
import type { ProviderSubtitleResult } from "../src/subtitles/types.js";
import { SubtitlesService } from "../src/subtitles/service.js";
import { animeFixture, silentLogger, testCache, testConfig } from "./helpers.js";

const episode = {
  id: "anilist:1:e1",
  animeId: "anilist:1",
  seasonNumber: null,
  episodeNumber: 1,
  title: "Episode 1",
  overview: null,
  airDate: null,
  runtimeMinutes: 23,
  image: null,
  kind: "tv" as const,
  available: true,
  metadataAvailable: true,
  source: "anilist" as const
};

function fakeEpisodeService(): EpisodesService {
  return {
    getEpisode: vi.fn(async () => ({
      episode,
      cached: false,
      stale: false,
      warnings: []
    })),
    getAnimeForEpisode: vi.fn(async () => animeFixture())
  } as unknown as EpisodesService;
}

const source = (overrides: Record<string, unknown> = {}) => ({
  id: "src_1",
  provider: "catalog",
  label: "Sub" as const,
  language: "ja",
  quality: "1080p",
  type: "hls" as const,
  delivery: "stream" as const,
  url: "https://cdn.example/1.m3u8",
  headers: {},
  expiresAt: null,
  temporary: true,
  ...overrides
});

describe("source catalogue provider", () => {
  it("maps operator rows into Sub/Dub/DL streaming labels", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "a",
          provider_id: "catalog",
          label: "sub",
          language: "ja",
          quality: "1080p",
          stream_type: "hls",
          url: "https://cdn.example/sub.m3u8",
          headers: { Referer: "https://example.com/" },
          expires_at: null
        },
        {
          id: "b",
          provider_id: "catalog",
          label: "dub",
          language: "en",
          quality: "720p",
          stream_type: "hls",
          url: "https://cdn.example/dub.m3u8",
          headers: null,
          expires_at: null
        },
        {
          id: "c",
          provider_id: "catalog",
          label: "dl",
          language: "ja",
          quality: "1080p",
          stream_type: "mp4",
          url: "https://cdn.example/dl.mp4",
          headers: null,
          expires_at: null
        }
      ]
    }));
    const provider = new CatalogSourceProvider(
      { query } as unknown as Pool,
      true,
      silentLogger()
    );

    const result = await provider.getSources({ anime: animeFixture(), episode });

    expect(result.sources.map((item) => item.label)).toEqual(["Sub", "Dub", "DL"]);
    expect(result.sources[0]?.headers).toEqual({ Referer: "https://example.com/" });
    expect(result.sources[2]).toMatchObject({ type: "mp4", delivery: "stream" });
  });

  it("is not configured without a database", () => {
    const provider = new CatalogSourceProvider(null, true, silentLogger());
    expect(provider.isConfigured()).toBe(false);
  });
});

describe("sources service", () => {
  it("deduplicates and sorts Sub before Dub before DL", async () => {
    const config = testConfig();
    const provider: SourceProvider = {
      id: "catalog",
      name: "Catalogue",
      isConfigured: () => true,
      getSources: async () => ({
        sources: [
          source({ id: "dl", label: "DL" }),
          source({ id: "dub", label: "Dub", quality: "720p" }),
          source({ id: "sub", label: "Sub", quality: "1080p" }),
          source({ id: "sub", label: "Sub", quality: "1080p" })
        ],
        warnings: []
      })
    };

    const service = new SourcesService({
      episodeService: fakeEpisodeService(),
      providers: [provider],
      cache: testCache(config),
      config,
      logger: silentLogger()
    });

    const result = await service.getSources("anilist:1:e1");
    expect(result.sources.map((item) => item.label)).toEqual(["Sub", "Dub", "DL"]);
    expect(result.sources).toHaveLength(3);
  });

  it("caches sources in memory only", async () => {
    const config = testConfig();
    const getSources = vi.fn(async () => ({ sources: [source()], warnings: [] }));
    const provider: SourceProvider = {
      id: "catalog",
      name: "Catalogue",
      isConfigured: () => true,
      getSources
    };
    const service = new SourcesService({
      episodeService: fakeEpisodeService(),
      providers: [provider],
      cache: testCache(config),
      config,
      logger: silentLogger()
    });

    await service.getSources("anilist:1:e1");
    const second = await service.getSources("anilist:1:e1");

    expect(second.cached).toBe(true);
    expect(getSources).toHaveBeenCalledTimes(1);
  });

  it("returns partial results and a warning when one provider fails", async () => {
    const config = testConfig();
    const providers: SourceProvider[] = [
      {
        id: "good",
        name: "Good",
        isConfigured: () => true,
        getSources: async () => ({ sources: [source()], warnings: [] })
      },
      {
        id: "bad",
        name: "Bad",
        isConfigured: () => true,
        getSources: async () => {
          throw new Error("down");
        }
      }
    ];
    const service = new SourcesService({
      episodeService: fakeEpisodeService(),
      providers,
      cache: testCache(config),
      config,
      logger: silentLogger()
    });

    const result = await service.getSources("anilist:1:e1");
    expect(result.sources).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("Bad");
  });

  it("throws when every configured provider fails", async () => {
    const config = testConfig();
    const provider: SourceProvider = {
      id: "bad",
      name: "Bad",
      isConfigured: () => true,
      getSources: async () => {
        throw new Error("down");
      }
    };
    const service = new SourcesService({
      episodeService: fakeEpisodeService(),
      providers: [provider],
      cache: testCache(config),
      config,
      logger: silentLogger()
    });

    await expect(service.getSources("anilist:1:e1")).rejects.toMatchObject({
      code: "provider_error"
    });
  });

  it("deduplicates equivalent streams across providers but keeps different headers", async () => {
    const config = testConfig();
    const sharedUrl = "https://cdn.example/shared.m3u8";
    const first: SourceProvider = {
      id: "alpha",
      name: "Alpha",
      isConfigured: () => true,
      getSources: async () => ({
        sources: [
          source({
            id: "alpha-sub",
            provider: "alpha",
            providerName: "Alpha",
            url: sharedUrl,
            headers: { Referer: "https://alpha.example/" },
            name: "Alpha release",
            size: "700MB"
          })
        ],
        warnings: ["alpha warning"]
      })
    };
    const second: SourceProvider = {
      id: "beta",
      name: "Beta",
      isConfigured: () => true,
      getSources: async () => ({
        sources: [
          source({
            id: "beta-duplicate",
            provider: "beta",
            providerName: "Beta",
            url: sharedUrl,
            headers: { referer: "https://alpha.example/" }
          }),
          source({
            id: "beta-distinct",
            provider: "beta",
            providerName: "Beta",
            url: sharedUrl,
            headers: { Referer: "https://beta.example/" }
          })
        ],
        warnings: []
      })
    };
    const service = new SourcesService({
      episodeService: fakeEpisodeService(),
      providers: [first, second],
      cache: testCache(config),
      config,
      logger: silentLogger()
    });

    const result = await service.getSources("anilist:1:e1");

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      provider: "alpha",
      providerName: "Alpha",
      name: "Alpha release",
      size: "700MB"
    });
    expect(result.sources[1]).toMatchObject({
      provider: "beta",
      headers: { Referer: "https://beta.example/" }
    });
    expect(result.warnings).toContain("alpha warning");
  });

  it("isolates a hung provider with a timeout and keeps partial results", async () => {
    vi.useFakeTimers();
    try {
      const config = testConfig({ SOURCE_PROVIDER_TIMEOUT_MS: "1000" });
      const providers: SourceProvider[] = [
        {
          id: "good",
          name: "Good",
          isConfigured: () => true,
          getSources: async () => ({ sources: [source()], warnings: [] })
        },
        {
          id: "hung",
          name: "Hung",
          isConfigured: () => true,
          getSources: () => new Promise(() => undefined)
        }
      ];
      const service = new SourcesService({
        episodeService: fakeEpisodeService(),
        providers,
        cache: testCache(config),
        config,
        logger: silentLogger()
      });

      const pending = service.getSources("anilist:1:e1");
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.sources).toHaveLength(1);
      expect(result.warnings.join(" ")).toContain("Hung");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subtitles service", () => {
  it("returns external tracks as selectable and embedded subtitles separately", async () => {
    const config = testConfig();
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "sub_en",
          provider_id: "catalog",
          kind: "external",
          language: "en",
          label: "English",
          format: "vtt",
          url: "https://cdn.example/en.vtt",
          headers: null,
          is_default: true
        },
        {
          id: "sub_es",
          provider_id: "catalog",
          kind: "external",
          language: "es",
          label: "Spanish",
          format: "srt",
          url: "https://cdn.example/es.srt",
          headers: null,
          is_default: false
        },
        {
          id: "hardsub",
          provider_id: "catalog",
          kind: "embedded",
          language: "en",
          label: "English hardsub",
          format: null,
          url: null,
          headers: null,
          is_default: false
        }
      ]
    }));
    const service = new SubtitlesService({
      pool: { query } as unknown as Pool,
      cache: testCache(config),
      episodeService: fakeEpisodeService(),
      config,
      logger: silentLogger()
    });

    const result = await service.getSubtitles("anilist:1:e1");

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks.every((track) => track.selectable)).toBe(true);
    expect(result.embedded).toEqual([
      {
        language: "en",
        label: "English hardsub",
        source: "catalog",
        selectable: false
      }
    ]);
    expect(result.tracks.map((track) => track.label)).not.toContain("English hardsub");
  });

  it("works without a database, returning no tracks", async () => {
    const config = testConfig();
    const service = new SubtitlesService({
      pool: null,
      cache: testCache(config),
      episodeService: fakeEpisodeService(),
      config,
      logger: silentLogger()
    });

    const result = await service.getSubtitles("anilist:1:e1");
    expect(result.tracks).toEqual([]);
    expect(result.embedded).toEqual([]);
  });

  it("merges provider external tracks and keeps embedded facts unselectable", async () => {
    const config = testConfig();
    const provider: SourceProvider = {
      id: "animepahe",
      name: "AnimePahe",
      isConfigured: () => true,
      getSources: async () => ({ sources: [], warnings: [] }),
      getSubtitles: async (): Promise<ProviderSubtitleResult> => ({
        tracks: [
          {
            id: "provider-en",
            language: "en",
            label: "English",
            format: "vtt",
            url: "https://cdn.example/provider-en.vtt",
            headers: { Referer: "https://kwik.cx/" },
            isDefault: false,
            source: "ignored-by-service",
            selectable: true
          },
          {
            id: "provider-en-dup",
            language: "en",
            label: "English",
            format: "vtt",
            url: "https://cdn.example/provider-en.vtt",
            headers: { Referer: "https://kwik.cx/" },
            isDefault: false,
            source: "ignored-by-service",
            selectable: true
          },
          {
            id: "provider-bad-url",
            language: "en",
            label: "Broken",
            format: "srt",
            url: "ftp://cdn.example/broken.srt",
            headers: {},
            isDefault: false,
            source: "ignored-by-service",
            selectable: true
          }
        ],
        embedded: [
          {
            language: "ja",
            label: "Japanese signs",
            source: "ignored-by-service",
            selectable: false
          }
        ],
        warnings: ["provider subtitle note"]
      })
    };
    const service = new SubtitlesService({
      pool: null,
      cache: testCache(config),
      episodeService: fakeEpisodeService(),
      config,
      logger: silentLogger(),
      providers: [provider]
    });

    const result = await service.getSubtitles("anilist:1:e1");

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      id: "provider-en",
      source: "animepahe",
      selectable: true,
      headers: { Referer: "https://kwik.cx/" }
    });
    expect(result.embedded).toEqual([
      {
        language: "ja",
        label: "Japanese signs",
        source: "animepahe",
        selectable: false
      }
    ]);
    expect(result.tracks.map((track) => track.label)).not.toContain("Japanese signs");
    expect(result.warnings).toContain("provider subtitle note");
    expect(result.warnings.join(" ")).toContain("unusable track");
  });

  it("keeps subtitle tracks from a working provider when another fails", async () => {
    const config = testConfig();
    const good: SourceProvider = {
      id: "good",
      name: "Good",
      isConfigured: () => true,
      getSources: async () => ({ sources: [], warnings: [] }),
      getSubtitles: async () => ({
        tracks: [
          {
            id: "good-en",
            language: "en",
            label: "English",
            format: "srt",
            url: "https://cdn.example/good-en.srt",
            headers: {},
            isDefault: false,
            source: "good",
            selectable: true
          }
        ],
        embedded: [],
        warnings: []
      })
    };
    const bad: SourceProvider = {
      id: "bad",
      name: "Bad",
      isConfigured: () => true,
      getSources: async () => ({ sources: [], warnings: [] }),
      getSubtitles: async () => {
        throw new Error("down");
      }
    };
    const service = new SubtitlesService({
      pool: null,
      cache: testCache(config),
      episodeService: fakeEpisodeService(),
      config,
      logger: silentLogger(),
      providers: [good, bad]
    });

    const result = await service.getSubtitles("anilist:1:e1");

    expect(result.tracks.map((track) => track.url)).toEqual([
      "https://cdn.example/good-en.srt"
    ]);
    expect(result.warnings.join(" ")).toContain("Bad");
  });
});
