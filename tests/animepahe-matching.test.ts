import { describe, expect, it } from "vitest";
import {
  normTitle,
  pickBestEntry,
  resolveEpisodePlan,
  uniqueTitles,
  type AnimePaheEntry,
  type MatchProfile
} from "../src/sources/animepahe/matching.js";

function entry(
  session: string,
  title: string,
  options: Partial<Omit<AnimePaheEntry, "session" | "title">> = {}
): AnimePaheEntry {
  return {
    session,
    title,
    type: options.type ?? "TV",
    episodes: options.episodes ?? 12,
    year: options.year ?? 2020,
    status: options.status ?? "Finished"
  };
}

function profile(overrides: Partial<MatchProfile> = {}): MatchProfile {
  return {
    titles: ["Test Anime"],
    year: 2020,
    kind: "tv",
    seasons: [
      { seasonNumber: 1, name: "Season 1", episodeCount: 12 },
      { seasonNumber: 2, name: "Season 2", episodeCount: 12 }
    ],
    ...overrides
  };
}

function searchFor(entries: AnimePaheEntry[], calls?: string[]) {
  return async (query: string) => {
    calls?.push(query);
    return entries;
  };
}

describe("AnimePahe matching", () => {
  it("normalizes titles for comparison", () => {
    expect(normTitle("  Test-Anime: Part 2!! ")).toBe("test anime part 2");
    expect(normTitle(null)).toBe("");
  });

  it("removes duplicate title variants without losing order", () => {
    expect(uniqueTitles(["Test Anime", "test-anime", " Test Anime ", "Test Anime 2"])).toEqual([
      "Test Anime",
      "Test Anime 2"
    ]);
  });

  it("matches the first season and requested episode", async () => {
    const entries = [entry("s1", "Test Anime")];
    const outcome = await resolveEpisodePlan(profile(), false, 1, 5, searchFor(entries));

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({
      entry: { session: "s1" },
      episode: 5,
      season: 1,
      requestedEpisode: 5,
      isMovie: false
    });
  });

  it("matches a named second season instead of the root entry", async () => {
    const entries = [
      entry("s1", "Test Anime", { year: 2020 }),
      entry("s2", "Test Anime Season 2", { year: 2022 })
    ];
    const outcome = await resolveEpisodePlan(profile(), false, 2, 2, searchFor(entries));

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({
      entry: { session: "s2" },
      episode: 2,
      season: 2
    });
  });

  it("matches a TMDB season name such as The Final Season", async () => {
    const entries = [
      entry("s1", "Test Anime", { year: 2020 }),
      entry("final", "Test Anime The Final Season", { year: 2023 })
    ];
    const seasonProfile = profile({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 12 },
        { seasonNumber: 2, name: "The Final Season", episodeCount: 12 }
      ]
    });
    const outcome = await resolveEpisodePlan(
      seasonProfile,
      false,
      2,
      3,
      searchFor(entries)
    );

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({ entry: { session: "final" }, episode: 3 });
  });

  it("walks split-cour entries as one continuous season", async () => {
    const entries = [
      entry("cour1", "Test Anime", { episodes: 12 }),
      entry("cour2", "Test Anime Part 2", { episodes: 12 })
    ];
    const outcome = await resolveEpisodePlan(profile(), false, 1, 15, searchFor(entries));

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({ entry: { session: "cour2" }, episode: 3 });
  });

  it("resolves a movie through its own context", async () => {
    const entries = [entry("movie", "Test Movie", { type: "Movie", episodes: 1, year: 2021 })];
    const movieProfile = profile({
      titles: ["Test Movie"],
      year: 2021,
      kind: "movie",
      seasons: []
    });
    const outcome = await resolveEpisodePlan(movieProfile, true, 1, 1, searchFor(entries));

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({
      entry: { session: "movie" },
      episode: 1,
      season: 1,
      isMovie: true
    });
  });

  it("rejects a TV entry when the central context says movie", async () => {
    const entries = [entry("tv", "Test Movie", { type: "TV", year: 1999 })];
    const movieProfile = profile({
      titles: ["Test Movie"],
      year: 2021,
      kind: "movie",
      seasons: []
    });
    const outcome = await resolveEpisodePlan(movieProfile, true, 1, 1, searchFor(entries));

    expect(outcome.plan).toBeNull();
    expect(outcome.failure).toBe("movie_mismatch");
  });

  it("matches a season 0 special entry", async () => {
    const entries = [
      entry("s1", "Test Anime", { year: 2020 }),
      entry("special", "Test Anime Special", { type: "Special", episodes: 3, year: 2021 })
    ];
    const outcome = await resolveEpisodePlan(profile(), false, 0, 2, searchFor(entries));

    expect(outcome.failure).toBeNull();
    expect(outcome.plan).toMatchObject({
      entry: { session: "special" },
      episode: 2,
      season: 0
    });
  });

  it("reports no search results and no match without inventing an entry", async () => {
    const empty = await resolveEpisodePlan(profile(), false, 1, 1, searchFor([]));
    expect(empty).toEqual({ plan: null, failure: "no_search_results" });

    const unrelated = [
      entry("other", "A Completely Different Show", { year: 1999 })
    ];
    const none = await resolveEpisodePlan(profile(), false, 1, 1, searchFor(unrelated));
    expect(none).toEqual({ plan: null, failure: "no_match" });
  });

  it("reports a missing episode for an entry that is too short", async () => {
    const entries = [entry("s1", "Test Anime", { episodes: 2 })];
    const outcome = await resolveEpisodePlan(profile(), false, 1, 9, searchFor(entries));

    expect(outcome.plan).toBeNull();
    expect(outcome.failure).toBe("no_episode");
  });

  it("searches alternate titles when the first query finds nothing", async () => {
    const calls: string[] = [];
    const entries = [entry("s1", "Test Anime")];
    const alternate = profile({ titles: ["Unrelated", "Test Anime"] });
    const search = async (query: string) => {
      calls.push(query);
      return query === "Test Anime" ? entries : [];
    };

    const outcome = await resolveEpisodePlan(alternate, false, 1, 1, search);

    expect(outcome.plan).not.toBeNull();
    expect(calls).toContain("Unrelated");
    expect(calls).toContain("Test Anime");
  });

  it("picks movie entries above TV entries with the same title", () => {
    const entries = [
      entry("tv", "Test Movie", { type: "TV", year: 2021 }),
      entry("movie", "Test Movie", { type: "Movie", episodes: 1, year: 2021 })
    ];
    const best = pickBestEntry(entries, ["Test Movie"], "movie", 2021);

    expect(best?.entry.session).toBe("movie");
  });
});
