import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Logger } from "../logger.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const LOCK_ID = 7_231_984_551;

export async function runMigrations(pool: Pool, logger: Logger): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      // Ignore hidden files. macOS archives can materialise an AppleDouble
      // companion (._001_init.sql) that also ends in .sql but is not SQL.
      .filter((file) => !file.startsWith(".") && file.endsWith(".sql"))
      .sort();

    const existing = await client.query<{ version: string }>(
      "select version from schema_migrations"
    );
    const done = new Set(existing.rows.map((row) => row.version));

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await readFile(`${MIGRATIONS_DIR}${file}`, "utf8");
      logger.info("applying migration", { migration: file });
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }

  return applied;
}

/** Wake a suspended database and tolerate a few transient connection failures. */
export async function migrateWithRetry(
  pool: Pool,
  logger: Logger,
  attempts = 5
): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runMigrations(pool, logger);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn("migration attempt failed, retrying", {
        attempt,
        delayMs: delay,
        error
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
