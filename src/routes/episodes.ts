import type { Context } from "hono";
import type { Container } from "../container.js";
import type { AppEnv } from "../middleware/app-env.js";
import { ok, pagination } from "../responses.js";
import {
  animeIdSchema,
  episodeIdSchema,
  episodesQuerySchema,
  parseWith
} from "../validation.js";

export async function animeEpisodesRoute(c: Context<AppEnv>, container: Container) {
  const animeId = parseWith(animeIdSchema, c.req.param("id"));
  const query = parseWith(episodesQuerySchema, c.req.query());
  const result = await container.episodes.list(animeId, {
    season: query.season,
    page: query.page,
    limit: query.limit
  });

  return ok(
    c,
    {
      animeId: result.animeId,
      kind: result.kind,
      source: result.source,
      seasonNumber: result.seasonNumber,
      seasons: result.seasons,
      episodes: result.episodes,
      complete: result.complete
    },
    {
      cached: result.cached,
      stale: result.stale,
      warnings: result.warnings,
      pagination: pagination(result.page, result.limit, result.total)
    }
  );
}

export async function episodeRoute(c: Context<AppEnv>, container: Container) {
  const episodeId = parseWith(episodeIdSchema, c.req.param("id"));
  const result = await container.episodes.getEpisode(episodeId);
  return ok(c, result.episode, {
    cached: result.cached,
    stale: result.stale,
    warnings: result.warnings
  });
}
