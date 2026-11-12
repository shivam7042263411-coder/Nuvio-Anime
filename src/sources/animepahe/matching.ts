/**
 * AnimePahe title, season and episode matching.
 *
 * The central API owns metadata identity. This module only decides which
 * AnimePahe entry/release corresponds to the already-resolved anime episode.
 */

export interface AnimePaheEntry {
  session: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  status: string;
}

export interface MatchSeason {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
}

export interface MatchProfile {
  titles: string[];
  year: number | null;
  kind: "movie" | "tv";
  seasons: MatchSeason[];
}

export interface EpisodePlan {
  entry: AnimePaheEntry;
  episode: number;
  season: number;
  requestedEpisode: number;
  isMovie: boolean;
}

export type PlanFailure =
  | "no_search_results"
  | "no_match"
  | "movie_mismatch"
  | "no_specials"
  | "no_episode";

export interface PlanOutcome {
  plan: EpisodePlan | null;
  failure: PlanFailure | null;
}

export type EntrySearch = (query: string) => Promise<AnimePaheEntry[]>;

const MAX_TITLE_QUERIES = 4;

export function normTitle(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startsWithTitle(normalized: string, prefix: string): boolean {
  if (!normalized || !prefix) return false;
  if (!normalized.startsWith(prefix)) return false;
  return normalized.length === prefix.length || normalized.charAt(prefix.length) === " ";
}

export function parseIntSafe(value: unknown): number {
  const number = parseInt(String(value ?? ""), 10);
  return Number.isNaN(number) ? 0 : number;
}

function ordinal(value: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const remainder = value % 100;
  return `${value}${suffixes[(remainder - 20) % 10] ?? suffixes[remainder] ?? suffixes[0]}`;
}

function uniqueEntries(entries: AnimePaheEntry[]): AnimePaheEntry[] {
  const seen = new Set<string>();
  const out: AnimePaheEntry[] = [];
  for (const entry of entries) {
    if (!entry.session || seen.has(entry.session)) continue;
    seen.add(entry.session);
    out.push(entry);
  }
  return out;
}

function mergeEntries(first: AnimePaheEntry[], second: AnimePaheEntry[]): AnimePaheEntry[] {
  return uniqueEntries([...first, ...second]);
}

function uniqueTitles(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const title = String(value ?? "").trim();
    const key = normTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

function scoreTitle(title: string, query: string): number {
  const normalizedTitle = normTitle(title);
  const normalizedQuery = normTitle(query);
  if (!normalizedTitle || !normalizedQuery) return -1_000_000;

  if (normalizedTitle === normalizedQuery) return 100;

  if (startsWithTitle(normalizedTitle, normalizedQuery)) {
    const rest = normalizedTitle.substring(normalizedQuery.length).trim();
    if (!rest) return 100;
    const words = rest.split(" ").length;
    return 65 - Math.min(25, words * 5);
  }

  if (normalizedTitle.includes(normalizedQuery)) return 30;

  const queryWords = normalizedQuery.split(" ");
  const titleWords = normalizedTitle.split(" ");
  let hits = 0;
  for (const word of queryWords) {
    if (titleWords.includes(word)) hits += 1;
  }

  return queryWords.length ? Math.round((20 * hits) / queryWords.length) : 0;
}

function entryYear(entry: AnimePaheEntry): number {
  if (entry.year) return entry.year;
  const match = entry.title.match(/\((\d{4})\)/);
  return match?.[1] ? parseIntSafe(match[1]) : 0;
}

export function pickBestEntry(
  entries: AnimePaheEntry[],
  titles: string[],
  kind: "movie" | "tv",
  year: number | null,
  options: { excludeSpecials?: boolean } = {}
): { entry: AnimePaheEntry; score: number } | null {
  let best: AnimePaheEntry | null = null;
  let bestScore = -1_000_000;

  for (const entry of entries) {
    let score = -1_000_000;
    for (const title of titles) {
      const candidate = scoreTitle(entry.title, title);
      if (candidate > score) score = candidate;
    }
    if (score === -1_000_000) continue;

    const candidateYear = entryYear(entry);
    if (year && candidateYear) {
      if (candidateYear === year) score += 15;
      else if (Math.abs(candidateYear - year) <= 1) score += 6;
      else score -= 12;
    }

    const type = entry.type.toLowerCase();
    const normalizedTitle = normTitle(entry.title);

    if (kind === "movie") {
      if (type.includes("movie")) score += 25;
      else if (type.includes("tv")) score -= 10;
    } else {
      if (type.includes("tv")) score += 8;
      else if (type.includes("movie")) score -= 20;
      if (type.includes("ova") || type.includes("special")) score -= 10;
    }

    if (
      options.excludeSpecials &&
      /(?:^|\s)(special|specials|ova|ona)(?:\s|$)/.test(normalizedTitle)
    ) {
      score -= 30;
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (!best || bestScore < 40) return null;
  return { entry: best, score: bestScore };
}

function partRank(title: string, rootNormalized: string): number {
  const normalized = normTitle(title);
  const rest = normalized.substring(rootNormalized.length).trim();
  if (!rest) return 1;

  let match = rest.match(/part\s*(\d+)/);
  if (match?.[1]) return parseIntSafe(match[1]);

  match = rest.match(/cour\s*(\d+)/);
  if (match?.[1]) return parseIntSafe(match[1]);

  if (rest.includes("final chapter")) return 90;

  match = rest.match(/(\d+)\s*(st|nd|rd|th)\s*season/);
  if (match?.[1]) return parseIntSafe(match[1]);

  match = rest.match(/^(\d+)\b/);
  if (match?.[1]) return parseIntSafe(match[1]);

  return 2;
}

function isLaterSeasonTitle(normalized: string): boolean {
  return /(?:^|\s)(?:final season|final chapter|season\s*(?:[2-9]|\d{2,})|(?:[2-9]|\d{2,})\s*(?:st|nd|rd|th)\s*season)(?:\s|$)/.test(
    normalized
  );
}

function isNonSeriesTitle(normalized: string): boolean {
  return /(?:^|\s)(?:movie|recap|special|specials|ova|ona|picture drama|compilation)(?:\s|$)/.test(
    normalized
  );
}

function chainAllowed(normalized: string, prefix: string, seasonNumber: number): boolean {
  const rest = normalized.substring(prefix.length).trim();
  if (!rest) return true;

  if (/^(movie|recap|special|specials|ova|ona|short|picture drama|compilation|dub|sub)\b/.test(rest)) {
    return false;
  }

  if (seasonNumber === 1) {
    if (/^(season\s*(?:[2-9]|\d{2,})|(?:[2-9]|\d{2,})\s*(?:st|nd|rd|th)\s*season)\b/.test(rest)) {
      return false;
    }
  }

  return true;
}

function buildChain(entries: AnimePaheEntry[], prefix: string, seasonNumber: number): AnimePaheEntry[] {
  if (!prefix) return [];

  const matches = entries.filter((entry) => {
    const normalized = normTitle(entry.title);
    return startsWithTitle(normalized, prefix) && chainAllowed(normalized, prefix, seasonNumber);
  });

  if (matches.length === 0) return [];

  matches.sort((a, b) => {
    const left = normTitle(a.title);
    const right = normTitle(b.title);
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  });

  const root = normTitle(matches[0]!.title);
  const chain: AnimePaheEntry[] = [];

  for (const entry of matches) {
    const normalized = normTitle(entry.title);
    const rest = normalized.substring(prefix.length).trim();
    if (normalized === root || /^(part|cour|final chapter|the final chapter|\d)/.test(rest)) {
      chain.push(entry);
    }
  }

  chain.sort((a, b) => partRank(a.title, root) - partRank(b.title, root));
  return chain;
}

function planInChain(
  chain: AnimePaheEntry[],
  episodeNumber: number
): { entry: AnimePaheEntry; episode: number } | null {
  let offset = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]!;
    const episodes = entry.episodes;
    if (episodes > 0) {
      if (episodeNumber <= offset + episodes) {
        return { entry, episode: episodeNumber - offset };
      }
      offset += episodes;
    } else {
      if (index === chain.length - 1) {
        return { entry, episode: episodeNumber - offset };
      }
      return null;
    }
  }

  return null;
}

function seasonPrefixes(baseTitle: string, seasonMeta: MatchSeason | null, seasonNumber: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(value: string): void {
    const normalized = normTitle(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  }

  const name = seasonMeta?.name ?? "";
  if (name && !/^specials?$/i.test(name)) {
    add(`${baseTitle} ${name}`);
    add(`${baseTitle} ${name.replace(/^the\s+/i, "")}`);
  }

  add(`${baseTitle} ${ordinal(seasonNumber)} season`);
  add(`${baseTitle} season ${seasonNumber}`);
  add(`${baseTitle} part ${seasonNumber}`);
  add(`${baseTitle} ${seasonNumber}`);

  return out;
}

function baseTitles(profile: MatchProfile, root: AnimePaheEntry | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(value: string): void {
    const normalized = normTitle(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(value);
  }

  if (root) add(root.title);
  for (const title of profile.titles) add(title);

  return out;
}

function findSeason(profile: MatchProfile, seasonNumber: number): MatchSeason | null {
  return profile.seasons.find((season) => season.seasonNumber === seasonNumber) ?? null;
}

function previousEpisodes(profile: MatchProfile, seasonNumber: number): number {
  let total = 0;
  for (const season of profile.seasons) {
    if (season.seasonNumber >= 1 && season.seasonNumber < seasonNumber) {
      total += season.episodeCount;
    }
  }
  return total;
}

function isBaseEntry(root: AnimePaheEntry, profile: MatchProfile): boolean {
  const normalized = normTitle(root.title);
  return profile.titles.some((title) => normTitle(title) === normalized);
}

function planForSeason(
  entries: AnimePaheEntry[],
  root: AnimePaheEntry,
  profile: MatchProfile,
  seasonNumber: number,
  targetEpisode: number
): { entry: AnimePaheEntry; episode: number } | null {
  const seasonMeta = findSeason(profile, seasonNumber);
  const bases = baseTitles(profile, root);
  const prefixes: string[] = [];
  const seen = new Set<string>();

  function addPrefix(value: string): void {
    const normalized = normTitle(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    prefixes.push(normalized);
  }

  for (const base of bases) {
    if (seasonNumber === 1) {
      const baseNormalized = normTitle(base);
      if (isLaterSeasonTitle(baseNormalized) || isNonSeriesTitle(baseNormalized)) continue;

      addPrefix(base);
      addPrefix(`${base} season 1`);
      addPrefix(`${base} ${ordinal(1)} season`);

      if (seasonMeta?.name && !/^season\s*1$/i.test(seasonMeta.name)) {
        addPrefix(`${base} ${seasonMeta.name}`);
        addPrefix(`${base} ${seasonMeta.name.replace(/^the\s+/i, "")}`);
      }
    } else {
      for (const generated of seasonPrefixes(base, seasonMeta, seasonNumber)) {
        addPrefix(generated);
      }
    }
  }

  for (const prefix of prefixes) {
    const chain = buildChain(entries, prefix, seasonNumber);
    if (chain.length === 0) continue;
    const chainPlan = planInChain(chain, targetEpisode);
    if (chainPlan) return chainPlan;
  }

  if (seasonNumber > 1) {
    const previous = previousEpisodes(profile, seasonNumber);
    if (previous > 0) {
      const absolute = previous + targetEpisode;
      const rootEpisodes = root.episodes;
      const canUseAbsolute =
        isBaseEntry(root, profile) &&
        (rootEpisodes >= absolute || (rootEpisodes === 0 && root.status.toLowerCase().includes("airing")));

      if (canUseAbsolute) {
        const absolutePlan = planInChain([root], absolute);
        if (absolutePlan) return absolutePlan;
      }
    }
    return null;
  }

  const rootNormalized = normTitle(root.title);
  const rootAllowed = bases.some((base) => {
    const baseNormalized = normTitle(base);
    if (isLaterSeasonTitle(baseNormalized) || isNonSeriesTitle(baseNormalized)) return false;
    return startsWithTitle(rootNormalized, baseNormalized) && chainAllowed(rootNormalized, baseNormalized, 1);
  });

  if (rootAllowed) return planInChain([root], targetEpisode);
  return null;
}

function planForSpecial(
  entries: AnimePaheEntry[],
  profile: MatchProfile,
  targetEpisode: number
): { entry: AnimePaheEntry; episode: number } | null {
  const bases = baseTitles(profile, null);
  const candidates: AnimePaheEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const normalized = normTitle(entry.title);
    for (const baseTitle of bases) {
      const base = normTitle(baseTitle);
      if (!startsWithTitle(normalized, base)) continue;

      const rest = normalized.substring(base.length).trim();
      if (!/^(special|specials|ova|ona|picture drama|recap|extra|bonus)\b/.test(rest)) continue;

      if (!seen.has(entry.session)) {
        seen.add(entry.session);
        candidates.push(entry);
      }
      break;
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.episodes === 0 && b.episodes !== 0) return 1;
    if (b.episodes === 0 && a.episodes !== 0) return -1;
    return a.episodes - b.episodes;
  });

  for (const candidate of candidates) {
    if (candidate.episodes === 0 || candidate.episodes >= targetEpisode) {
      return { entry: candidate, episode: targetEpisode };
    }
  }

  return null;
}

async function collectEntries(
  profile: MatchProfile,
  seasonNumber: number,
  seasonMeta: MatchSeason | null,
  search: EntrySearch
): Promise<AnimePaheEntry[]> {
  const queries: string[] = [];
  const seenQueries = new Set<string>();

  function add(query: string | null | undefined): void {
    const value = String(query ?? "").trim();
    const normalized = normTitle(value);
    if (!normalized || seenQueries.has(normalized)) return;
    seenQueries.add(normalized);
    queries.push(value);
  }

  const firstTitle = profile.titles[0] ?? "";

  if (profile.kind === "movie") {
    for (const title of profile.titles.slice(0, MAX_TITLE_QUERIES)) add(title);
  } else {
    add(profile.titles[0]);
    add(profile.titles[1]);

    if (seasonNumber === 0) {
      if (firstTitle) {
        add(`${firstTitle} Special`);
        add(`${firstTitle} OVA`);
      }
    } else if (seasonNumber > 1) {
      if (firstTitle && seasonMeta?.name) add(`${firstTitle} ${seasonMeta.name}`);
      if (firstTitle) {
        add(`${firstTitle} Season ${seasonNumber}`);
        add(`${firstTitle} ${ordinal(seasonNumber)} Season`);
      }
    } else if (firstTitle && seasonMeta?.name && !/^season\s*1$/i.test(seasonMeta.name)) {
      add(`${firstTitle} ${seasonMeta.name}`);
    }
  }

  const entries: AnimePaheEntry[] = [];
  let lastError: unknown = null;

  for (const query of queries.slice(0, MAX_TITLE_QUERIES)) {
    try {
      entries.push(...(await search(query)));
    } catch (error) {
      lastError = error;
    }
  }

  if (entries.length === 0) {
    for (const title of profile.titles.slice(0, MAX_TITLE_QUERIES)) {
      const normalized = normTitle(title);
      if (!normalized || seenQueries.has(normalized)) continue;
      try {
        entries.push(...(await search(title)));
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (entries.length === 0 && lastError) throw lastError;
  return uniqueEntries(entries);
}

/**
 * Resolve the AnimePahe entry and release number for a centrally resolved
 * episode. No metadata provider is called here; the profile is already built.
 */
export async function resolveEpisodePlan(
  profile: MatchProfile,
  isMovie: boolean,
  season: number | null | undefined,
  episode: number,
  search: EntrySearch
): Promise<PlanOutcome> {
  let seasonNumber = season === null || season === undefined ? 1 : parseIntSafe(season);
  if (seasonNumber < 0) seasonNumber = 0;

  let targetEpisode = parseIntSafe(episode);
  if (targetEpisode < 1) targetEpisode = 1;

  if (isMovie) {
    const entries = await collectEntries(
      { ...profile, kind: "movie" },
      1,
      null,
      search
    );
    let best = pickBestEntry(entries, profile.titles, "movie", profile.year);
    if (!best) return { plan: null, failure: "no_match" };

    const movieNormalized = normTitle(best.entry.title);
    const exactMovie = profile.titles.some((title) => normTitle(title) === movieNormalized);
    const type = best.entry.type.toLowerCase();
    const entryYearValue = entryYear(best.entry);

    if (!type.includes("movie") && !(exactMovie && profile.year !== null && entryYearValue === profile.year)) {
      return { plan: null, failure: "movie_mismatch" };
    }

    return {
      plan: {
        entry: best.entry,
        episode: 1,
        season: 1,
        requestedEpisode: 1,
        isMovie: true
      },
      failure: null
    };
  }

  const seasonMeta = findSeason(profile, seasonNumber);
  const entries = await collectEntries(profile, seasonNumber, seasonMeta, search);

  if (entries.length === 0) return { plan: null, failure: "no_search_results" };

  if (seasonNumber === 0) {
    const special = planForSpecial(entries, profile, targetEpisode);
    if (!special) return { plan: null, failure: "no_specials" };
    return {
      plan: {
        entry: special.entry,
        episode: special.episode,
        season: 0,
        requestedEpisode: targetEpisode,
        isMovie: false
      },
      failure: null
    };
  }

  const rootBest = pickBestEntry(entries, profile.titles, "tv", profile.year, {
    excludeSpecials: true
  });
  if (!rootBest) return { plan: null, failure: "no_match" };

  const plan = planForSeason(entries, rootBest.entry, profile, seasonNumber, targetEpisode);
  if (!plan) return { plan: null, failure: "no_episode" };

  return {
    plan: {
      entry: plan.entry,
      episode: plan.episode,
      season: seasonNumber,
      requestedEpisode: targetEpisode,
      isMovie: false
    },
    failure: null
  };
}

export { uniqueTitles };
