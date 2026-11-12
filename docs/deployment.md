# Deploying to Antideploy

This guide is written for a first deployment. It targets Antideploy's current
runtime as documented in November 2026:

- Node.js 22
- PostgreSQL 17
- no Redis
- one shared vCPU and 1 GB RAM
- a single app instance
- the app sleeps when idle and wakes on the next request

> **Deployment status:** deployed on 2026-11-12 through Antideploy's agent API
> (project upload, not a Git connection).
>
> - Application: `nuvio-anime-api`
> - URL: `https://nuvio-anime-api.antideploy.app`
> - PostgreSQL 17.11, provisioned by Antideploy; migrations applied by the app
>   at boot (`migrations/001_init.sql`)
> - `SOURCE_ANIMEPAHE_ENABLED=false` on this deployment
> - TMDB is configured through `TMDB_API_KEY` in Antideploy's encrypted store;
>   `tmdb:` IDs and season episode layouts resolve successfully.

## 1. What Antideploy needs from the project

| Setting | Value |
| --- | --- |
| Runtime | Node.js 22 (declared in `package.json` as `"engines": { "node": "22" }`) |
| Install | Standard `npm install` / `npm ci` |
| Build command | `npm run build` |
| Start command | `npm start` |
| Port | Read from `PORT`; the server binds `0.0.0.0` |
| Database | Add Antideploy's PostgreSQL 17 database to the app |
| Health check | `GET /health` |

`npm run build` compiles TypeScript into `dist/`. `npm start` runs
`node dist/index.js`. The `migrations/` directory stays at the repository root,
so the built app can find it after compilation.

No Dockerfile is required. No Redis add-on is required.

## 2. Create the app

1. Put this project in a Git repository (GitHub, GitLab, or any host Antideploy
   supports).
2. In Antideploy, create a new application and connect the repository.
3. Add a **PostgreSQL** database to the application. Choose PostgreSQL 17 if the
   dashboard offers a version choice.
4. Set the build and start commands:

   ```text
   Build: npm run build
   Start: npm start
   ```

5. Do **not** hard-code a `DATABASE_URL`. Antideploy injects it when the
   database is attached to the app.

The platform should detect Node 22 from `engines.node` and detect PostgreSQL
from the `pg` dependency.

## 3. Environment variables

Set these in the Antideploy dashboard. Only the first group is normally needed.

### Required for production

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | injected by Antideploy | Do not set it manually unless the platform asks you to. |
| `NODE_ENV` | `production` | Enables the production startup checks. |
| `PORT` | injected by Antideploy | The app reads it; do not pin a port. |

### Recommended

| Variable | Example | Notes |
| --- | --- | --- |
| `TMDB_API_KEY` | your v3 key | Enables posters, artwork, TMDB seasons and TMDB-only IDs. |
| `TMDB_ACCESS_TOKEN` | your v4 read token | Alternative to `TMDB_API_KEY`; set one, not both. |
| `CORS_ORIGINS` | `https://app.example.com` | Comma-separated exact origins. Empty means no CORS headers. |
| `TRUST_PROXY` | `true` | Only when the platform's reverse proxy sets `X-Forwarded-For` and strips client-supplied values. |
| `LOG_LEVEL` | `info` | Use `debug` only while diagnosing. |

### Optional tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `true` | In-process per-client limiting. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length. |
| `RATE_LIMIT_MAX` | `90` | Requests per window per client. |
| `SEARCH_CACHE_TTL` | `300` | Search cache seconds. |
| `ANIME_CACHE_TTL` | `21600` | Anime metadata cache seconds. |
| `EPISODE_CACHE_TTL` | `21600` | Episode catalogue cache seconds. |
| `MATCH_CACHE_TTL` | `86400` | TMDB/AniList match cache seconds. |
| `SOURCES_CACHE_TTL` | `60` | Source response cache seconds. |
| `SUBTITLES_CACHE_TTL` | `120` | Subtitle response cache seconds. |
| `STALE_CACHE_TTL` | `604800` | How long expired data may be served after an upstream failure. |
| `MEMORY_CACHE_MAX_ENTRIES` | `500` | In-process cache entry cap. |
| `HTTP_TIMEOUT_MS` | `8000` | Upstream request timeout. |
| `HTTP_MAX_CONCURRENCY` | `6` | Simultaneous upstream requests. |
| `HTTP_RETRIES` | `2` | Retries for retryable GET failures. |
| `SOURCE_CATALOG_ENABLED` | `true` | Enables the authorized source catalogue. |
| `SOURCE_PROVIDER_TIMEOUT_MS` | `45000` | Per-provider budget. A hung provider yields a warning, not a stuck request. |
| `SOURCE_ANIMEPAHE_ENABLED` | `false` | Enables the optional AnimePahe provider. Review authorization and upstream terms first. |
| `ANIMEPAHE_BASE_URL` | `https://animepahe.pw` | Override only if the upstream domain changes. |
| `ANIMEPAHE_DEADLINE_MS` | `45000` | Soft deadline for optional HLS subtitle probing. |
| `ANIMEPAHE_MAX_SEARCH_PAGES` | `2` | Search pages to inspect per title query. |
| `ANIMEPAHE_MAX_DOWNLOAD_OPTIONS` | `4` | Maximum DL links resolved per episode. `0` disables DL resolution. |

