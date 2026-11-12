import type { Context } from "hono";
import type { Container } from "../container.js";
import type { AppEnv } from "../middleware/app-env.js";
import { ok } from "../responses.js";
import { parseWith, searchQuerySchema } from "../validation.js";

export async function searchRoute(c: Context<AppEnv>, container: Container) {
  const query = parseWith(searchQuerySchema, c.req.query());
  const result = await container.metadata.search(query.q, query.page, query.limit);

  return ok(
    c,
    {
      query: query.q,
      results: result.value.results
    },
    {
      cached: result.cached,
      stale: result.stale,
      warnings: result.warnings,
      pagination: {
        page: result.value.page,
        limit: result.value.perPage,
        total: result.value.total,
        totalPages: result.value.lastPage,
        hasNextPage: result.value.hasNextPage,
        hasPreviousPage: result.value.page > 1
      }
    }
  );
}
