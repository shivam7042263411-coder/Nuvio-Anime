import { describe, expect, it, vi } from "vitest";
import type { TextRequest, TextResponse } from "../src/http/client.js";
import type { AnimePaheHttp } from "../src/sources/animepahe/scraper.js";
import { AnimePaheProvider } from "../src/sources/animepahe/provider.js";
import type { AnimeMetadata } from "../src/metadata/types.js";
import type { Episode } from "../src/episodes/types.js";
import type { TmdbSeasonSummary } from "../src/metadata/tmdb.js";
import { animeFixture, silentLogger, testConfig } from "./helpers.js";

type Json = unknown;

interface FakeState {
  searchResults: Json[];
  searchBlocked: boolean;
  releases: Record<string, Record<number, { data: Json[]; last_page?: number }>>;
  playHtml: string;
  kwikHtml: string | ((url: string) => string);
  hlsMaster: string;
  paheHtml: string;
  kwikDownloadHtml: string;
  kwikPostHtml: string;
  paheBlocked: boolean;
  requests: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>;
}

function response(
  text: string,
  options: { status?: number; url?: string; headers?: Record<string, string> } = {}
): TextResponse {
  const status = options.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: options.url ?? "",
    headers: new Headers(options.headers ?? {}),
    text
  };
}

function json(value: Json, options: { status?: number; url?: string; headers?: Record<string, string> } = {}): TextResponse {
  return response(JSON.stringify(value), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
}

class FakeHttp implements AnimePaheHttp {
  state: FakeState;

  constructor(state: FakeState) {
    this.state = state;
  }

  async text(url: string, request: TextRequest): Promise<TextResponse> {
    this.state.requests.push({
      url,
      method: request.method ?? "GET",
      body: request.body,
      headers: request.headers ?? {}
    });

    if (url.includes("api?m=search")) {
      if (this.state.searchBlocked) {
        return response("<html><head><title>Just a moment</title></head></html>", {
          status: 403,
          url
        });
      }
      return json(this.state.searchResults, { url });
    }

    if (url.includes("api?m=release")) {
      const id = /[?&]id=([^&]+)/.exec(url)?.[1] ?? "";
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      const pages = this.state.releases[decodeURIComponent(id)] ?? {};
      const pageData = pages[page];
      if (pageData) return json({ ...pageData, last_page: pageData.last_page ?? 1 }, { url });
      return json({ data: [], last_page: 1 }, { url });
    }

    if (url.includes("/play/")) {
      return response(this.state.playHtml, { url });
    }

    if (url.includes("pahe.win/")) {
      if (this.state.paheBlocked) {
        return response("<html>Just a moment</html>", { status: 403, url });
      }
      return response(this.state.paheHtml, { url });
    }

    if (url.includes("kwik.cx/d/")) {
      if ((request.method ?? "GET") === "POST") {
        return response(this.state.kwikPostHtml, { url });
      }
      return response(this.state.kwikDownloadHtml, {
        url,
        headers: { "set-cookie": "kwik_session=abc; Path=/" }
      });
    }

    if (url.includes("kwik.cx/f/")) {
      return response("<html>file</html>", { url });
    }

    if (url.includes("kwik.cx/e/")) {
      const body =
        typeof this.state.kwikHtml === "function"
          ? this.state.kwikHtml(url)
          : this.state.kwikHtml;
      return response(body, { url });
    }

    if (url.includes("cdn.example/video.m3u8")) {
      return response(this.state.hlsMaster, { url });
    }

    return response("", { status: 404, url });
  }
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    searchResults: [],
    searchBlocked: false,
    releases: {},
    playHtml: "",
    kwikHtml: kwikPage("https://cdn.example/video.m3u8"),
    hlsMaster: "#EXTM3U\n",
    paheHtml: "",
    kwikDownloadHtml: "",
    kwikPostHtml: "",
    paheBlocked: false,
    requests: [],
    ...overrides
  };
}

function entry(session: string, title: string, type: string, episodes: number, year: number): Json {
  return { session, title, type, episodes, year, status: "Finished" };
}

function release(number: number, session = `ep${number}`): Json {
  return { session, episode: number, episode2: number };
}

function kwikPage(m3u8: string, extra = ""): string {
  return `<html><body><script>var source="${m3u8}";</script>${extra}</body></html>`;
}

function playHtml(options: { sub?: boolean; dub?: boolean; download?: boolean } = {}): string {
  const buttons: string[] = [];
  if (options.sub !== false) {
    buttons.push(
      '<button data-src="https://kwik.cx/e/sub1" data-resolution="1080" data-audio="jpn" data-fansub="SubsPlease" data-av1="0">1080p</button>'
    );
  }
  if (options.dub) {
    buttons.push(
      '<button data-src="https://kwik.cx/e/dub1" data-resolution="720" data-audio="eng" data-fansub="SubsPlease" data-av1="0">720p</button>'
    );
  }
  const download = options.download
    ? '<div id="pickDownload"><a href="https://pahe.win/dl/xyz">BluRay \u00b7 1080p \u00b7 (800MB)</a></div>'
    : "";
  return `<div id="resolutionMenu">${buttons.join("")}</div>${download}`;
}

