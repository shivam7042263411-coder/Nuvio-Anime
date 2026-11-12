# Anime API — Final Engineering Report

**Date:** 12 November 2026  
**Project:** Independent anime metadata and authorized-source API  
**Runtime:** Node.js 22, TypeScript, Hono, PostgreSQL 17  
**Deployment target:** Antideploy  
**Status:** Implementation complete; automated verification passed; **not live-deployed**

---

## 1. Executive summary

This project is a standalone anime REST API built for NuvioTV and other clients.
It is not a proxy around AnimePahe. It combines public metadata from AniList and
TMDB with an operator-controlled catalogue of source URLs the operator is
authorized to distribute. An optional AnimePahe provider, disabled by default,
can also resolve public AnimePahe Sub/Dub/DL links into the same contract.

Delivered:

- A modular TypeScript/Hono backend with seven public endpoints plus `/health`.
- AniList search/details and TMDB enrichment, including deterministic matching.
- TMDB-authoritative season/episode catalogues with AniList fallback.
- Authorized-source catalogue with `Sub`, `Dub` and `DL` streaming labels.
- Optional AnimePahe provider behind `SOURCE_ANIMEPAHE_ENABLED=true`, including
  title/season/movie/special matching, kwik playback resolution, DL-as-stream
  normalization, subtitle discovery, per-provider timeouts and failure isolation.
- External subtitle tracks plus non-selectable embedded-subtitle reporting.
- Memory + PostgreSQL caching with stale-on-error and request coalescing.
- Validation, typed errors, rate limiting, security headers, CORS, timeouts and
  upstream concurrency limits.
- Database migrations that run automatically at boot.
- CLI tools for migrations, sources and subtitles.
- A Nuvio `getStreams` adapter and manifest.
- Six documentation guides.
- 90 automated tests across 11 files.

Verification performed:

```text
npm run typecheck   passed
npm test            90 passed (11 files)
npm run build       passed
adapter VM tests    source/subtitle mapping and failure behaviour passed
plugin syntax       node --check passed
original plugin     node tests/run-tests.js 8/8 passed
```

Not performed:

- No live Antideploy deployment.
- No migration execution against a live PostgreSQL server.
- No live AnimePahe request from this session.
- No execution inside a live NuvioTV build.

Those are environmental limitations, not claims of success. They are listed as
open risks in section 17.

---

## 2. Requirements compliance

| Requirement | Status | Where |
| --- | --- | --- |
| Independent anime REST API | Done | `src/` |
| Not a proxy, not just scraping | Done | Authorized catalogue + optional provider adapter |
| No Cloudflare/CAPTCHA/auth bypass | Done by design | Provider stops on challenges |
| AniList metadata | Done | `src/metadata/anilist.ts` |
| TMDB metadata, artwork, seasons | Done | `src/metadata/tmdb.ts` |
| Anime catalogue/search | Done | `/api/search`, `/api/anime/:id` |
| Episodes and movies | Done | `/api/anime/:id/episodes`, `/api/episode/:id` |
| Authorized sources | Done | `/sources`, `authorized_sources` table |
| Optional AnimePahe sources | Done, opt-in | `src/sources/animepahe/` |
| Subtitles | Done | `/subtitles`, `authorized_subtitles` + provider tracks |
| Caching | Done | Memory L1 + PostgreSQL L2 |
| Error handling | Done | Typed errors and JSON envelope |
| Security | Done | Validation, headers, CORS, rate limit, redaction |
| Tests | Done | 90 tests |
| Deployment documentation | Done | `docs/deployment.md` |
| Sub/Dub/DL labels | Done | `SourceLabel` |
| DL is a stream, not a download | Enforced | `delivery: "stream"` |
| Embedded subtitles never selectable | Enforced | Separate `embedded` array |
| No invented episode data | Enforced | `null` metadata, `metadataAvailable` |
| Provider failure isolation | Enforced | Per-provider timeout and partial results |
| Secrets only through environment | Done | `src/config.ts` |
| Logs redact credentials | Done | `src/logger.ts` |
| Nuvio adapter | Done | `nuvio-plugin/` |

---

## 3. Architecture

