# Database and schema

PostgreSQL is the durable tier for caching, metadata matches, authorized
sources and subtitle records. Antideploy supplies PostgreSQL 17 and injects
`DATABASE_URL`; no Redis add-on is involved.

Schema file: [`migrations/001_init.sql`](../migrations/001_init.sql).

## Migrations

- Migrations live in `migrations/` as numbered `.sql` files.
- At boot, `src/db/migrate.ts` connects with a PostgreSQL advisory lock
  (`7231984551`), creates `schema_migrations` if needed, and applies each file in
  filename order.
- Each file runs inside a transaction and is recorded in `schema_migrations`.
- Applied files are skipped on later boots.
- Transient connection failures are retried five times with exponential backoff
  (1 s, 2 s, 4 s, 8 s).
- If migrations still fail, the process exits. It does not serve against a
  partial schema.
- There is no migration HTTP endpoint. `npm run db:migrate` is available for
  local use or a one-off platform command.

Adding a migration:

```text
migrations/002_add_something.sql
```

Use additive changes when possible. For a destructive change, take a backup and
use an expand → migrate → verify → contract sequence so old and new app versions
can overlap safely.

## Tables

### `schema_migrations`

| Column | Type | Notes |
| --- | --- | --- |
| `version` | `text` primary key | Migration filename. |
| `applied_at` | `timestamptz` | Defaults to `now()`. |

### `cache_entries`

Shared L2 cache. The app also has an in-process L1 cache in front of it.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | `text` primary key | Versioned cache key, for example `anime:v2:anilist:20`. |
| `value` | `jsonb` | Cached JSON value. |
| `expires_at` | `timestamptz` | Fresh until this time. |
| `stale_until` | `timestamptz` | May be served after `expires_at` if the upstream fails. |
| `created_at` | `timestamptz` | Insert time. |

Index: `cache_entries_stale_until_idx` on `stale_until`.

Lifecycle:

- Reads only return rows where `stale_until > now()`.
- Writes upsert by key and extend staleness by the configured stale TTL.
- Every 100 writes, the app deletes rows where `stale_until <= now()`.
- Source and subtitle responses are stored **memory-only** in the cache service
  and never written here, because signed URLs are short-lived.
- The cache stores metadata, search pages, episode catalogues and matches. It is
  safe to truncate when the app is stopped if you need to force refreshes:

  ```sql
  truncate cache_entries;
  ```

### `metadata_matches`

Persists successful AniList → TMDB matches so fuzzy matching is not repeated.

| Column | Type | Notes |
| --- | --- | --- |
| `anilist_id` | `integer` primary key | AniList media ID. |
| `tmdb_id` | `integer` | TMDB ID. |
| `media_type` | `text` | `tv` or `movie`; check constraint. |
| `confidence` | `numeric(4,3)` | 0–1; check constraint. |
| `matched_title` | `text` | Title that was matched, for diagnostics. |
| `matched_year` | `integer` | Year used for disambiguation. |
| `updated_at` | `timestamptz` | Last match save. |

Index: `metadata_matches_tmdb_idx` on `(tmdb_id, media_type)`.

The table is populated by the metadata service. It is not required for AniList
or TMDB to work; deleting a row simply causes the next request to match again.

### `authorized_sources`

Operator-controlled streaming catalogue. **The API never inserts rows here at
runtime.** Use `npm run source:add` or SQL.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` primary key | Stable source ID. |
| `provider_id` | `text` | Default `catalog`. |
| `anime_id` | `text` | Canonical ID, `anilist:<n>` or `tmdb:<n>`. |
| `season_number` | `integer` nullable | `NULL` for AniList-only catalogues and movies. `0` is TMDB specials. |
| `episode_number` | `numeric(10,2)` | Check `>= 0`. Episode IDs use integers. |
| `label` | `text` | `sub`, `dub` or `dl`; check constraint. |
| `language` | `text` nullable | Audio language. |
| `quality` | `text` nullable | Display/sort value, for example `1080p`. |
| `stream_type` | `text` | `hls`, `dash` or `mp4`; check constraint. |
| `url` | `text` | Must match `^https?://`. |
| `headers` | `jsonb` | Playback headers; default `{}`. |
| `expires_at` | `timestamptz` nullable | Excluded 15 seconds before this time. |
| `enabled` | `boolean` | Default `true`. |
| `created_at` / `updated_at` | `timestamptz` | Timestamps. |

