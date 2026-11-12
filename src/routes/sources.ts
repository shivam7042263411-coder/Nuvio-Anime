import type { Context } from "hono";
import type { Container } from "../container.js";
import type { AppEnv } from "../middleware/app-env.js";
import { ok } from "../responses.js";
import { episodeIdSchema, parseWith } from "../validation.js";

export async function sourcesRoute(c: Context<AppEnv>, container: Container) {
  const episodeId = parseWith(episodeIdSchema, c.req.param("id"));
  c.header("Cache-Control", "no-store");

  const result = await container.sources.getSources(episodeId);

  return ok(
    c,
    {
      episodeId: result.episodeId,
      sources: result.sources
    },
    {
      cached: result.cached,
      stale: result.stale,
      warnings: result.warnings,
      providers: result.providers
    }
  );
}
