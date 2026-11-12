import type { Pool } from "pg";
import type { CacheBackend, CacheRecord } from "./types.js";

/**
 * Shared TTL cache in Postgres. Antideploy does not provide Redis, so Postgres
 * is the durable second tier. It survives deploys and app sleep.
 */
export class PostgresCache implements CacheBackend {
  private writes = 0;

  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<CacheRecord | undefined> {
    const result = await this.pool.query<{
      value: unknown;
      expires_at: string | Date;
      stale_until: string | Date;
    }>(
      "select value, expires_at, stale_until from cache_entries where key = $1 and stale_until > now()",
      [key]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      value: row.value,
      expiresAt: new Date(row.expires_at).getTime(),
      staleUntil: new Date(row.stale_until).getTime()
    };
  }

  async set(key: string, record: CacheRecord, ttlMs: number): Promise<void> {
    await this.pool.query(
      `insert into cache_entries (key, value, expires_at, stale_until)
       values ($1, $2::jsonb, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0))
       on conflict (key) do update
         set value = excluded.value,
             expires_at = excluded.expires_at,
             stale_until = excluded.stale_until`,
      [
        key,
        JSON.stringify(record.value),
        record.expiresAt,
        Math.max(record.staleUntil, record.expiresAt + ttlMs)
      ]
    );

    this.writes += 1;
    if (this.writes % 100 === 0) {
      void this.prune().catch(() => undefined);
    }
  }

  async delete(key: string): Promise<void> {
    await this.pool.query("delete from cache_entries where key = $1", [key]);
  }

  async prune(): Promise<number> {
    const result = await this.pool.query(
      "delete from cache_entries where stale_until <= now()"
    );
    return result.rowCount ?? 0;
  }
}