For Nuvio, keep `SOURCE_PROVIDER_TIMEOUT_MS` and `ANIMEPAHE_DEADLINE_MS` at or
below `30000`. Nuvio gives a plugin request roughly 60 seconds, and the first
request after the app wakes also pays the cold-start cost. A 45-second provider
budget can consume the whole client window before the API responds.

Full list: [`.env.example`](../.env.example).

Never commit `.env`, TMDB keys, database URLs, or source URLs you are not
allowed to distribute.

## 4. First deploy

The boot sequence is:

1. Load `.env` when present (local only).
2. Validate configuration. In production, missing `DATABASE_URL` stops startup.
3. Create the PostgreSQL pool.
4. Run pending migrations under a PostgreSQL advisory lock.
5. Start the HTTP server on `PORT`.

Migrations run automatically at boot. There is no separate migration endpoint by
design. If migration fails after five retries, the app exits instead of serving
traffic against a partial schema.

After the first deploy, verify:

```bash
BASE=https://<your-app>

curl -i "$BASE/health"
curl "$BASE/api/status"
curl "$BASE/api/search?q=frieren&limit=3"
curl "$BASE/api/anime/anilist:154587"
curl "$BASE/api/anime/anilist:154587/episodes?limit=3"
```

Expected:

- `/health` returns `200` with `"status": "ok"` and `database.ok: true`.
- `/api/status` returns `"database.ok": true` and
  `"cache.driver": "memory+postgres"`.
- Search returns at least one AniList result.
- If TMDB is configured, anime artwork points at `image.tmdb.org`.
- If TMDB is not configured, search and AniList details still work, but
  `tmdb:` IDs and TMDB season layouts are unavailable.

OpenAPI-style details and exact response shapes: [api.md](api.md).

## 5. Add authorized sources

The API returns an empty source list until you add a URL you are authorized to
distribute. Being able to reach a page is not authorization.

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --language ja \
  --url "https://your-authorized-cdn.example/episode-1.m3u8"
```

For a TMDB-matched TV catalogue, include `--season`; for an AniList-only run or
a movie, omit it. This must match the `seasonNumber` returned by
`/api/anime/:id/episodes`. See [sources.md](sources.md).

**Database access:** `source:add` needs a `DATABASE_URL` reachable from the
machine where you run it. The API deliberately has no admin HTTP endpoint. Use
one of these:

- a one-off shell/command offered by Antideploy, with the app's injected
  `DATABASE_URL`;
- a secure tunnel or direct connection if the platform provides one;
- your normal migration/operations process against the production database.

Do not expose the database publicly just to run a CLI.

Add subtitles the same way:

```bash
npm run subtitle:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --kind external \
  --language en \
  --label "English" \
  --format vtt \
  --url "https://your-authorized-cdn.example/episode-1.en.vtt"
