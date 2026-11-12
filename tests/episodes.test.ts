import { describe, expect, it, vi } from "vitest";
import { EpisodesService } from "../src/episodes/service.js";
import type { AniListProvider } from "../src/metadata/anilist.js";
import type { MetadataService } from "../src/metadata/service.js";
import type { TmdbProvider } from "../src/metadata/tmdb.js";
import {
  animeFixture,
  silentLogger,
  testCache,
  testConfig
} from "./helpers.js";

function setup(anime = animeFixture()) {
  const config = testConfig();
  const cache = testCache(config);
  const anilist = {
    getStreamingEpisodes: vi.fn()
  } as unknown as AniListProvider;
  const tmdb = {
    getSeasons: vi.fn(),
    getSeasonEpisodes: vi.fn()
  } as unknown as TmdbProvider;
  const metadata = {
    getAnime: vi.fn(async () => ({
      value: anime,
      cached: false,
      stale: false,
      warnings: []
    })),
    getTmdbSeasons: vi.fn(),
    tmdb
  } as unknown as MetadataService;
  const service = new EpisodesService({
    metadata,
    anilist,
    cache,
    config,
    logger: silentLogger()
  });
  return { service, metadata, anilist, tmdb, cache };
}

describe("episode catalogue", () => {
  it("uses TMDB seasons and episode titles when a match exists", async () => {
    const anime = animeFixture({
      id: "anilist:16498",
      anilistId: 16498,
      tmdbId: 1429,
      tmdbMediaType: "tv",
      tmdbMatch: {
        id: 1429,
        mediaType: "tv",
        confidence: 0.95,
        matchedTitle: "Attack on Titan",
        matchedYear: 2013
      }
    });
    const { service, metadata, tmdb } = setup(anime);

    vi.mocked(metadata.getTmdbSeasons).mockResolvedValue([
      {
        seasonNumber: 1,
        name: "Season 1",
        episodeCount: 25,
        airDate: "2013-04-07",
        overview: null,
        poster: null
      },
      {
        seasonNumber: 2,
        name: "Season 2",
        episodeCount: 2,
        airDate: "2017-04-01",
        overview: null,
        poster: null
      }
    ]);
    vi.mocked(tmdb.getSeasonEpisodes).mockResolvedValue([
      {
        seasonNumber: 2,
        episodeNumber: 1,
        title: "Beast Titan",
        overview: "A new threat.",
        airDate: "2017-04-01",
        runtimeMinutes: 24,
        image: "https://tmdb.example/e1.jpg"
      },
      {
        seasonNumber: 2,
        episodeNumber: 2,
        title: "I'm Home",
        overview: null,
        airDate: "2017-04-08",
        runtimeMinutes: 24,
        image: null
      }
    ]);

    const page = await service.list("anilist:16498", { season: 2, page: 1, limit: 50 });

    expect(page.kind).toBe("tv");
    expect(page.source).toBe("tmdb");
    expect(page.seasonNumber).toBe(2);
    expect(page.seasons).toHaveLength(2);
    expect(page.episodes).toHaveLength(2);
    expect(page.episodes[0]).toMatchObject({
      id: "anilist:16498:s2:e1",
      title: "Beast Titan",
      metadataAvailable: true
    });
    expect(page.total).toBe(2);
  });

  it("serves a cached catalogue without calling upstream again", async () => {
    const anime = animeFixture({
      id: "anilist:16498",
      anilistId: 16498,
      tmdbMatch: {
        id: 1429,
        mediaType: "tv",
        confidence: 0.95,
        matchedTitle: "Attack on Titan",
        matchedYear: 2013
      },
      tmdbId: 1429,
      tmdbMediaType: "tv"
    });
    const { service, metadata, tmdb } = setup(anime);
    vi.mocked(metadata.getTmdbSeasons).mockResolvedValue([
      {
        seasonNumber: 1,
        name: "Season 1",
        episodeCount: 1,
        airDate: null,
        overview: null,
        poster: null
      }
    ]);
    vi.mocked(tmdb.getSeasonEpisodes).mockResolvedValue([
      {
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Episode 1",
        overview: null,
        airDate: null,
        runtimeMinutes: 24,
        image: null
      }
    ]);

    await service.list("anilist:16498", { page: 1, limit: 50 });
    const second = await service.list("anilist:16498", { page: 1, limit: 50 });

    expect(second.cached).toBe(true);
    expect(tmdb.getSeasonEpisodes).toHaveBeenCalledTimes(1);
  });

  it("uses AniList episode counts and leaves unknown titles null", async () => {
    const anime = animeFixture({ episodeCount: 3 });
    const { service, anilist } = setup(anime);
    vi.mocked(anilist.getStreamingEpisodes).mockResolvedValue([
      { title: "Episode One", thumbnail: "https://img/1.jpg", url: null, site: "Crunchyroll" },
      { title: null, thumbnail: null, url: null, site: null }
    ]);

    const page = await service.list("anilist:1", { page: 1, limit: 50 });

    expect(page.source).toBe("anilist");
    expect(page.episodes).toHaveLength(3);
    expect(page.episodes[0]?.title).toBe("Episode One");
    expect(page.episodes[1]?.title).toBeNull();
    expect(page.episodes[2]?.metadataAvailable).toBe(false);
    expect(page.complete).toBe(false);
  });

  it("returns one feature entry for a movie", async () => {
    const anime = animeFixture({ format: "MOVIE", episodeCount: 1, titles: { ...animeFixture().titles, preferred: "Naruto the Movie" } });
    const { service } = setup(anime);

    const page = await service.list("anilist:1", { page: 1, limit: 50 });

    expect(page.kind).toBe("movie");
    expect(page.episodes).toHaveLength(1);
    expect(page.episodes[0]).toMatchObject({
      id: "anilist:1:e1",
      kind: "movie",
      title: "Naruto the Movie"
    });
  });

  it("reports an unavailable season clearly", async () => {
    const anime = animeFixture({
      id: "anilist:16498",
      anilistId: 16498,
      tmdbMatch: {
        id: 1429,
        mediaType: "tv",
        confidence: 0.95,
        matchedTitle: "Attack on Titan",
        matchedYear: 2013
      },
      tmdbId: 1429,
      tmdbMediaType: "tv"
    });
    const { service, metadata } = setup(anime);
    vi.mocked(metadata.getTmdbSeasons).mockResolvedValue([
      {
        seasonNumber: 1,
        name: "Season 1",
        episodeCount: 25,
        airDate: null,
        overview: null,
        poster: null
      }
    ]);

    await expect(service.list("anilist:16498", { season: 9, page: 1, limit: 50 })).rejects.toMatchObject({
      code: "season_unavailable",
      status: 400
    });
  });

  it("looks up an episode by its stable id", async () => {
    const anime = animeFixture({
      id: "anilist:16498",
      anilistId: 16498,
      tmdbMatch: {
        id: 1429,
        mediaType: "tv",
        confidence: 0.95,
        matchedTitle: "Attack on Titan",
        matchedYear: 2013
      },
      tmdbId: 1429,
      tmdbMediaType: "tv"
    });
    const { service, metadata, tmdb } = setup(anime);
    vi.mocked(metadata.getTmdbSeasons).mockResolvedValue([
      {
        seasonNumber: 2,
        name: "Season 2",
        episodeCount: 1,
        airDate: null,
        overview: null,
        poster: null
      }
    ]);
    vi.mocked(tmdb.getSeasonEpisodes).mockResolvedValue([
      {
        seasonNumber: 2,
        episodeNumber: 1,
        title: "Beast Titan",
        overview: null,
        airDate: null,
        runtimeMinutes: 24,
        image: null
      }
    ]);

    const result = await service.getEpisode("anilist:16498:s2:e1");
    expect(result.episode.title).toBe("Beast Titan");
  });

  it("uses TMDB seasons for a TMDB-only anime without a stored match", async () => {
    const anime = animeFixture({
      id: "tmdb:1429",
      source: "tmdb",
      anilistId: null,
      malId: null,
      tmdbId: 1429,
      tmdbMediaType: "tv",
      tmdbMatch: null
    });
    const { service, metadata, tmdb } = setup(anime);
    vi.mocked(metadata.getTmdbSeasons).mockResolvedValue([
      {
        seasonNumber: 1,
        name: "Season 1",
        episodeCount: 1,
        airDate: null,
        overview: null,
        poster: null
      }
    ]);
    vi.mocked(tmdb.getSeasonEpisodes).mockResolvedValue([
      {
        seasonNumber: 1,
        episodeNumber: 1,
        title: "To You, in 2000 Years",
        overview: null,
        airDate: null,
        runtimeMinutes: 24,
        image: null
      }
    ]);

    const page = await service.list("tmdb:1429", { season: 1, page: 1, limit: 50 });

    expect(page.source).toBe("tmdb");
    expect(page.episodes[0]).toMatchObject({
      id: "tmdb:1429:s1:e1",
      title: "To You, in 2000 Years"
    });
    expect(metadata.getTmdbSeasons).toHaveBeenCalled();
  });

  it("returns episode_not_found for a number outside the catalogue", async () => {
    const { service, anilist } = setup(animeFixture({ episodeCount: 1 }));
    vi.mocked(anilist.getStreamingEpisodes).mockResolvedValue([]);

    await expect(service.getEpisode("anilist:1:e99")).rejects.toMatchObject({
      code: "episode_not_found",
      status: 404
    });
  });
});