```text
Client / Nuvio
      |
      v
Hono HTTP app (src/app.ts)
      |
      +-- request ID, request logging
      +-- security headers, CORS, rate limit
      |
      v
Routes (src/routes/)
      |
      +-- search / anime ------> MetadataService
      |                            +-- AniListProvider (GraphQL)
      |                            +-- TmdbProvider (REST)
      |                            +-- matching + match repository
      |
      +-- episodes ------------> EpisodesService
      |                            +-- TMDB seasons (authoritative)
      |                            +-- AniList single-run fallback
      |                            +-- movie catalogue
      |
      +-- sources -------------> SourcesService
      |                            +-- SourceProvider interface
      |                            +-- CatalogSourceProvider (PostgreSQL)
      |                            +-- AnimePaheProvider (opt-in)
      |
      +-- subtitles -----------> SubtitlesService
                                   +-- authorized_subtitles (PostgreSQL)
                                   +-- provider subtitle discovery
                                   +-- SRT/VTT parser
      |
      v
CacheService
  L1: bounded in-process TTL map
  L2: PostgreSQL cache_entries
      |
      v
HttpClient
  timeout, retries, concurrency semaphore, response size cap
```

Boot sequence (`src/index.ts`):

1. Load local `.env` when present.
2. Validate environment with `loadConfig`.
3. In production, require `DATABASE_URL`.
4. Create a PostgreSQL pool (max 5 connections).
5. Apply migrations under an advisory lock with retries.
6. Build the dependency container.
7. Start Hono on `0.0.0.0:$PORT`.
8. Register graceful shutdown for `SIGTERM` and `SIGINT`.

The app intentionally fails fast if production migrations cannot run. It does
not serve against a partial schema.

---

## 4. API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Service discovery |
| GET | `/health` | Health check, `503` when PostgreSQL is unavailable |
| GET | `/api/status` | Detailed runtime/database/cache/provider status |
| GET | `/api/search?q=` | Search AniList |
| GET | `/api/anime/:id` | Anime details |
| GET | `/api/anime/:id/episodes` | Episode catalogue, paginated, optional season |
| GET | `/api/episode/:id` | One episode |
| GET | `/api/episode/:id/sources` | Authorized Sub/Dub/DL streams |
| GET | `/api/episode/:id/subtitles` | External tracks and embedded facts |

All responses use one envelope:

```json
{
  "data": {},
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cached": false,
    "stale": false,
    "warnings": []
  }
}
```

Errors:

```json
{
  "error": {
    "code": "episode_not_found",
    "message": "Episode ... was not found"
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

Emitted error codes:

- `invalid_request` (400)
- `season_unavailable` (400)
- `not_found` (404, unknown route)
- `anime_not_found` (404)
- `episode_not_found` (404)
- `rate_limited` (429, with `Retry-After`)
- `provider_error` (502/503/504)
- `internal_error` (500)

Full request/response documentation: `docs/api.md`.

### IDs

```text
anime:    anilist:20              tmdb:1429
episode:  anilist:20:e1           anilist:16498:s2:e5
          tmdb:1429:s1:e3         tmdb:550:e1