const TV_SEASONS: TmdbSeasonSummary[] = [
  {
    seasonNumber: 1,
    name: "Season 1",
    episodeCount: 12,
    airDate: null,
    overview: null,
    poster: null
  },
  {
    seasonNumber: 2,
    name: "Season 2",
    episodeCount: 12,
    airDate: null,
    overview: null,
    poster: null
  }
];

function tvAnime(overrides: Partial<AnimeMetadata> = {}): AnimeMetadata {
  return animeFixture({
    id: "anilist:1001",
    anilistId: 1001,
    tmdbId: 1001,
    tmdbMediaType: "tv",
    titles: {
      romaji: "Test Anime",
      english: "Test Anime",
      native: null,
      preferred: "Test Anime"
    },
    season: { name: "WINTER", year: 2020 },
    startDate: { year: 2020, month: 1, day: 1 },
    format: "TV",
    ...overrides
  });
}

function movieAnime(): AnimeMetadata {
  return animeFixture({
    id: "anilist:2001",
    anilistId: 2001,
    tmdbId: 2001,
    tmdbMediaType: "movie",
    format: "MOVIE",
    titles: {
      romaji: "Test Movie",
      english: "Test Movie",
      native: null,
      preferred: "Test Movie"
    },
    season: { name: null, year: 2021 },
    startDate: { year: 2021, month: 5, day: 1 }
  });
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "anilist:1001:s1:e3",
    animeId: "anilist:1001",
    seasonNumber: 1,
    episodeNumber: 3,
    title: null,
    overview: null,
    airDate: null,
    runtimeMinutes: 24,
    image: null,
    kind: "tv",
    available: true,
    metadataAvailable: true,
    source: "tmdb",
    ...overrides
  };
}

function makeProvider(
  state: FakeState,
  options: {
    enabled?: boolean;
    seasons?: TmdbSeasonSummary[];
    anime?: AnimeMetadata;
  } = {}
) {
  const config = testConfig({
    SOURCE_ANIMEPAHE_ENABLED: options.enabled === false ? "false" : "true"
  });
  const http = new FakeHttp(state);
  const provider = new AnimePaheProvider({
    http,
    metadata: {
      getTmdbSeasons: vi.fn(async () => options.seasons ?? TV_SEASONS)
    },
    config,
    logger: silentLogger()
  });
  return { provider, http, config, anime: options.anime ?? tvAnime() };
}

