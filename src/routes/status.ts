import type { Container } from "../container.js";
import { checkDatabase } from "../db/pool.js";
import type { AppEnv } from "../middleware/app-env.js";
import { ok } from "../responses.js";
import type { Context } from "hono";

export async function statusRoute(c: Context<AppEnv>, container: Container) {
  const database = container.pool
    ? await checkDatabase(container.pool, container.logger)
    : { ok: false, latencyMs: null, error: "DATABASE_URL is not configured" };

  c.header("Cache-Control", "no-store");

  return ok(c, {
    status: database.ok ? "ok" : "degraded",
    version: container.version,
    uptimeSeconds: Math.floor((Date.now() - container.startedAt) / 1000),
    database,
    cache: {
      driver: container.pool ? "memory+postgres" : "memory",
      memoryEntries: container.cache.memory.size
    },
    providers: {
      anilist: true,
      tmdb: container.config.tmdb.enabled,
      sources: container.sourceProviders
        .filter((provider) => provider.isConfigured())
        .map((provider) => ({ id: provider.id, name: provider.name })),
      sourceProviders: container.sourceProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: provider.isConfigured()
      }))
    },
    environment: container.config.nodeEnv
  });
}

export async function healthRoute(c: Context<AppEnv>, container: Container) {
  const database = container.pool
    ? await checkDatabase(container.pool, container.logger)
    : { ok: false, latencyMs: null, error: "DATABASE_URL is not configured" };

  c.header("Cache-Control", "no-store");
  return c.json(
    {
      status: database.ok ? "ok" : "degraded",
      version: container.version,
      uptimeSeconds: Math.floor((Date.now() - container.startedAt) / 1000),
      database,
      timestamp: new Date().toISOString()
    },
    database.ok ? 200 : 503
  );
}