```

- `anilist:` and `tmdb:` IDs are both accepted as inputs.
- A TMDB input may resolve to a canonical AniList ID. The response then contains
  `id: "anilist:..."` and `requestedId: "tmdb:..."`.
- Episode IDs use `e<n>` when no season applies and `s<n>:e<n>` when a season is
  known.
- Clients should always reuse IDs returned by the API.

---

## 5. Metadata layer

### AniList

- GraphQL search and media lookup.
- Public endpoint with no API key.
- Adult titles excluded from search.
- Returns titles, synonyms, description, format, status, episode count,
  duration, broadcast season/year, dates, genres, score, popularity, artwork,
  studios, external links and trailer.
- Streaming episodes supply title/thumbnail when available; missing fields stay
  `null`.
- Descriptions are cleaned of HTML.

### TMDB

- REST API, enabled by `TMDB_API_KEY` (v3) or `TMDB_ACCESS_TOKEN` (v4).
- Provides posters, banners, overviews, runtimes, genres, studios, TV seasons and
  episode metadata.
- `getDetailsAny` tries TV first, then movie. If both return 404, it maps to
  `anime_not_found` instead of leaking a generic upstream failure.
- Uses the same HTTP client with timeout/retry/concurrency controls.

### Matching

Matching is deterministic and explainable. Candidate score:

```text
title similarity * 0.78
+ year score     * 0.17
+ popularity     * 0.05
- format mismatch 0.4
```

- Title normalization handles accents, punctuation, apostrophes and `&`.
- Year: exact = 1.0, ±1 = 0.6, ±2 = 0.2, otherwise penalty.
- Movie/TV mismatch is heavily penalized.
- Minimum accepted score: `0.66`.
- Successful AniList → TMDB matches are persisted in `metadata_matches`.
- TMDB → AniList reverse matching also works, with `requestedId` preserved.

If TMDB enrichment fails for an AniList request, the API logs a warning and
returns AniList metadata with a warning, rather than failing the request.

---

## 6. Episode catalogue

### TMDB-matched TV

- TMDB seasons are authoritative.
- Default season is the first normal season (`seasonNumber > 0`), otherwise the
  first listed season.
- `season=0` means specials and is never silently mapped to season 1.
- Episode titles, overviews, air dates, runtimes and images come from TMDB.
- Missing episode titles stay `null`; they are not invented.
- `complete` compares the returned episode count with TMDB's season count.

### AniList-only fallback

- Used when no TMDB match exists, or when the TMDB season request fails and no
  season filter was requested.
- Episode count is `max(AniList episodeCount, streaming entries)`, capped at
  2000.
- Episode titles/thumbnails appear only when AniList streaming data supplies
  them.
- Season numbers are `null`; the catalogue is presented as one run.
- Requesting a season other than `1` returns `400 season_unavailable`.

### Movies

- A movie returns exactly one episode entry, `:<n>:e1`.
- `seasonNumber` is `null`.
- Title falls back to the anime title; other fields come from metadata.
- Season `0` or `1` is tolerated; other seasons return `season_unavailable`.

### Pagination

- `page` 1–1000.
- `limit` 1–100.
- `meta.pagination` includes page, limit, total, totalPages, hasNextPage and
  hasPreviousPage.

---

## 7. Sources

The API serves sources from `authorized_sources` and, when explicitly enabled,
the optional AnimePahe provider. The provider is an adapter around public pages;
it is not a second API or plugin.

### Provider model

```ts
interface SourceProvider {
  id: string;
  name: string;
  isConfigured(): boolean;
  getSources(context: { anime, episode }): Promise<ProviderResult>;
  getSubtitles?(context: { anime, episode }): Promise<ProviderSubtitleResult>;
}
```

The built-in `CatalogSourceProvider` queries:

```sql
provider_id = 'catalog'
and anime_id = <canonical id>
and season_number is not distinct from <episode season>
and episode_number = <episode number>
and enabled = true
and (expires_at is null or expires_at > now() + interval '15 seconds')
```

### Optional AnimePahe provider

Enabled with `SOURCE_ANIMEPAHE_ENABLED=true` (default `false`).

- Reuses the central `AnimeMetadata` and `MetadataService.getTmdbSeasons`; it does
  not duplicate AniList/TMDB resolution.
- Searches and matches title/season/episode/movie, reads the release play page,
  resolves Sub/Dub kwik links and up to `ANIMEPAHE_MAX_DOWNLOAD_OPTIONS` DL links.
- `DL` remains a playable `delivery: "stream"` source. There is no download path.
- Discovers external HLS/track subtitles. Embedded subtitle facts stay empty
  because the upstream does not expose reliable embedded metadata.
- Stops and warns on Cloudflare challenges, auth walls, HTTP failures and
  timeouts; it never bypasses them.
- Is isolated by `SOURCE_PROVIDER_TIMEOUT_MS`. A hanging provider becomes a
  warning while other providers still contribute sources.
- Caches one in-flight resolution per episode so `/sources` and `/subtitles`
  share the scrape.

### Response semantics

- `provider` is `catalog` or `animepahe`; optional `providerName` is display text.
- `label`: `Sub`, `Dub` or `DL`.
- `delivery`: always `stream`.
- **`DL` is a streaming label, not a download action.**
- `type`: `hls`, `dash` or `mp4`.
- `headers`: playback headers, sanitized to string keys/values with length caps.
- `expiresAt`: optional ISO timestamp; rows expire 15 seconds early.
- `temporary`: true for provider-resolved sources.
- Optional `name` and informational `size` carry variant detail.
- Empty result: `200` with an explanatory warning.
- All configured providers fail: `502 provider_error`.
- One provider fails: partial results plus a warning.
- Sources are sorted Sub → Dub → DL, then highest quality.
- Equivalent provider-agnostic duplicates (label, quality, URL, headers) are
  removed.

### Caching

Source responses are cached in memory only for 60 seconds by default and send
`Cache-Control: no-store`. Signed URLs are never written to the PostgreSQL
cache.

### Operator workflow

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --language ja \
  --type hls \
  --url "https://authorized.example/ep1.m3u8"
```

