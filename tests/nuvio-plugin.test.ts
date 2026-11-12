import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const pluginSource = readFileSync(
  new URL("../nuvio-plugin/nuvio-anime-api.js", import.meta.url),
  "utf8"
);

interface FetchCall {
  url: string;
  options: { method?: string; headers?: Record<string, string> } | undefined;
}

interface LoadedPlugin {
  getStreams: (
    tmdbId: unknown,
    mediaType: unknown,
    season: unknown,
    episode: unknown
  ) => Promise<any[]>;
  logs: Array<{ level: string; message: string }>;
  calls: FetchCall[];
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  };
}

function loadPlugin(
  handler: (call: FetchCall) => ReturnType<typeof jsonResponse> | ReturnType<typeof textResponse>
): LoadedPlugin {
  const logs: LoadedPlugin["logs"] = [];
  const calls: FetchCall[] = [];
  const context = createContext({
    module: { exports: {} as Record<string, unknown> },
    exports: {},
    ANIME_API_URL: "https://api.test",
    console: {
      log: (message: unknown) => logs.push({ level: "info", message: String(message) }),
      error: (message: unknown) => logs.push({ level: "error", message: String(message) })
    },
    fetch: async (url: string, options?: FetchCall["options"]) => {
      const call = { url, options };
      calls.push(call);
      return handler(call);
    }
  });

  runInContext(pluginSource, context, { filename: "nuvio-anime-api.js" });

  return {
    getStreams: context.module.exports.getStreams as LoadedPlugin["getStreams"],
    logs,
    calls
  };
}

function payloadFor(call: FetchCall, data: Record<string, unknown>) {
  if (call.url.includes("/api/anime/")) {
    return jsonResponse({ data: { titles: { preferred: "Test Anime" } } });
  }
  if (call.url.includes("/sources")) {
    return jsonResponse({ data: { sources: data.sources ?? [] } });
  }
  if (call.url.includes("/subtitles")) {
    return jsonResponse({ data: { tracks: data.tracks ?? [] } });
  }
  return jsonResponse({ error: { code: "not_found" } }, 404);
}