```

## 6. Verify sources and subtitles

```bash
curl "$BASE/api/episode/anilist:154587:e1/sources"
curl "$BASE/api/episode/anilist:154587:e1/subtitles"
```

- An empty `sources` list with a warning means the catalogue has no matching
  row. Re-check the canonical anime ID, season, episode number and label.
- A source with `"delivery": "stream"` is ready. `DL` is only a label; there is
  no download action.
- External subtitle files appear in `tracks`. Embedded or hardcoded subtitles
  appear only in `embedded` with `"selectable": false`.

## 7. Sleep, cold starts and the 1 GB limit

Antideploy may suspend an idle app. Expect:

- the next request to take several seconds while the instance wakes;
- in-memory caches and rate-limit buckets to reset;
- PostgreSQL data to persist;
- the first request after wake to be slower than later ones.

The defaults are chosen for one small instance:

- PostgreSQL pool: 5 connections;
- upstream concurrency: 6;
- memory cache: 500 entries;
- no background workers or cron jobs.

Do not raise `HTTP_MAX_CONCURRENCY` aggressively on a shared vCPU. If you add
heavy source providers later, measure before increasing it.

## 8. Health checks and uptime

Use `GET /health` for platform health checks:

- `200` means the process is up and PostgreSQL answers;
- `503` means PostgreSQL is unavailable or `DATABASE_URL` is missing.

`/health` does not call AniList or TMDB. A metadata outage therefore does not
mark the app unhealthy; affected requests return `502` or stale cached data.

`/api/status` is for humans and dashboards. It always returns `200` so you can
read the detailed status.

## 9. Logs

Logs are single-line JSON on stdout:

```json
{"time":"2026-11-12T12:00:00.000Z","level":"info","message":"request","requestId":"...","method":"GET","path":"/api/search","status":200,"durationMs":84}
```

- Request query strings are not logged.
- API keys, authorization headers, cookies and similarly named fields are
  redacted.
- URL query strings are removed before logging.
- `requestId` matches the `X-Request-Id` response header.

Set `LOG_LEVEL=debug` temporarily when diagnosing. Do not log source URLs with
tokens in your own additions.

## 10. Rollback and schema safety

- Deployments are replaceable: roll back by redeploying the previous build.
- `001_init.sql` is additive and idempotent (`create table if not exists`).
- Migrations are recorded in `schema_migrations` and applied once, in filename
  order, under an advisory lock.
- **Take a database backup before a destructive migration.** Current code does
  not drop or rewrite existing source/subtitle rows.
- If a future migration would rename or drop a column, use an expand/migrate/
  contract sequence rather than a single destructive step.

The full schema is documented in [database.md](database.md).

## 11. Scaling notes

The current design assumes one instance:

- rate limiting is in-process;
- the L1 cache is per process;
- request coalescing is per process.

If you later run multiple instances, move rate limiting to a shared store and
accept that each instance has its own L1 cache. PostgreSQL remains the shared L2
cache and the source of truth for matches, sources and subtitles.

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| App exits at boot with `DATABASE_URL is not set` | No database attached, or `NODE_ENV=production` without the variable | Attach Antideploy PostgreSQL; do not unset the injected variable. |
| Boot fails at migration | Database asleep, unreachable, or insufficient privileges | Check database status and credentials. The app retries five times with backoff. |
| `/health` returns `503` | PostgreSQL check failed | Inspect platform database status and connection limits. |
| `tmdb:` ID returns `503 provider_error` | No TMDB key/token | Set `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN`, then redeploy/restart. |
| Anime has no poster or banner | TMDB not configured, or no confident match | Configure TMDB. AniList artwork is used only when TMDB has none. |
| Episodes have `source: "anilist"` and no seasons | No TMDB match | Expected fallback. Add sources with no `--season`, because `seasonNumber` is `null`. |
| `season_unavailable` | Asked an AniList-only title for season 2+, or a season TMDB does not list | Omit `season` or use a season from `data.seasons`. |
| Sources list is empty | No matching authorized row | Check canonical `animeId`, `seasonNumber`, `episodeNumber`, `label`, `enabled`, `expires_at`. See [sources.md](sources.md). |
| Sources disappeared | `expires_at` passed | Add a fresh URL. Rows are excluded 15 seconds before expiry. |
| All requests get `429` | Rate limit too low, or every request shares one proxy address | Raise `RATE_LIMIT_MAX`, or set `TRUST_PROXY=true` only if the proxy is trusted. |
| First request after idle is slow | App was asleep | Expected on the platform. Use a warm-up request before a demo. |
| Search returns nothing for a valid title | AniList query spelling, or upstream outage | Try romaji/English title. Check `meta.stale` and logs for `provider_error`. |

## 13. Pre-launch checklist

- [ ] Repository connected and build passes on Node 22.
- [ ] PostgreSQL 17 attached; `DATABASE_URL` injected.
- [ ] `NODE_ENV=production`.
- [ ] TMDB key or token set (recommended).
- [ ] `CORS_ORIGINS` set to exact origins, or deliberately left empty.
- [ ] `TRUST_PROXY` matches the platform proxy setup.
- [ ] `/health` returns `200`.
- [ ] Search, anime, episodes, sources and subtitles checked with `curl`.
- [ ] Authorized sources and subtitles added; no unlicensed URLs.
- [ ] Logs checked for secrets and unexpected errors.
- [ ] Rate limit suitable for expected traffic.
- [ ] Rollback build identified.
- [ ] Database backup taken before future destructive migrations.
