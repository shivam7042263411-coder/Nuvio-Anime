import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ProviderError } from "../src/errors.js";
import { fakeContainer, testConfig } from "./helpers.js";

describe("HTTP API", () => {
  it("returns search results in the standard envelope", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/search?q=naruto");
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.query).toBe("naruto");
    expect(body.data.results[0].id).toBe("anilist:1");
    expect(body.meta.requestId).toBeTypeOf("string");
    expect(body.meta.pagination.total).toBe(1);
  });

  it("rejects a search query that is too short", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/search?q=a");
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.details.issues[0].path).toBe("q");
  });

  it("rejects an invalid anime id", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/anime/not-an-id");
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns anime details and caching metadata", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/anime/anilist:1");
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.id).toBe("anilist:1");
    expect(body.meta.cached).toBe(false);
  });

  it("returns paginated episodes", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/anime/anilist:1/episodes?page=1&limit=50");
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.episodes[0].id).toBe("anilist:1:e1");
    expect(body.meta.pagination.total).toBe(1);
  });

  it("rejects an invalid episode id", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/episode/oops");
    expect(response.status).toBe(400);
  });

  it("marks temporary source and subtitle responses as no-store", async () => {
    const app = createApp(fakeContainer());
    const sources = await app.request("/api/episode/anilist:1:e1/sources");
    const subtitles = await app.request("/api/episode/anilist:1:e1/subtitles");

    expect(sources.headers.get("cache-control")).toBe("no-store");
    expect(subtitles.headers.get("cache-control")).toBe("no-store");
  });

  it("converts upstream failures into a JSON provider_error", async () => {
    const container = fakeContainer();
    container.metadata.search = vi.fn(async () => {
      throw new ProviderError("anilist", "AniList returned HTTP 500", {
        upstreamStatus: 500
      });
    });
    const app = createApp(container);
    const response = await app.request("/api/search?q=naruto");
    const body = await response.json() as any;

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("provider_error");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/nope");
    const body = await response.json() as any;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 429 after the configured rate limit", async () => {
    const container = fakeContainer({
      config: testConfig({ RATE_LIMIT_MAX: "1" })
    });
    const app = createApp(container);

    const first = await app.request("/api/search?q=naruto");
    const second = await app.request("/api/search?q=naruto");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTypeOf("string");
  });

  it("reports degraded health when the database is absent", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/health");
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
  });

  it("keeps /api/status useful even when degraded", async () => {
    const app = createApp(fakeContainer());
    const response = await app.request("/api/status");
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("degraded");
    expect(body.data.providers.anilist).toBe(true);
  });

  it("does not expose raw database errors in health or status", async () => {
    const raw = 'password authentication failed for user "app_secret"';
    const app = createApp(
      fakeContainer({
        pool: {
          query: async () => {
            throw new Error(raw);
          }
        } as any
      })
    );

    for (const path of ["/health", "/api/status"]) {
      const response = await app.request(path);
      const body = await response.json() as any;
      const database = body.data?.database ?? body.database;

      expect(response.status === 200 || response.status === 503).toBe(true);
      expect(database.error).toBe("database check failed");
      expect(JSON.stringify(body)).not.toContain("app_secret");
      expect(JSON.stringify(body)).not.toContain("password authentication");
    }
  });

  it("lists configured and unconfigured source providers in status", async () => {
    const container = fakeContainer({
      sourceProviders: [
        {
          id: "catalog",
          name: "Catalogue",
          isConfigured: () => true,
          getSources: async () => ({ sources: [], warnings: [] })
        },
        {
          id: "animepahe",
          name: "AnimePahe",
          isConfigured: () => false,
          getSources: async () => ({ sources: [], warnings: [] })
        }
      ]
    } as any);
    const app = createApp(container);
    const response = await app.request("/api/status");
    const body = await response.json() as any;

    expect(body.data.providers.sources).toEqual([{ id: "catalog", name: "Catalogue" }]);
    expect(body.data.providers.sourceProviders).toEqual([
      { id: "catalog", name: "Catalogue", configured: true },
      { id: "animepahe", name: "AnimePahe", configured: false }
    ]);
  });
});
