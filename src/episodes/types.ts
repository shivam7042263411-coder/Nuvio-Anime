export type EpisodeKind = "tv" | "movie" | "special";

export interface Episode {
  id: string;
  animeId: string;
  seasonNumber: number | null;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
  image: string | null;
  kind: EpisodeKind;
  /** The episode is known to exist in the catalogue. */
  available: boolean;
  /** A title/image/description was supplied by the metadata provider. */
  metadataAvailable: boolean;
  source: "tmdb" | "anilist";
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  airDate: string | null;
  overview: string | null;
  poster: string | null;
}

export interface EpisodeCatalogue {
  animeId: string;
  kind: "tv" | "movie";
  source: "tmdb" | "anilist";
  seasons: SeasonSummary[];
  episodes: Episode[];
  complete: boolean;
  warnings: string[];
}