describe("Nuvio adapter (QuickJS-compatible plugin)", () => {
  it("is plain plugin code without module imports or Node-only APIs", () => {
    expect(pluginSource).not.toMatch(/\brequire\s*\(/);
    expect(pluginSource).not.toMatch(/^\s*import\s/m);
    expect(pluginSource).not.toMatch(/^\s*export\s/m);
    expect(pluginSource).toContain("module.exports");
  });

  it("maps API sources and external subtitles into Nuvio stream results", async () => {
    const plugin = loadPlugin((call) =>
      payloadFor(call, {
        sources: [
          {
            id: "animepahe:sub",
            provider: "animepahe",
            providerName: "AnimePahe",
            label: "Sub",
            language: "ja",
            quality: "1080p",
            type: "hls",
            delivery: "stream",
            url: "https://cdn.example/sub.m3u8",
            headers: { Referer: "https://kwik.cx/" },
            expiresAt: null,
            temporary: true,
            name: "SubsPlease",
            size: null
          },
          {
            id: "animepahe:dl",
            provider: "animepahe",
            providerName: "AnimePahe",
            label: "DL",
            language: "ja",
            quality: "1080p",
            type: "mp4",
            delivery: "stream",
            url: "https://cdn.example/dl.mp4",
            headers: {},
            expiresAt: null,
            temporary: true,
            name: "BluRay",
            size: "800MB"
          }
        ],
        tracks: [
          {
            id: "animepahe:en",
            language: "en",
            label: "English",
            format: "vtt",
            url: "https://cdn.example/en.vtt",
            headers: { Referer: "https://kwik.cx/" },
            isDefault: false,
            source: "animepahe",
            selectable: true
          }
        ]
      })
    );

    const results = await plugin.getStreams(42, "tv", 2, 3);

    expect(results).toHaveLength(2);
    expect(results.map((item) => item.type)).toEqual(["m3u8", "mp4"]);
    expect(results[0]).toMatchObject({
      title: "Test Anime - S02E03",
      quality: "1080p",
      language: "Sub",
      provider: "Anime API",
      size: null,
      headers: { Referer: "https://kwik.cx/" },
      subtitles: [
        {
          url: "https://cdn.example/en.vtt",
          lang: "en",
          language: "en",
          name: "English",
          addonName: "Anime API",
          isStreamProvided: false
        }
      ]
    });
    expect(results[0]?.name).toContain("SubsPlease");
    expect(results[1]).toMatchObject({
      language: "DL",
      size: "800MB",
      headers: null
    });
    expect(results[1]?.name).toContain("BluRay");

    expect(plugin.calls.map((call) => call.url)).toEqual([
      "https://api.test/api/anime/tmdb:42",
      "https://api.test/api/episode/tmdb%3A42%3As2%3Ae3/sources",
      "https://api.test/api/episode/tmdb%3A42%3As2%3Ae3/subtitles"
    ]);
  });

  it("maps AniList ids and embedded absolute episodes into API requests", async () => {
    const plugin = loadPlugin((call) =>
      payloadFor(call, {
        sources: [
          {
            label: "Sub",
            type: "hls",
            delivery: "stream",
            url: "https://cdn.example/anilist.m3u8"
          }
        ]
      })
    );

    const explicit = await plugin.getStreams("anilist:16498:1", "tv", null, 1);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.title).toBe("Test Anime - E01");
    expect(plugin.calls.map((call) => call.url)).toEqual([
      "https://api.test/api/anime/anilist:16498",
      "https://api.test/api/episode/anilist%3A16498%3Ae1/sources",
      "https://api.test/api/episode/anilist%3A16498%3Ae1/subtitles"
    ]);

    plugin.calls.length = 0;
    const embedded = await plugin.getStreams("anilist:16498:26", "tv", null, null);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]?.title).toBe("Test Anime - E26");
    expect(plugin.calls.map((call) => call.url)).toEqual([
      "https://api.test/api/anime/anilist:16498",
      "https://api.test/api/episode/anilist%3A16498%3Ae26/sources",
      "https://api.test/api/episode/anilist%3A16498%3Ae26/subtitles"
    ]);
  });

  it("does not turn a null season into season 0", async () => {
    const plugin = loadPlugin((call) => payloadFor(call, {}));

    await plugin.getStreams(1429, "tv", null, 26);

    expect(plugin.calls.map((call) => call.url)).toEqual([
      "https://api.test/api/anime/tmdb:1429",
      "https://api.test/api/episode/tmdb%3A1429%3Ae26/sources",
      "https://api.test/api/episode/tmdb%3A1429%3Ae26/subtitles"
    ]);
    expect(plugin.calls.some((call) => call.url.includes("%3As0%3A"))).toBe(false);
  });

  it("declares anime alongside movie and tv in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../nuvio-plugin/manifest.json", import.meta.url), "utf8")
    ) as { scrapers: Array<{ supportedTypes: string[] }> };

    expect(manifest.scrapers[0]?.supportedTypes).toEqual(
      expect.arrayContaining(["movie", "tv", "anime"])
    );
  });

  it("drops expired, non-stream, duplicate and malformed sources", async () => {
    const plugin = loadPlugin((call) =>
      payloadFor(call, {
        sources: [
          {
            label: "Sub",
            url: "https://cdn.example/expired.m3u8",
            type: "hls",
            delivery: "stream",
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          },
          {
            label: "Sub",
            url: "https://cdn.example/download.mp4",
            type: "mp4",
            delivery: "download"
          },
          {
            label: "Sub",
            url: "https://cdn.example/ok.m3u8",
            type: "hls",
            delivery: "stream"
          },
          {
            label: "Sub",
            url: "https://cdn.example/ok.m3u8",
            type: "hls",
            delivery: "stream"
          },
          {
            label: "Sub",
            type: "hls",
            delivery: "stream"
          }
        ]
      })
    );

    const results = await plugin.getStreams(42, "movie", null, null);

    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://cdn.example/ok.m3u8");
    expect(results[0]?.title).toBe("Test Anime");
  });

  it("returns an empty list instead of failing when the API is unavailable", async () => {
    const serverError = loadPlugin(() => textResponse("upstream down", 500));
    expect(await serverError.getStreams(42, "tv", 1, 1)).toEqual([]);
    expect(serverError.logs.some((entry) => entry.level === "error")).toBe(true);

    const rejected = loadPlugin(() => {
      throw new Error("network down");
    });
    expect(await rejected.getStreams(42, "tv", 1, 1)).toEqual([]);

    const invalidJson = loadPlugin(() => textResponse("<html>not json</html>"));
    expect(await invalidJson.getStreams(42, "tv", 1, 1)).toEqual([]);
  });

  it("returns no streams when the API is not configured", async () => {
    const plugin = loadPlugin(() => jsonResponse({ data: {} }));
    const context = createContext({
      module: { exports: {} },
      exports: {},
      console: { log: () => undefined, error: () => undefined },
      fetch: async () => jsonResponse({ data: {} })
    });
    runInContext(pluginSource, context, { filename: "nuvio-anime-api.js" });
    const unconfigured = context.module.exports.getStreams as LoadedPlugin["getStreams"];

    expect(await unconfigured(42, "tv", 1, 1)).toEqual([]);
    expect(plugin.calls).toEqual([]);
  });
});