The canonical anime ID and season number must match what the episode endpoint
returns. Omit `--season` for AniList-only catalogues and movies.

Full guide: `docs/sources.md`.

---

## 8. Subtitles

### Sources of truth

`authorized_subtitles` stores two kinds:

| Kind | Response | Selectable |
| --- | --- | --- |
| `external` | `data.tracks` | Yes |
| `embedded` | `data.embedded` | No |

- External rows must have URL and format (`srt` or `vtt`).
- Embedded rows must have no URL.
- Embedded/hardsub entries are never copied into `tracks`.
- External rows missing URL/format are skipped with a warning.
- When a source provider exposes external subtitle candidates, the subtitle
  service normalizes them (HTTP(S) only, `srt`/`vtt` only), deduplicates and
  merges them with catalogue tracks. Embedded facts remain separate and
  unselectable.

### Parser

- Detects SRT and WebVTT.
- Normalizes BOM and line endings.
- Parses cue timing, identifiers and settings.
- Rejects reversed time ranges.
- Reports malformed blocks as warnings instead of throwing.
- Converts parsed cues to WebVTT.
- Available through `npm run subtitle:inspect -- file.srt`.

### Responses and caching

- `data.tracks` contains external selectable tracks.
- `data.embedded` contains factual embedded labels with `selectable: false`.
- `meta.selectableTrackCount` counts only external tracks.
- Cached in memory only for 120 seconds by default.
- `Cache-Control: no-store`.

---

## 9. Cache design

Two tiers because Antideploy does not provide Redis:

| Tier | Storage | Purpose |
| --- | --- | --- |
| L1 | Bounded in-process map | Fast repeated reads |
| L2 | PostgreSQL `cache_entries` | Survives restarts and app sleep |

Default lifetimes:

| Data | TTL |
| --- | --- |
| Search | 300 s |
| Anime metadata | 6 h |
| Episode catalogue | 6 h |
| TMDB/AniList match | 24 h |
| Sources | 60 s, memory only |
| Subtitles | 120 s, memory only |
| Stale grace | 7 days |

Behaviour:

- Fresh values return `cached: true`.
- Expired values are reloaded.
- If reload fails and a stale copy is within grace, the stale copy is returned
  with `stale: true` and a warning.
- Concurrent misses for the same key share one upstream request.
- L1 is bounded by `MEMORY_CACHE_MAX_ENTRIES` (default 500) with LRU refresh.
- L2 prunes expired rows every 100 writes.
- Search keys hash the raw query with SHA-1 to preserve non-Latin queries.
- Source and subtitle URLs are never written to L2.

---

## 10. Security and compliance

### Access-control stance

- No Cloudflare bypass.
- No CAPTCHA solving.
- No login/session impersonation.
- No DRM work.
- No download endpoint.
- The optional AnimePahe provider reads public pages only and stops on a
  challenge, auth wall, rate limit or timeout.
- Catalogue sources are only operator-authorized URLs.

### Application security

- Zod validation for query strings and IDs.
- Strict ID regexes and length caps.
- Request IDs validated before reuse.
- Security headers: `nosniff`, `no-referrer`, `DENY` framing, restrictive
  permissions policy.
- CORS is opt-in by exact origin; empty means no CORS headers.
- Rate limiting per client address, with `/health` exempt.
- `TRUST_PROXY` is opt-in because trusting `X-Forwarded-For` without a trusted
  proxy allows spoofing.
- 8-second upstream timeout by default.
- Upstream concurrency semaphore (6 by default).
- Upstream response body cap of 4 MB.
- Retries only for retryable GET failures (408, 429, 5xx or network).
- JSON errors never expose stack traces.
- Logs redact credential-shaped keys (authorization, API key, token, secret,
  password, session, cookie, bearer).
