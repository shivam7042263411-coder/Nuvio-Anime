import type { Pool } from "pg";
import type { TmdbMediaType } from "./types.js";

export interface StoredMatch {
  anilistId: number;
  tmdbId: number;
  mediaType: TmdbMediaType;
  confidence: number;
  matchedTitle: string | null;
  matchedYear: number | null;
}

export interface MatchRepository {
  get(anilistId: number): Promise<StoredMatch | null>;
  save(match: StoredMatch): Promise<void>;
}

export class PostgresMatchRepository implements MatchRepository {
  constructor(private readonly pool: Pool) {}

  async get(anilistId: number): Promise<StoredMatch | null> {
    const result = await this.pool.query<{
      anilist_id: number;
      tmdb_id: number;
      media_type: TmdbMediaType;
      confidence: string | number;
      matched_title: string | null;
      matched_year: number | null;
    }>(
      `select anilist_id, tmdb_id, media_type, confidence, matched_title, matched_year
       from metadata_matches where anilist_id = $1`,
      [anilistId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      anilistId: row.anilist_id,
      tmdbId: row.tmdb_id,
      mediaType: row.media_type,
      confidence: Number(row.confidence),
      matchedTitle: row.matched_title,
      matchedYear: row.matched_year
    };
  }

  async save(match: StoredMatch): Promise<void> {
    await this.pool.query(
      `insert into metadata_matches
         (anilist_id, tmdb_id, media_type, confidence, matched_title, matched_year, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (anilist_id) do update
         set tmdb_id = excluded.tmdb_id,
             media_type = excluded.media_type,
             confidence = excluded.confidence,
             matched_title = excluded.matched_title,
             matched_year = excluded.matched_year,
             updated_at = now()`,
      [
        match.anilistId,
        match.tmdbId,
        match.mediaType,
        match.confidence,
        match.matchedTitle,
        match.matchedYear
      ]
    );
  }
}
