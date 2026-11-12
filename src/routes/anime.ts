import type { Context } from "hono";
import type { Container } from "../container.js";
import type { AppEnv } from "../middleware/app-env.js";
import { ok } from "../responses.js";
import { animeIdSchema, parseWith } from "../validation.js";

export async function animeRoute(c: Context<AppEnv>, container: Container) {
  const id = parseWith(animeIdSchema, c.req.param("id"));
  const result = await container.metadata.getAnime(id);

  return ok(c, result.value, {
    cached: result.cached,
    stale: result.stale,
    warnings: result.warnings
  });
}