- Logs remove URL query strings and fragments.
- Request query strings are not logged.
- API keys and database URLs come only from environment variables.

### Legal/compliance note

Authorization is a legal question. The code can only enforce that a URL came
from the operator's table. The operator is responsible for having the right to
distribute every source and subtitle URL.

---

## 11. Configuration

Required in production:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; Antideploy injects it |
| `NODE_ENV=production` | Enables production startup checks |
| `PORT` | Injected by the platform |

Recommended:

| Variable | Purpose |
| --- | --- |
| `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` | Artwork, TMDB seasons, TMDB-only IDs |
| `CORS_ORIGINS` | Exact browser origins |
| `TRUST_PROXY` | Only with a trusted reverse proxy |
| `LOG_LEVEL` | `info` in production |

Tunable groups:

- Cache TTLs and memory cap.
- HTTP timeout, concurrency, retries.
- Rate-limit enable/window/max.
- AniList/TMDB base URLs.
- `SOURCE_CATALOG_ENABLED`.
- `SOURCE_PROVIDER_TIMEOUT_MS`.
- `SOURCE_ANIMEPAHE_ENABLED` plus AnimePahe base URL, deadline, search pages and
  download-option cap.

Full list with defaults: `.env.example`.

Production validation:

- Missing `DATABASE_URL` stops startup.
- Invalid integers/booleans/URLs throw a readable configuration error.

---

## 12. Database

Schema: `migrations/001_init.sql`.

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Applied migration filenames |
| `cache_entries` | Shared L2 JSON cache with fresh/stale timestamps |
| `metadata_matches` | Persisted AniList → TMDB matches |
| `authorized_sources` | Operator-authorized stream catalogue |
| `authorized_subtitles` | External and embedded subtitle records |

Key constraints and indexes:

- `cache_entries.stale_until` index for pruning.
- `metadata_matches` unique by `anilist_id`; lookup by TMDB ID/media type.
- `authorized_sources` unique identity on provider, anime, season, episode,
  label and quality; partial lookup index for enabled rows.
- `authorized_subtitles` unique identity on provider, anime, season, episode,
  kind, language and label.
- Check constraints enforce label/kind/stream type/URL rules and the
  external-vs-embedded URL rule.

Migrations:

- Numbered `.sql` files.
- Applied in filename order.
- Transactional.
- Guarded by a PostgreSQL advisory lock.
- Retried five times at boot with backoff.
- Recorded once in `schema_migrations`.
- No migration HTTP endpoint by design.

Full schema documentation: `docs/database.md`.

---

## 13. CLI tools

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply pending migrations |
| `npm run source:add -- ...` | Add/update an authorized source |
| `npm run subtitle:add -- ...` | Add an external or embedded subtitle |
| `npm run subtitle:inspect -- file` | Parse a local SRT/VTT and show cues/warnings |

Scripts load `.env`, require `DATABASE_URL`, run migrations, then upsert the row.
Episode numbers must now be non-negative integers, matching episode-ID parsing.

---

## 14. Nuvio integration

Files:

```text
nuvio-plugin/nuvio-anime-api.js
nuvio-plugin/manifest.json
```

Contract:

```js
getStreams(tmdbId, mediaType, season, episode)
  => Promise<LocalScraperResult[]>
```

The adapter makes three parallel requests:

```text
/api/anime/tmdb:<id>
/api/episode/tmdb:<id>:s<season>:e<episode>/sources
/api/episode/tmdb:<id>:s<season>:e<episode>/subtitles
```

Movies use `tmdb:<id>:e1`.

Mapping:

| Nuvio field | Value |
| --- | --- |
| `title` | Preferred anime title + ` - SxxExx` for TV |
| `name` | `Anime API · <label> · <variant> · <quality> · <language> · <provider>` |
| `url` | Source URL |
| `quality` | Source quality |
| `size` | Informational provider size or `null` |
| `language` | `Sub`, `Dub` or `DL` |
| `provider` | `Anime API` |
| `type` | `hls → m3u8`, `dash → mpd`, `mp4 → mp4` |
| `headers` | Playback headers or `null` |
| `subtitles` | External tracks only |
| `seeders`/`peers`/`infoHash` | `null` |

Failure behaviour:

- API unreachable, 404, 502 or no source → empty result list.
- Subtitle failure → streams still returned without subtitles.
- Expired source or non-`stream` delivery → skipped.
- Embedded subtitles are ignored.
- Placeholder API base logs an explicit configuration error.

The adapter was syntax-checked and executed in a VM against a mock HTTP API. It
was not executed inside a live NuvioTV build.

Guide: `docs/nuvio.md`.

---

## 15. Test and verification evidence

### Automated tests

90 tests in 11 files:

| File | Tests | Coverage |
| --- | --- | --- |
| `tests/api.test.ts` | 13 | Envelope, validation, episodes, no-store headers, provider errors, 404, rate limit, degraded health/status, provider listing |
| `tests/cache.test.ts` | 6 | Fresh hits, coalescing, stale-on-error, memory-only, L2 promotion, bounded memory |
| `tests/container.test.ts` | 4 | Provider registration, opt-in config, independence, invalid configuration |
| `tests/episodes.test.ts` | 8 | TMDB seasons, cache reuse, AniList fallback, movies, unavailable season, stable IDs, TMDB-only catalogue, missing episode |
| `tests/matching.test.ts` | 6 | Normalization, exact/alternate titles, format penalty, year disambiguation, no-match threshold |
| `tests/metadata.test.ts` | 7 | Search cache, TMDB enrichment, no-TMDB mode, canonical ID resolution, TMDB 404 mapping, stale metadata, provider failure |
| `tests/sources-subtitles.test.ts` | 12 | Label mapping, no-database mode, sorting/deduplication, memory-only cache, cross-provider dedupe, provider timeout, partial/all provider failure, provider subtitle merge, external vs embedded |
| `tests/subtitles.test.ts` | 7 | SRT, VTT, format detection, malformed blocks, reversed ranges, VTT conversion, timestamp formatting |
| `tests/animepahe-matching.test.ts` | 13 | Title normalization, season 1/2, named/final season, split cour, movie, mismatch, special, empty/no-match/no-episode, alternate title search |
| `tests/animepahe-provider.test.ts` | 9 | Disable/config, Sub/Dub HLS, subtitles, season 2, movie, DL-as-stream, empty/no-match, Cloudflare, partial failure, cache sharing |
| `tests/nuvio-plugin.test.ts` | 5 | VM execution, source/subtitle mapping, name/size, expired/non-stream/duplicate filtering, failure/unconfigured behaviour |

### Commands and results

```text
$ npm run typecheck
> tsc -p tsconfig.json
(no errors)

$ npm test
Test Files  11 passed (11)
Tests       90 passed (90)

$ npm run build
> tsc -p tsconfig.build.json
(no errors)
```

### Runtime smoke test

Built server started with no database:

```text
GET /             -> 200
GET /api/status   -> 200, status "degraded", cache driver "memory"
GET /health       -> 503, database not configured
```

The `503` is expected and correct when `DATABASE_URL` is absent. Production
startup refuses to run without it.

### Nuvio adapter mock test

Executed the plugin source in a Node VM with a mock API server:

- TV request returned 2 streams (Sub + DL).
- Expired source was excluded.
- Embedded subtitle was excluded.
- External subtitle was mapped.
- Headers and stream types were preserved.
- Movie request used `tmdb:550:e1` and returned 1 stream.
- Three HTTP requests per episode were observed.

This validates adapter logic, not the live Nuvio runtime.

---

## 16. Deployment summary

Target: Antideploy, Node 22, PostgreSQL 17, no Redis, one instance, app sleeps
when idle.

Platform settings:

```text
Build: npm run build
Start: npm start
Health: GET /health
```

Deploy steps:

1. Push the repository.
2. Create the Antideploy app.
3. Attach PostgreSQL 17; let the platform inject `DATABASE_URL`.
4. Set `NODE_ENV=production`.
5. Set `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN`.
6. Set `CORS_ORIGINS` if browser clients need it.
7. Deploy.
8. Verify `/health`, `/api/status`, search, anime and episodes.
9. Add authorized sources/subtitles using the canonical IDs.
10. Configure `nuvio-plugin/nuvio-anime-api.js` with the real API URL.

Sleep/idle implications:

- First request after idle is slower.
- Memory cache and rate-limit buckets reset.
- PostgreSQL cache and catalogue survive.
- Health and status still work after wake.

