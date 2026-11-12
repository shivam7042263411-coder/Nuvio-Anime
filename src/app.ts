import { Hono } from "hono";
import type { Container } from "./container.js";
import { errorResponse, ok } from "./responses.js";
import { requestContext } from "./middleware/request-context.js";
import { cors, requestLogger, securityHeaders } from "./middleware/http.js";
import { rateLimit } from "./middleware/rate-limit.js";
import type { AppEnv } from "./middleware/app-env.js";
import { animeRoute } from "./routes/anime.js";
import { animeEpisodesRoute, episodeRoute } from "./routes/episodes.js";
import { searchRoute } from "./routes/search.js";
import { sourcesRoute } from "./routes/sources.js";
import { healthRoute, statusRoute } from "./routes/status.js";
import { subtitlesRoute } from "./routes/subtitles.js";

export function createApp(container: Container): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestContext());
  app.use("*", requestLogger(container.logger));
  app.use("*", securityHeaders());
  app.use("*", cors(container.config));
  app.use("*", rateLimit(container.config));

  app.get("/", (c) =>
    ok(c, {
      name: "Anime API",
      version: container.version,
      documentation: "See docs/api.md in the project repository.",
      endpoints: {
        status: "/api/status",
        search: "/api/search?q=naruto",
        anime: "/api/anime/:id",
        episodes: "/api/anime/:id/episodes",
        episode: "/api/episode/:id",
        sources: "/api/episode/:id/sources",
        subtitles: "/api/episode/:id/subtitles"
      }
    })
  );

  app.get("/health", (c) => healthRoute(c, container));
  app.get("/api/status", (c) => statusRoute(c, container));
  app.get("/api/search", (c) => searchRoute(c, container));
  app.get("/api/anime/:id", (c) => animeRoute(c, container));
  app.get("/api/anime/:id/episodes", (c) => animeEpisodesRoute(c, container));
  app.get("/api/episode/:id", (c) => episodeRoute(c, container));
  app.get("/api/episode/:id/sources", (c) => sourcesRoute(c, container));
  app.get("/api/episode/:id/subtitles", (c) => subtitlesRoute(c, container));

  app.notFound((c) =>
    c.json(
      {
        error: { code: "not_found", message: "Route not found" },
        meta: {
          requestId: c.get("requestId") ?? "unknown",
          timestamp: new Date().toISOString()
        }
      },
      404
    )
  );

  app.onError((error, c) => errorResponse(c, container.logger, error));

  return app;
}
