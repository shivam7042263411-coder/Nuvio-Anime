import { describe, expect, it } from "vitest";
import {
  bestTitleSimilarity,
  normalizeTitle,
  pickBestMatch,
  scoreCandidate,
  titleSimilarity
} from "../src/metadata/matching.js";

describe("metadata matching", () => {
  it("normalizes punctuation, accents and ampersands", () => {
    expect(normalizeTitle("Kaguya-sama: Love is War & More!")).toBe(
      "kaguya sama love is war and more"
    );
    expect(normalizeTitle("Pokémon")).toBe("pokemon");
  });

  it("scores exact titles highest", () => {
    expect(titleSimilarity("Naruto", "Naruto")).toBe(1);
    expect(bestTitleSimilarity(["Naruto"], ["Naruto Shippuden"])).toBeGreaterThan(0.7);
  });

  it("matches alternate titles when the caller supplies synonyms", () => {
    const score = scoreCandidate(
      {
        titles: ["Shingeki no Kyojin", "Attack on Titan"],
        year: 2013,
        format: "tv"
      },
      {
        id: 1429,
        mediaType: "tv",
        titles: ["Attack on Titan"],
        year: 2013,
        popularity: 500
      }
    );
    expect(score).toBeGreaterThan(0.85);
  });

  it("penalizes a movie/TV format mismatch", () => {
    const query = { titles: ["Naruto"], year: 2004, format: "movie" as const };
    const movie = scoreCandidate(query, {
      id: 1,
      mediaType: "movie",
      titles: ["Naruto"],
      year: 2004
    });
    const tv = scoreCandidate(query, {
      id: 2,
      mediaType: "tv",
      titles: ["Naruto"],
      year: 2004
    });
    expect(movie).toBeGreaterThan(tv);
    expect(tv).toBeLessThan(0.66);
  });

  it("uses the year to disambiguate same-name entries", () => {
    const query = { titles: ["Fate"], year: 2014, format: "tv" as const };
    const winner = pickBestMatch(query, [
      { id: 1, mediaType: "tv", titles: ["Fate"], year: 2006 },
      { id: 2, mediaType: "tv", titles: ["Fate"], year: 2014 }
    ]);
    expect(winner?.candidate.id).toBe(2);
  });

  it("returns null when nothing is close enough", () => {
    const winner = pickBestMatch(
      { titles: ["Naruto"], year: 2002, format: "tv" },
      [{ id: 9, mediaType: "tv", titles: ["Bleach"], year: 2004 }]
    );
    expect(winner).toBeNull();
  });
});
