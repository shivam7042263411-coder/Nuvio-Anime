export interface ParsedEpisodeId {
  prefix: "anilist" | "tmdb";
  animeNumber: number;
  seasonNumber: number | null;
  episodeNumber: number;
}

const EPISODE_ID = /^(anilist|tmdb):(\d+):(?:s(\d+):)?e(\d+)$/;

export function parseEpisodeId(id: string): ParsedEpisodeId | null {
  const match = EPISODE_ID.exec(id);
  if (!match) return null;
  const [, prefix, anime, season, episode] = match;
  if (!prefix || !anime || !episode) return null;
  return {
    prefix: prefix as "anilist" | "tmdb",
    animeNumber: Number(anime),
    seasonNumber: season === undefined ? null : Number(season),
    episodeNumber: Number(episode)
  };
}

export function buildEpisodeId(
  animeId: string,
  seasonNumber: number | null,
  episodeNumber: number
): string {
  return seasonNumber === null
    ? `${animeId}:e${episodeNumber}`
    : `${animeId}:s${seasonNumber}:e${episodeNumber}`;
}
