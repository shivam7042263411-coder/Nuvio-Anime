export interface MatchQuery {
  titles: string[];
  year: number | null;
  format: "tv" | "movie";
}

export interface MatchCandidate {
  id: number;
  mediaType: "tv" | "movie";
  titles: string[];
  year: number | null;
  popularity?: number;
}

export interface MatchResult<T extends MatchCandidate> {
  candidate: T;
  score: number;
}

/** Normalize a title for comparison without losing meaningful words. */
export function normalizeTitle(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const overlap = jaccard(leftTokens, rightTokens);

  if (left.includes(right) || right.includes(left)) {
    // A containment match is strong, but shorter generic titles are risky.
    const shorter = Math.min(leftTokens.size, rightTokens.size);
    return Math.min(0.92, 0.72 + Math.min(shorter, 5) * 0.04 + overlap * 0.1);
  }
  return overlap * 0.9;
}

export function bestTitleSimilarity(left: string[], right: string[]): number {
  let best = 0;
  for (const a of left) {
    for (const b of right) {
      best = Math.max(best, titleSimilarity(a, b));
    }
  }
  return best;
}

/**
 * Deterministic, explainable match score.
 * Title dominates, year disambiguates, and a movie/TV mismatch is penalized.
 */
export function scoreCandidate(query: MatchQuery, candidate: MatchCandidate): number {
  const titleScore = bestTitleSimilarity(query.titles, candidate.titles);
  if (titleScore === 0) return 0;

  let yearScore = 0;
  if (query.year !== null && candidate.year !== null) {
    const delta = Math.abs(query.year - candidate.year);
    if (delta === 0) yearScore = 1;
    else if (delta === 1) yearScore = 0.6;
    else if (delta === 2) yearScore = 0.2;
    else yearScore = -0.6;
  }

  const formatPenalty = query.format === candidate.mediaType ? 0 : 0.4;
  const popularity = Math.min(Math.max(candidate.popularity ?? 0, 0), 1000) / 1000;
  const score = titleScore * 0.78 + yearScore * 0.17 + popularity * 0.05 - formatPenalty;

  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

export function pickBestMatch<T extends MatchCandidate>(
  query: MatchQuery,
  candidates: T[],
  threshold = 0.66
): MatchResult<T> | null {
  let best: MatchResult<T> | null = null;

  for (const candidate of candidates) {
    const score = scoreCandidate(query, candidate);
    if (
      !best ||
      score > best.score ||
      (score === best.score && (candidate.popularity ?? 0) > (best.candidate.popularity ?? 0))
    ) {
      best = { candidate, score };
    }
  }

  return best && best.score >= threshold ? best : null;
}
