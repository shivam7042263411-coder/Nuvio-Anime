import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, loadLocalEnv } from "./config.js";
import { createContainer } from "./container.js";
import { createPool } from "./db/pool.js";
import { migrateWithRetry } from "./db/migrate.js";
import { Logger } from "./logger.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  let pool = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, logger);
    try {
      const applied = await migrateWithRetry(pool, logger);
      logger.info("database ready", {
        migrationsApplied: applied.length,
        applied
      });
    } catch (error) {
      logger.error("database migration failed; the app cannot start safely", { error });
      await pool.end().catch(() => undefined);
      process.exit(1);
    }
  } else {
    logger.warn(
      "DATABASE_URL is not set. Running with memory-only cache and no durable source catalogue."
    );
  }

  if (!config.tmdb.enabled) {
    logger.warn(
      "TMDB is not configured. Posters, artwork and TMDB season layouts will use AniList data only."
    );
  }

  const container = createContainer(config, logger, pool);
  const app = createApp(container);

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: "0.0.0.0"
    },
    (info) => {
      logger.info("server listening", {
        port: info.port,
        environment: config.nodeEnv,
        database: Boolean(pool),
        tmdb: config.tmdb.enabled
      });
    }
  );

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      void (async () => {
        if (pool) await pool.end().catch(() => undefined);
        process.exit(0);
      })();
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      message: "startup failed",
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
    })}\n`
  );
  process.exit(1);
});