describe("AnimePahe provider", () => {
  it("is disabled unless explicitly enabled", async () => {
    const state = baseState();
    const { provider, anime } = makeProvider(state, { enabled: false });

    expect(provider.id).toBe("animepahe");
    expect(provider.isConfigured()).toBe(false);

    const result = await provider.getSources({ anime, episode: episode() });
    expect(result.sources).toEqual([]);
    expect(result.warnings[0]).toContain("disabled");
  });

  it("normalizes Sub/Dub HLS sources and external subtitles", async () => {
    const state = baseState({
      searchResults: [entry("anime-s1", "Test Anime", "TV", 12, 2020)],
      releases: {
        "anime-s1": {
          1: { data: [release(1), release(2), release(3, "anime-s1-e3")], last_page: 1 }
        }
      },
      playHtml: playHtml({ dub: true }),
      kwikHtml: (url) =>
        kwikPage(
          `https://cdn.example/video.m3u8?stream=${url.includes("dub1") ? "dub" : "sub"}`,
          '<track kind="subtitles" src="/subs/track.en.vtt" srclang="en" label="English">'
        ),
      hlsMaster:
        "#EXTM3U\n" +
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.vtt"\n'
    });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({ anime, episode: episode() });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      provider: "animepahe",
      providerName: "AnimePahe",
      label: "Sub",
      language: "ja",
      quality: "1080p",
      type: "hls",
      delivery: "stream",
      temporary: true,
      name: "SubsPlease"
    });
    expect(result.sources[0]?.headers.Referer).toBe("https://kwik.cx/");
    expect(result.sources[1]).toMatchObject({ label: "Dub", language: "en", quality: "720p" });
    expect(result.sources[0]?.id).toMatch(/^animepahe:/);

    const subtitles = await provider.getSubtitles({ anime, episode: episode() });
    expect(subtitles.embedded).toEqual([]);
    expect(subtitles.tracks.map((track) => track.url).sort()).toEqual([
      "https://cdn.example/subs/en.vtt",
      "https://kwik.cx/subs/track.en.vtt"
    ]);
    expect(subtitles.tracks.every((track) => track.selectable)).toBe(true);
    expect(subtitles.tracks.every((track) => track.source === "animepahe")).toBe(true);
    expect(subtitles.tracks[0]?.headers.Referer).toBe("https://kwik.cx/");

    // Sources and subtitles share one resolution instead of scraping twice.
    const searchCallsBefore = state.requests.filter((request) => request.url.includes("m=search")).length;
    await provider.getSources({ anime, episode: episode() });
    const searchCallsAfter = state.requests.filter((request) => request.url.includes("m=search")).length;
    expect(searchCallsAfter).toBe(searchCallsBefore);
  });

  it("matches a named second season instead of season 1", async () => {
    const state = baseState({
      searchResults: [
        entry("anime-s1", "Test Anime", "TV", 12, 2020),
        entry("anime-s2", "Test Anime Season 2", "TV", 12, 2022)
      ],
      releases: {
        "anime-s2": {
          1: { data: [release(1, "s2-e1"), release(2, "s2-e2")], last_page: 1 }
        }
      },
      playHtml: playHtml()
    });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({
      anime,
      episode: episode({ id: "anilist:1001:s2:e2", seasonNumber: 2, episodeNumber: 2 })
    });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(state.requests.some((request) => request.url.includes("/play/anime-s2/s2-e2"))).toBe(true);
    expect(state.requests.some((request) => request.url.includes("/play/anime-s1/"))).toBe(false);
  });

  it("resolves a movie through the central movie context", async () => {
    const state = baseState({
      searchResults: [entry("movie-1", "Test Movie (2021)", "Movie", 1, 2021)],
      releases: {
        "movie-1": { 1: { data: [release(1, "movie-ep1")], last_page: 1 } }
      },
      playHtml: playHtml()
    });
    const { provider, anime } = makeProvider(state, { anime: movieAnime(), seasons: [] });

    const result = await provider.getSources({
      anime,
      episode: episode({
        id: "anilist:2001:e1",
        animeId: "anilist:2001",
        seasonNumber: null,
        episodeNumber: 1,
        kind: "movie"
      })
    });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(state.requests.some((request) => request.url.includes("/play/movie-1/movie-ep1"))).toBe(true);
  });

  it("maps DL links to playable streams, never download actions", async () => {
    const state = baseState({
      searchResults: [entry("anime-s1", "Test Anime", "TV", 12, 2020)],
      releases: {
        "anime-s1": { 1: { data: [release(1), release(2, "anime-s1-e2")], last_page: 1 } }
      },
      playHtml: playHtml({ sub: false, download: true }),
      paheHtml: "<html>https://kwik.cx/f/dlid</html>",
      kwikDownloadHtml:
        '<form method="POST" action="https://kwik.cx/d/dlid">' +
        '<input type="hidden" name="_token" value="tok123"></form>',
      kwikPostHtml: "<html>url='https://cdn.example/file.mp4'</html>"
    });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({
      anime,
      episode: episode({ seasonNumber: 1, episodeNumber: 2 })
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      label: "DL",
      delivery: "stream",
      type: "mp4",
      quality: "1080p",
      size: "800MB",
      name: "BluRay · (800MB)"
    });
    expect(result.sources[0]?.url).toBe("https://cdn.example/file.mp4");
    expect(result.sources[0]?.headers.Referer).toBe("https://kwik.cx/");

    const post = state.requests.find(
      (request) => request.method === "POST" && request.url.includes("kwik.cx/d/")
    );
    expect(post?.body).toBe("_token=tok123");
    expect(post?.headers.Cookie ?? "").toContain("kwik_session=abc");
  });

  it("returns empty sources with a warning when no entry matches", async () => {
    const state = baseState({ searchResults: [] });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({ anime, episode: episode() });

    expect(result.sources).toEqual([]);
    expect(result.warnings.join(" ")).toContain("no search results");
  });

  it("reports a Cloudflare challenge instead of bypassing it", async () => {
    const state = baseState({ searchBlocked: true });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({ anime, episode: episode() });

    expect(result.sources).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Cloudflare/i);
  });

  it("does not fail when the release or play page is empty", async () => {
    const noRelease = baseState({
      searchResults: [entry("anime-s1", "Test Anime", "TV", 12, 2020)],
      releases: {}
    });
    const first = await makeProvider(noRelease).provider.getSources({
      anime: tvAnime(),
      episode: episode()
    });
    expect(first.sources).toEqual([]);
    expect(first.warnings.join(" ")).toContain("no release");

    const noSources = baseState({
      searchResults: [entry("anime-s1", "Test Anime", "TV", 12, 2020)],
      releases: { "anime-s1": { 1: { data: [release(1), release(2), release(3)], last_page: 1 } } },
      playHtml: "<html>empty</html>"
    });
    const second = await makeProvider(noSources).provider.getSources({
      anime: tvAnime(),
      episode: episode()
    });
    expect(second.sources).toEqual([]);
    expect(second.warnings.join(" ")).toContain("no Sub/Dub or DL source");
  });

  it("keeps a working Sub stream when the DL option fails", async () => {
    const state = baseState({
      searchResults: [entry("anime-s1", "Test Anime", "TV", 12, 2020)],
      releases: {
        "anime-s1": { 1: { data: [release(1), release(2)], last_page: 1 } }
      },
      playHtml: playHtml({ download: true }),
      paheBlocked: true
    });
    const { provider, anime } = makeProvider(state);

    const result = await provider.getSources({
      anime,
      episode: episode({ seasonNumber: 1, episodeNumber: 1 })
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.label).toBe("Sub");
    expect(result.sources[0]?.type).toBe("hls");
  });
});