Indexes:

- unique identity on
  `(provider_id, anime_id, coalesce(season_number, -1), episode_number, label, coalesce(quality, ''))`;
- partial lookup index on `(anime_id, season_number, episode_number)` where
  `enabled = true`.

The unique identity makes duplicate source variants fail loudly instead of
silently producing repeated streams.

### `authorized_subtitles`

Operator-controlled subtitle catalogue.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` primary key | Stable subtitle ID. |
| `provider_id` | `text` | Default `catalog`. |
| `anime_id` | `text` | Canonical anime ID. |
| `season_number` | `integer` nullable | Same rules as sources. |
| `episode_number` | `numeric(10,2)` | Check `>= 0`. |
| `kind` | `text` | `external` or `embedded`; check constraint. |
| `language` | `text` | Required language code or label. |
| `label` | `text` | Display label. |
| `format` | `text` nullable | `srt` or `vtt` for external tracks. |
| `url` | `text` nullable | External tracks only; must match HTTP(S). |
| `headers` | `jsonb` | Playback headers; default `{}`. |
| `is_default` | `boolean` | Preferred track. |
| `enabled` | `boolean` | Default `true`. |
| `created_at` / `updated_at` | `timestamptz` | Timestamps. |

Constraints:

- `external` must have both `format` and `url`;
- `embedded` must have no `url`.

Unique identity on
`(provider_id, anime_id, coalesce(season_number, -1), episode_number, kind, language, label)`.

Embedded rows are exposed only in `data.embedded` with
`"selectable": false`. They are never returned in `data.tracks`.

## Data flow

```text
Request
  -> in-process memory cache (L1)
  -> PostgreSQL cache (L2)
  -> AniList / TMDB HTTP providers
  -> cache write (except source/subtitle responses)
```

Sources and subtitles take a different path:

```text
Episode request
  -> episode catalogue cache
  -> authorized_sources / authorized_subtitles (PostgreSQL)
  -> memory-only response cache
```

## Local database

Requirements: PostgreSQL 17+.

```bash
createdb animepahe
export DATABASE_URL=postgres://localhost:5432/animepahe
npm run db:migrate
```

The default `.env.example` uses
`postgres://postgres:postgres@localhost:5432/animepahe`.

## Operational queries

```sql
-- Applied migrations
select * from schema_migrations order by version;

-- Source counts by label
select label, count(*) from authorized_sources
where enabled group by label order by label;

-- Rows expiring in the next day
select id, anime_id, season_number, episode_number, label, expires_at
from authorized_sources
where enabled and expires_at is not null and expires_at < now() + interval '1 day'
order by expires_at;

-- Subtitle inventory
select kind, count(*) from authorized_subtitles
where enabled group by kind;

-- Cache size
select count(*), pg_size_pretty(pg_total_relation_size('cache_entries'))
from cache_entries;
```

## Backup and restore

Use the platform's PostgreSQL backup facility where available. Before any
destructive migration, take a logical backup:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=anime-api-before-migration.dump
```

Restore into a fresh database, then verify migrations and a few endpoints before
switching traffic:

```bash
pg_restore --dbname "$NEW_DATABASE_URL" --clean --if-exists anime-api-before-migration.dump
DATABASE_URL="$NEW_DATABASE_URL" npm run db:migrate
```

Source and subtitle rows are the only data that cannot be regenerated from
AniList or TMDB. Back them up before risky changes.
