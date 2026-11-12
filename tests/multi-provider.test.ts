import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { EpisodesService } from "../src/episodes/service.js";
import { SourcesService } from "../src/sources/service.js";
import type { Source, SourceProvider } from "../src/sources/types.js";
import { animeFixture, fakeContainer, silentLogger, testCache, testConfig } from "./helpers.js";

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

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_1",
    provider: "catalog",
    label: "Sub",
    language: "ja",
    quality: "1080p",
    type: "hls",
    delivery: "stream",
    url: "https://cdn.example/1.m3u8",
    headers: {},
    expiresAt: null,
    temporary: true,
    ...overrides
  };
}

function mockProvider(
  id: string,
  sources: unknown,
  options: { configured?: boolean; name?: string; fail?: boolean } = {}
): SourceProvider {
  return {
    id,
    name: options.name ?? id,
    isConfigured: () => options.configured ?? true,
    getSources: vi.fn(async () => {
      if (options.fail) throw new Error(`${id} is down`);
      return { sources: sources as Source[], warnings: [] };
    })
  };
}

function serviceWith(providers: SourceProvider[]) {
  const config = testConfig();
  return new SourcesService({
    episodeService: fakeEpisodeService(),
    providers,
    cache: testCache(config),
    config,
    logger: silentLogger()
  });
}

describe("multiple independent source providers", () => {
  it("merges two providers and deduplicates equivalent streams across them", async () => {
    const shared = "https://cdn.example/shared.m3u8";
    const service = serviceWith([
      mockProvider("alpha", [
        source({
          id: "alpha-sub",
          provider: "alpha",
          providerName: "Alpha",
          url: shared,
          headers: { Referer: "https://alpha.example/" }
        })
      ]),
      mockProvider("beta", [
        source({
          id: "beta-dup",
          provider: "beta",
          providerName: "Beta",
          url: shared,
          headers: { referer: "https://alpha.example/" }
        }),
        source({
          id: "beta-dub",
          provider: "beta",
          providerName: "Beta",
          label: "Dub",
          quality: "720p",
          language: "en",
          url: "https://cdn.example/dub.m3u8"
        })
      ])
    ]);

    const result = await service.getSources("anilist:1:e1");

    expect(result.providers.map((provider) => provider.id)).toEqual(["alpha", "beta"]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((item) => item.label)).toEqual(["Sub", "Dub"]);
    expect(result.sources[0]).toMatchObject({ provider: "alpha", providerName: "Alpha" });
    expect(result.sources[1]).toMatchObject({ provider: "beta", label: "Dub" });
  });

  it("does not call a provider that is disabled", async () => {
    const disabled = mockProvider("disabled", [source()], { configured: false });
    const enabled = mockProvider("enabled", [source({ provider: "enabled" })]);

    const result = await serviceWith([disabled, enabled]).getSources("anilist:1:e1");

    expect(disabled.getSources).not.toHaveBeenCalled();
    expect(enabled.getSources).toHaveBeenCalledTimes(1);
    expect(result.providers.map((provider) => provider.id)).toEqual(["enabled"]);
    expect(result.sources).toHaveLength(1);
  });

  it("canonicalizes provider output and drops malformed entries with a warning", async () => {
    const service = serviceWith([
      mockProvider("mock", [
        // Lowercase values are accepted and normalized to the public contract.
        {
          id: "valid",
          provider: "mock",
          label: "sub",
          language: "ja",
          quality: "1080p",
          type: "m3u8",
          delivery: "stream",
          url: "https://cdn.example/valid.m3u8",
          headers: { Referer: "https://mock.example/" },
          expiresAt: "2030-01-01T00:00:00.000Z",
          temporary: true
        },
        { id: "bad-url", provider: "mock", label: "Sub", type: "hls", delivery: "stream", url: "ftp://cdn.example/x.m3u8" },
        { id: "bad-delivery", provider: "mock", label: "Sub", type: "hls", delivery: "download", url: "https://cdn.example/x.m3u8" },
        { id: "bad-label", provider: "mock", label: "Unknown", type: "hls", delivery: "stream", url: "https://cdn.example/x.m3u8" },
        { id: "bad-type", provider: "mock", label: "Sub", type: "mkv", delivery: "stream", url: "https://cdn.example/x.m3u8" }
      ])
    ]);

    const result = await service.getSources("anilist:1:e1");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: "valid",
      label: "Sub",
      type: "hls",
      delivery: "stream",
      url: "https://cdn.example/valid.m3u8",
      headers: { Referer: "https://mock.example/" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      temporary: true
    });
    expect(result.warnings.join(" ")).toContain("mock returned 4 unusable source(s)");
  });

  it("keeps one provider's sources when another fails", async () => {
    const result = await serviceWith([
      mockProvider("alpha", [source({ provider: "alpha" })]),
      mockProvider("broken", [], { name: "Broken", fail: true })
    ]).getSources("anilist:1:e1");

    expect(result.sources).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("Broken");
  });

  it("reports every registered provider's status and subtitle capability", async () => {
    const plain = mockProvider("plain", []);
    const withSubtitles: SourceProvider = {
      ...mockProvider("with-subs", []),
      getSubtitles: async () => ({ tracks: [], embedded: [], warnings: [] })
    };

    const app = createApp(
      fakeContainer({ sourceProviders: [plain, withSubtitles] })
    );
    const response = await app.request("/api/status");
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.data.providers.sourceProviders).toEqual([
      { id: "plain", name: "plain", configured: true, subtitles: false },
      { id: "with-subs", name: "with-subs", configured: true, subtitles: true }
    ]);
  });
});
