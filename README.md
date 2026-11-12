# Nuvio Anime

An independent anime metadata and authorized-source API, plus the NuvioTV plugin
that talks to it.

The API joins official metadata (AniList and TMDB) with a catalogue of stream
URLs an operator is authorized to distribute. It is **not** a proxy, and it does
**not** bypass Cloudflare, CAPTCHAs, logins or DRM.

- **Production API:** <https://nuvio-anime-api.antideploy.app>
- **Repository:** <https://github.com/shivam7042263411-coder/Nuvio-Anime>
- **Runtime:** Node.js 22 + TypeScript
- **Framework:** Hono
- **Database:** PostgreSQL 17
- **Cache:** in-process memory + PostgreSQL (no Redis)
- **Hosting:** [Antideploy](https://antideploy.com), one instance, scales to zero

> **Status:** the API is deployed and metadata endpoints are verified live.
> Playable sources are not yet configured, AnimePahe is **disabled**, and live
> playback on a NuvioTV device has **not** been verified.

---

## Contents

- [What Nuvio Anime is](#what-nuvio-anime-is)
- [Architecture](#architecture)
- [API endpoints](#api-endpoints)
- [NuvioTV plugin](#nuviotv-plugin)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Configuring TMDB securely](#configuring-tmdb-securely)
- [Database and migrations](#database-and-migrations)
- [Tests and build](#tests-and-build)
- [Adding source providers](#adding-source-providers)
- [Current provider status and limitations](#current-provider-status-and-limitations)
- [Security](#security)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [License and compliance](#license-and-compliance)

---

## What Nuvio Anime is

Nuvio Anime has two parts that ship together in this repository:

1. **The central Anime API** — a TypeScript/Hono service that resolves anime
   metadata and episodes, then returns Sub/Dub/DL streaming sources and external
   subtitle tracks from providers the operator has enabled.
2. **The NuvioTV plugin** — a small QuickJS-compatible JavaScript adapter that
   calls only the central API and maps its responses into Nuvio's stream result
   shape.

Metadata comes from AniList (no key required) and, when configured, TMDB. Source
URLs come from the authorized-source catalogue and optionally from a
server-side provider such as AnimePahe. AnimePahe is disabled by default and is
disabled on the current production deployment.

The API deliberately does not solve CAPTCHAs, bypass Cloudflare, impersonate
logins, defeat DRM, download files, or present hardcoded subtitles as selectable
tracks. If no source is configured, `/sources` returns a successful, empty list
instead of inventing one.

## Architecture

```text
NuvioTV
  └── nuvio-plugin/nuvio-anime-api.js
        ├── GET /api/anime/tmdb:<id>
        ├── GET /api/episode/tmdb:<id>:s<season>:e<episode>/sources
        └── GET /api/episode/tmdb:<id>:s<season>:e<episode>/subtitles
                     │
                     ▼
              Central Anime API (Hono)
                ├── metadata/   AniList + TMDB, deterministic ID matching
                ├── episodes/   canonical episode IDs, TMDB/AniList catalogues
                ├── sources/    provider interface + authorized catalogue
                ├── subtitles/  SRT/VTT parsing, external and embedded tracks
                ├── cache/      memory + PostgreSQL, stale-on-error
                └── http/       timeouts, retries, concurrency limits
                     │
                     ▼
                PostgreSQL 17
                  cache_entries, metadata_matches,
                  authorized_sources, authorized_subtitles
```

Key behaviours:

- IDs are canonical: anime `anilist:20` / `tmdb:1429`; episodes
  `anilist:20:e1`, `anilist:16498:s2:e5`, `tmdb:1429:s1:e3`.
- Each source provider runs inside its own timeout budget. A slow or failing
  provider is reported as a warning and does not block the rest of the response.
- `DL` is a **stream label**, not a download endpoint. Every source is returned
  with `delivery: "stream"`.
- Errors are sanitized; internal provider messages and credentials are not
  returned to clients.

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Service name, version and endpoint index |
| GET | `/health` | Health check; `503` when the database is unavailable |
| GET | `/api/status` | Runtime, database, cache and provider status |
| GET | `/api/search?q=naruto` | Search AniList catalogues |
| GET | `/api/anime/:id` | Anime details, artwork and TMDB match |
| GET | `/api/anime/:id/episodes` | Episode catalogue, paginated, optional `season` |
| GET | `/api/episode/:id` | One episode |
| GET | `/api/episode/:id/sources` | Sub/Dub/DL streaming sources |
| GET | `/api/episode/:id/subtitles` | External tracks and embedded-subtitle facts |

Examples:

```bash
curl https://nuvio-anime-api.antideploy.app/api/status
curl "https://nuvio-anime-api.antideploy.app/api/search?q=naruto"
curl https://nuvio-anime-api.antideploy.app/api/anime/anilist:1
curl "https://nuvio-anime-api.antideploy.app/api/anime/anilist:1/episodes?limit=3"
```

See [docs/api.md](docs/api.md) for parameters, response shapes and error codes.

## NuvioTV plugin

The adapter is in [`nuvio-plugin/`](nuvio-plugin/) and consists of exactly two
files:

```text
nuvio-plugin/
├── manifest.json
└── nuvio-anime-api.js
```

- `nuvio-anime-api.js` implements
  `getStreams(tmdbId, mediaType, season, episode)`. It calls only the central
  API, never AniList, TMDB or AnimePahe directly.
- `manifest.json` declares one scraper (`anime-api`) for `movie` and `tv`, with
  formats `m3u8`, `mpd` and `mp4`.
- The default API base is already set to the production API:

  ```js
  var DEFAULT_API_BASE = "https://nuvio-anime-api.antideploy.app";
  ```

  `globalThis.ANIME_API_URL` (or `process.env.ANIME_API_URL` where available)
  overrides it. Trailing slashes are normalized.

### Install in NuvioTV

1. Add this repository as a local or GitHub plugin repository:

   ```text
   https://github.com/shivam7042263411-coder/Nuvio-Anime
   ```

2. NuvioTV needs `manifest.json` and `nuvio-anime-api.js` together. In this
   repository they live in `nuvio-plugin/`. If your Nuvio build accepts a plugin
   directory, select that directory; if it expects the manifest at the
   repository root, point it at the `nuvio-plugin` path supported by your build.
3. Enable **Anime API**.
4. Play a movie or TV episode from a TMDB-backed catalogue.
5. Check Nuvio's plugin logs for `[Anime API]` lines.

Nuvio sends TMDB IDs, so the API needs TMDB configured for the plugin to resolve
titles and episodes. The adapter returns an empty list rather than failing when
the API is unreachable or no source exists.

Do not install the separate standalone AnimePahe plugin project alongside this
adapter unless you specifically want that second plugin.

## Local development

Requirements: Node.js 22 and PostgreSQL 17+.

```bash
npm ci
cp .env.example .env
# Edit .env: set DATABASE_URL, and optionally TMDB_API_KEY or TMDB_ACCESS_TOKEN
npm run db:migrate
npm run dev
```

Smoke test:

```bash
curl http://localhost:3000/api/status
curl "http://localhost:3000/api/search?q=naruto"
curl http://localhost:3000/api/anime/anilist:20
curl "http://localhost:3000/api/anime/anilist:20/episodes?limit=5"
```

Production-style start:

```bash
npm run build
npm start
```

The server reads `PORT` and binds `0.0.0.0`. Migrations run at boot before the
server starts.

## Configuration

All configuration is environment variables. See [.env.example](.env.example).
Values below are placeholders; never commit real credentials.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Production | PostgreSQL connection string, e.g. `postgres://user:password@host:5432/db`. Antideploy injects it automatically. |
| `PORT` | No | Listen port. Supplied by the platform; defaults to `3000`. |
| `NODE_ENV` | No | `production` on the server. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn` or `error`. |
| `TMDB_API_KEY` | No | TMDB v3 API key. Enables artwork and season layouts. |
| `TMDB_ACCESS_TOKEN` | No | Alternative TMDB v4 read access token. |
| `CORS_ORIGINS` | No | Comma-separated browser origins. Empty means no CORS headers. |
| `TRUST_PROXY` | No | `true` only when a trusted proxy supplies `X-Forwarded-For`. |
| `RATE_LIMIT_ENABLED` | No | Default `true`. |
| `RATE_LIMIT_WINDOW_SECONDS` | No | Default `60`. |
| `RATE_LIMIT_MAX` | No | Requests per window. Default `90`. |
| `SOURCE_CATALOG_ENABLED` | No | Enables the authorized catalogue. Default `true`. |
| `SOURCE_ANIMEPAHE_ENABLED` | No | Enables AnimePahe. Default and production value: `false`. |
| `SOURCE_PROVIDER_TIMEOUT_MS` | No | Per-provider budget. Default `45000`. |
| `ANIMEPAHE_DEADLINE_MS` | No | AnimePahe request deadline. Default `45000`. |
| `*_CACHE_TTL` | No | Cache lifetimes in seconds. |

Current production configuration is stored in Antideploy's encrypted variable
store. No values are present in this repository.

## Configuring TMDB securely

TMDB is optional for AniList-only use but required for NuvioTV, because Nuvio
sends TMDB IDs.

1. Create a key in your TMDB account.
2. Set **either** `TMDB_API_KEY` (v3) **or** `TMDB_ACCESS_TOKEN` (v4 read token)
   in your host's secret manager. For Antideploy, use the application's
   Environment variables page.
3. Never add the value to `.env.example`, a README, a test fixture, a commit or
   a chat message.
4. Redeploy or restart so the running process receives the new value.
5. If a key was ever pasted into a chat, issue, or log, rotate it in TMDB and
   update the secret.

The app reports only whether TMDB is configured (`/api/status` → `tmdb: true`).
It never returns the key.

## Database and migrations

- PostgreSQL 17 is required in production.
- `migrations/001_init.sql` creates `schema_migrations`, `cache_entries`,
  `metadata_matches`, `authorized_sources` and `authorized_subtitles`.
- The migration runner takes an advisory lock, applies each file in a
  transaction, records the version, and is idempotent on restart.
- Migrations run automatically at boot (`src/index.ts`), and can be run manually
  with `npm run db:migrate`.
- Do not edit applied migrations. Add a new numbered file instead.

See [docs/database.md](docs/database.md).

## Tests and build

```bash
npm run typecheck
npm test
npm run build
node --check nuvio-plugin/nuvio-anime-api.js
```

The suite currently has **101 tests across 12 files**, covering search, metadata
matching, anime details, episode catalogues, subtitle parsing, invalid input,
upstream failures, cache expiry and stale fallback, source labels, multiple
independent providers, cross-provider deduplication, provider timeouts,
AnimePahe matching, Sub/Dub/DL normalization, and the Nuvio adapter inside a
QuickJS-style VM.

## Adding source providers

### Authorized catalogue URLs

Add sources you are allowed to distribute with the CLI:

```bash
npm run source:add -- \
  --anime anilist:20 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --language ja \
  --url "https://your-authorized-cdn.example/episode-1.m3u8"
```

`--label` is `sub`, `dub` or `dl`. Add external subtitles with
`npm run subtitle:add`. See [docs/sources.md](docs/sources.md).

### A new provider

Providers are independent: the API already runs every configured provider in
parallel, isolates failures, applies one timeout, normalizes each result and
deduplicates across providers. Adding one does not change the Nuvio adapter or
the database schema.

1. Implement the `SourceProvider` interface in `src/sources/types.ts`:

   ```ts
   interface SourceProvider {
     readonly id: string;
     readonly name: string;
     isConfigured(): boolean;
     getSources(context: SourceContext): Promise<ProviderResult>;
     getSubtitles?(context: SourceContext): Promise<ProviderSubtitleResult>;
   }
   ```

2. Place the implementation under `src/sources/<provider>/`.
3. Add a disabled-by-default flag and validation in `src/config.ts`:

   ```ts
   example: { enabled: readBool(env, "SOURCE_EXAMPLE_ENABLED", false) }
   ```

4. Register it once in the `sourceProviders` array in `src/container.ts`.
5. Return only `delivery: "stream"` sources with `http(s)` URLs; never build
   download actions. The service canonicalizes labels (`Sub`/`Dub`/`DL`), stream
   types (`hls`/`dash`/`mp4`), headers and expiry, and drops malformed entries
   with a warning instead of forwarding them.
6. Add tests with synthetic fixtures. Do not call live sites in tests.
7. Respect the provider timeout budget and report failures as warnings.
8. Check `/api/status`: `providers.sourceProviders` lists every registered
   provider with `configured` and subtitle capability.

See [docs/sources.md](docs/sources.md) for a complete skeleton and the runtime
guarantees.

## Current provider status and limitations

| Component | Status |
| --- | --- |
| AniList metadata | Enabled; live-verified in production |
| TMDB metadata and season episodes | Enabled; live-verified in production |
| Authorized source catalogue | Enabled, but **no source rows are configured** |
| AnimePahe | **Disabled** (`SOURCE_ANIMEPAHE_ENABLED=false`) |
| NuvioTV playback on a device | **Not verified** |

Known limitations:

- `/sources` and `/subtitles` currently return empty lists in production because
  no authorized catalogue entries exist and AnimePahe is off.
- Live AnimePahe behaviour is unverified; enabling it requires authorization and
  acceptance of the upstream site's terms.
- The API is public and unauthenticated. Rate limiting is the protection; a key
  embedded in a client plugin would not be secret.
- Production runs one instance and sleeps when idle. The first request after an
  idle period can take several seconds.
- `TRUST_PROXY` is `false` in production because the trusted proxy header chain
  has not been verified, so clients effectively share one rate-limit bucket.

## Security

- Secrets belong in the host's encrypted environment store, not in Git.
- `.env`, build output, dependencies, caches, local databases and debug logs are
  ignored by Git.
- Response errors are sanitized; the app does not log request query strings and
  redacts URLs before logging.
- The API does not bypass Cloudflare, CAPTCHAs, authentication, DRM or upstream
  rate limits.
- Report a suspected leaked credential by rotating it at the provider first, then
  updating the host's secret and redeploying.

## Project structure

```text
.
├── src/                       API source
├── tests/                     unit, API, provider and plugin tests
├── nuvio-plugin/
│   ├── manifest.json
│   └── nuvio-anime-api.js
├── migrations/                PostgreSQL schema
├── scripts/                   migrate, add source, add subtitle, inspect subtitle
├── docs/                      API, database, deployment, Nuvio and source guides
├── .env.example               configuration template (placeholders only)
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
└── vitest.config.ts
```

## Documentation

- [API reference](docs/api.md)
- [Database and migrations](docs/database.md)
- [Sources and subtitles](docs/sources.md)
- [NuvioTV adapter](docs/nuvio.md)
- [Deployment](docs/deployment.md)

`docs/final-report.md` and `docs/integration-report.md` are historical
engineering reports from before the live deployment.

## License and compliance

Use this API only with metadata providers and source URLs you are authorized to
use. AniList and TMDB have their own terms. Do not add sources you do not have
permission to distribute.
