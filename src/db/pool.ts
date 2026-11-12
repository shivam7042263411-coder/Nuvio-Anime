import pg from "pg";
import type { Logger } from "../logger.js";

export function createPool(databaseUrl: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "animepahe-api"
  });

  pool.on("error", (error) => {
    logger.error("postgres pool error", { error });
  });

  return pool;
}

export async function checkDatabase(
  pool: pg.Pool,
  logger?: Logger
): Promise<{
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}> {
  const start = Date.now();
  try {
    await pool.query("select 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    // The raw driver message can name the host, user or database. Keep it in
    // the server log and return a stable message to unauthenticated callers.
    logger?.warn("database health check failed", { error });
    return {
      ok: false,
      latencyMs: null,
      error: "database check failed"
    };
  }
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