Full guide: `docs/deployment.md`.

---

## 17. Open risks and limitations

### Blocking before production

1. **No live Antideploy deployment.** The platform contract was followed, but
   the app has not actually run there.
2. **No live PostgreSQL migration run.** The schema SQL is unexecuted against a
   real server in this environment. Run `npm run db:migrate` against staging and
   check all five tables/indexes.
3. **No live NuvioTV execution.** Adapter logic was mocked, not run on an
   Android/Fire TV build.

### Design limitations

4. **Catalogue sources are only as good as the operator table; AnimePahe
   availability is upstream-dependent.** The provider stops rather than bypassing
   a challenge, and its automated tests use synthetic fixtures.
5. **The API is unauthenticated.** Rate limiting and CORS are not access
   control. If the API must be private, put it behind a private network or an
   authenticating proxy, but Nuvio must then be able to authenticate.
6. **Rate limiting is per process.** Multiple instances would need a shared
   limiter.
7. **Memory cache is per process.** L2 remains shared through PostgreSQL.
8. **Embedded subtitles are manual facts.** The API does not inspect video
   streams or HLS manifests to discover them.
9. **TMDB is required for Nuvio.** Nuvio sends TMDB IDs; without a key/token,
   `tmdb:` requests cannot resolve.
10. **AniList-only runs have limited metadata.** Episode titles/thumbnails may be
    `null`, and season numbers do not exist.
11. **No admin UI.** Sources/subtitles are managed by CLI or SQL.
12. **Legal review is the operator's responsibility.** The code cannot determine
    whether a URL is licensed.

### Operational risks

13. **Cold starts.** The platform sleeps; first wake can be slow.
14. **Database connection limits.** Pool max is 5, sized for one small instance.
15. **Upstream changes.** AniList/TMDB schema or endpoint changes could require
    code updates.
16. **TMDB match drift.** Stored matches persist; a wrong match can be corrected
    by deleting its `metadata_matches` row and refreshing.

---

## 18. Recommended next steps

1. Create a staging Antideploy app with PostgreSQL.
2. Deploy and confirm `/health` returns `200`.
3. Run the migration locally or in staging against a real PostgreSQL 17 and
   inspect the schema.
4. Configure TMDB and verify artwork, seasons and `tmdb:` IDs.
5. Add one test TV episode and one movie from authorized sources.
6. Verify `Sub`, `Dub`, `DL`, external subtitles and embedded reporting.
7. Install the Nuvio plugin and test one movie and one TV episode on a device.
8. Re-check logs for secret leakage and unexpected provider errors.
9. Set a sensible rate limit and CORS policy.
10. Complete a legal review of every source URL before public launch.

---

## 19. File index

```text
src/                         3,856 lines of TypeScript
  app.ts                     Hono wiring
  index.ts                   production entry
  container.ts               dependency injection
  config.ts                  environment validation
  errors.ts                  typed errors
  logger.ts                  JSON logs + redaction
  responses.ts               envelopes
  validation.ts              Zod schemas
  cache/                     L1/L2 cache
  db/                        pool, migrations, health
  episodes/                  IDs, catalogue, pagination
  http/                      client, retries, semaphore
  metadata/                  AniList, TMDB, matching, repository
  middleware/                request ID, logging, CORS, headers, limits
  routes/                    endpoint handlers
  sources/                   provider interface, catalogue, AnimePahe, normalization
  subtitles/                 parser and service

tests/                       90 tests across 11 files
scripts/                     325 lines, four CLI tools
migrations/001_init.sql      schema
nuvio-plugin/                Nuvio adapter + manifest
docs/                        API, deployment, sources, Nuvio, database
.env.example                 configuration reference
README.md                    project overview and quick start
```

---

## 20. Bottom line

The API is structurally complete, type-safe, tested and documented. It meets the
functional and compliance requirements in the brief: independent metadata
backend, authorized catalogue plus optional provider integration, correct
Sub/Dub/DL semantics, honest episode data, external-only selectable subtitles,
caching, security controls and deployment guidance.

The remaining work is operational: deploy it, run the schema against a real
PostgreSQL 17 instance, add authorized content or explicitly enable and validate
the AnimePahe provider, and verify the Nuvio adapter on a real device. No
deployment or live-playback success should be claimed until those steps are
completed.
