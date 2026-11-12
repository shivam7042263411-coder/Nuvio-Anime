# API reference

Base URL in production:

```text
https://<your-antideploy-app>
```

All endpoints are `GET` and return JSON. There is no API key or login. The public
deployment is rate-limited by client address; see [Rate limiting](#rate-limiting).

## Response envelope

Success:

```json
{
  "data": {},
  "meta": {
    "requestId": "7f6c2f7e-7f5f-4a41-9f04-8b6a1a8c1f11",
    "timestamp": "2026-11-12T12:00:00.000Z",
    "cached": false,
    "stale": false
  }
}
```

Error:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Invalid request parameters",
    "details": {
      "issues": [
        { "path": "q", "message": "q must be at least 2 characters" }
      ]
    }
  },
  "meta": {
    "requestId": "7f6c2f7e-7f5f-4a41-9f04-8b6a1a8c1f11",
    "timestamp": "2026-11-12T12:00:00.000Z"
  }
}
```

`meta` may also contain:

| Field | Meaning |
| --- | --- |
| `cached` | The value came from memory or PostgreSQL cache. |
| `stale` | An upstream provider failed, so a cached value older than its TTL was served. |
| `warnings` | Human-readable notes, for example an unavailable provider or missing authorized sources. |
| `pagination` | Page information for list endpoints. |
| `providers` | Source providers that answered the request. |
| `selectableTrackCount` | Number of external subtitle tracks returned. |

### Response headers

| Header | Meaning |
| --- | --- |
| `X-Request-Id` | Request identifier. Send `X-Request-Id` to reuse your own value (8–80 safe characters). |
| `X-RateLimit-Limit` | Requests allowed per window. |
| `X-RateLimit-Remaining` | Requests left in the current window. |
| `X-RateLimit-Reset` | Unix timestamp when the window resets. |
| `Retry-After` | Present on some `429` and upstream throttling responses. |
| `Cache-Control: no-store` | `/api/status`, `/health`, `/sources` and `/subtitles` responses. |

## IDs

Anime IDs are canonical and explicit about the metadata source:

```text
anilist:20
tmdb:1429
```

Episode IDs add an episode number, and optionally a season number:

```text
anilist:20:e1          # season omitted (AniList single run, or a movie)
anilist:16498:s2:e5    # TMDB season 2, episode 5
tmdb:1429:s1:e3
tmdb:550:e1            # movie
```

Rules:

- `anilist:16498` and `tmdb:1429` are **inputs**. The API may resolve a TMDB ID
  to an AniList canonical ID. In that case `data.id` is `anilist:...` and
  `data.requestedId` records the TMDB ID you asked for.
- Use the `id` values returned by the API. They are guaranteed to work with the
  episode and source endpoints.
- Episode IDs exposed by `/episodes` are always the safest IDs to call next.
- `season` can be omitted for AniList-only catalogues. When a TMDB match exists,
  seasons are authoritative and should be included.

## Endpoints

### `GET /` 

Service discovery. Lists the available endpoints and the version.

### `GET /api/status`

Runtime and dependency status. Always returns `200`; inspect `data.status` and
`data.database.ok`.

```bash
curl https://<your-app>/api/status
```

```json
{
  "data": {
    "status": "ok",
    "version": "1.0.0",
    "uptimeSeconds": 42,
    "database": { "ok": true, "latencyMs": 4 },
    "cache": { "driver": "memory+postgres", "memoryEntries": 12 },
    "providers": {
      "anilist": true,
      "tmdb": true,
      "sources": [
        { "id": "catalog", "name": "Authorized source catalogue" }
      ]
    },
    "environment": "production"
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

If `DATABASE_URL` is missing, `status` is `degraded` and the cache driver is
`memory`. In production the app refuses to start without a database.

### `GET /health`

Small production health check. `200` when PostgreSQL responds, `503` otherwise.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "database": { "ok": true, "latencyMs": 4 },
  "timestamp": "2026-11-12T12:00:00.000Z"
}
```

`/health` is excluded from rate limiting so a platform health probe does not
consume a user's quota.

### `GET /api/search`

Search AniList's anime catalogue. Adult titles are excluded.

| Query | Required | Default | Rules |
| --- | --- | --- | --- |
| `q` | Yes | — | 2–100 characters after trimming. |
| `page` | No | `1` | Integer 1–100. |
| `limit` | No | `20` | Integer 1–50. |

```bash
curl "https://<your-app>/api/search?q=attack%20on%20titan&limit=5"
```

```json
{
  "data": {
    "query": "attack on titan",
    "results": [
      {
        "id": "anilist:16498",
        "source": "anilist",
        "anilistId": 16498,
        "malId": 16498,
        "tmdbId": 1429,
        "tmdbMediaType": "tv",
        "titles": {
          "romaji": "Shingeki no Kyojin",
          "english": "Attack on Titan",
          "native": "進撃の巨人",
          "preferred": "Attack on Titan"
        },
        "synonyms": ["AoT", "SnK"],
        "description": "Several hundred years ago...",
        "format": "TV",
        "status": "FINISHED",
        "episodeCount": 25,
        "durationMinutes": 24,
        "season": { "name": "SPRING", "year": 2013 },
        "startDate": { "year": 2013, "month": 4, "day": 7 },
        "endDate": { "year": 2013, "month": 9, "day": 29 },
        "genres": ["Action", "Drama"],
        "averageScore": 85,
        "popularity": 500000,
        "isAdult": false,
        "images": {
          "poster": "https://image.tmdb.org/t/p/w500/...",
          "posterLarge": "https://image.tmdb.org/t/p/original/...",
          "banner": "https://image.tmdb.org/t/p/original/...",
          "color": "#2b2b2b"
        },
        "studios": ["Wit Studio"],
        "externalLinks": [
          { "site": "Official Site", "url": "https://...", "type": "info" }
        ],
        "trailer": { "id": "LHtdKWJdif4", "site": "youtube", "url": "https://www.youtube.com/watch?v=LHtdKWJdif4" },
        "tmdbMatch": {
          "id": 1429,
          "mediaType": "tv",
          "confidence": 0.97,
          "matchedTitle": "Attack on Titan",
          "matchedYear": 2013
        }
      }
    ]
  },
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cached": false,
    "pagination": {
      "page": 1,
      "limit": 5,
      "total": 52,
      "totalPages": 11,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

`tmdbId`, `tmdbMediaType`, TMDB artwork and `tmdbMatch` are only populated when
TMDB is configured and a match passes the scoring threshold. Otherwise the
AniList values are returned unchanged; `tmdbMatch` is `null`.

`season.name` is AniList's broadcast season (`WINTER`, `SPRING`, `SUMMER`,
`FALL`), not a season number.

### `GET /api/anime/:id`

Anime details for `anilist:<n>` or `tmdb:<n>`.

```bash
curl https://<your-app>/api/anime/anilist:16498
```

The `data` object is the same shape as one search result. A TMDB ID can resolve
to an AniList ID:

```json
{
  "data": {
    "id": "anilist:16498",
    "requestedId": "tmdb:1429",
    "titles": { "preferred": "Attack on Titan" },
    "tmdbMatch": { "id": 1429, "mediaType": "tv", "confidence": 0.97 }
  },
  "meta": { "requestId": "...", "timestamp": "...", "cached": false }
}
```

If TMDB is not configured:

- `anilist:<n>` still works, with AniList artwork only.
- `tmdb:<n>` returns `503 provider_error`, because TMDB is the only source that
  can read that ID.

### `GET /api/anime/:id/episodes`

Episode catalogue. Seasons are authoritative when a TMDB match exists. Without
a TMDB match, AniList supplies a single unlabeled episode run.

| Query | Required | Default | Rules |
| --- | --- | --- | --- |
| `season` | No | First normal season, or `1` | Integer 0–100. `0` means specials on TMDB. |
| `page` | No | `1` | Integer 1–1000. |
| `limit` | No | `50` | Integer 1–100. |

```bash
curl "https://<your-app>/api/anime/anilist:16498/episodes?season=2&limit=10"
```

```json
{
  "data": {
    "animeId": "anilist:16498",
    "kind": "tv",
    "source": "tmdb",
    "seasonNumber": 2,
    "seasons": [
      {
        "seasonNumber": 1,
        "name": "Season 1",
        "episodeCount": 25,
        "airDate": "2013-04-07",
        "overview": null,
        "poster": "https://image.tmdb.org/t/p/w500/..."
      }
    ],
    "episodes": [
      {
        "id": "anilist:16498:s2:e1",
        "animeId": "anilist:16498",
        "seasonNumber": 2,
        "episodeNumber": 1,
        "title": "Beast Titan",
        "overview": "A new threat appears.",
        "airDate": "2017-04-01",
        "runtimeMinutes": 24,
        "image": "https://image.tmdb.org/t/p/w780/...",
        "kind": "tv",
        "available": true,
        "metadataAvailable": true,
        "source": "tmdb"
      }
    ],
    "complete": true
  },
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cached": false,
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 12,
      "totalPages": 2,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

Field notes:

- `kind` is `tv` or `movie`. A movie returns exactly one entry with
  `seasonNumber: null` and `episodes[0].id` like `anilist:20:e1`.
- `source` is `tmdb` or `anilist`. It tells you which provider supplied the
  episode list.
- `seasonNumber` at the top level is the selected season, or `null` for a movie
  and for an AniList-only run.
- `seasons` is empty for an AniList-only run or a movie.
- `title`, `overview`, `airDate` and `image` can be `null`. The API never invents
  an episode title. `metadataAvailable: false` means no provider supplied
  episode-specific metadata.
- `available: true` means the episode exists in the catalogue, not that a
  playable source is configured.
- `complete: true` means the provider's episode count has been reached. A false
  value can happen when AniList has fewer streaming entries than the advertised
  episode count.
- `season=0` is TMDB specials. It is never silently mapped to season 1.

AniList-only behaviour:

- Omit `season`, or pass `season=1`. Any other season returns
  `400 season_unavailable`, because AniList does not expose season numbers.
- Episode IDs have no season segment: `anilist:20:e1`.

### `GET /api/episode/:id`

One episode from its catalogue.

```bash
curl https://<your-app>/api/episode/anilist:16498:s2:e1
```

```json
{
  "data": {
    "id": "anilist:16498:s2:e1",
    "animeId": "anilist:16498",
    "seasonNumber": 2,
    "episodeNumber": 1,
    "title": "Beast Titan",
    "overview": "A new threat appears.",
    "airDate": "2017-04-01",
    "runtimeMinutes": 24,
    "image": "https://image.tmdb.org/t/p/w780/...",
    "kind": "tv",
    "available": true,
    "metadataAvailable": true,
    "source": "tmdb"
  },
  "meta": { "requestId": "...", "timestamp": "...", "cached": false }
}
```

If the episode does not exist in the selected season:
`404 episode_not_found`.

### `GET /api/episode/:id/sources`

Playable sources from the operator's authorized source catalogue and, when
explicitly enabled, the optional AnimePahe provider. Both use the same response
contract.

```bash
curl https://<your-app>/api/episode/anilist:16498:s2:e1/sources
```

```json
{
  "data": {
    "episodeId": "anilist:16498:s2:e1",
    "sources": [
      {
        "id": "src_01J...",
        "provider": "catalog",
        "providerName": "Authorized source catalogue",
        "label": "Sub",
        "language": "ja",
        "quality": "1080p",
        "type": "hls",
        "delivery": "stream",
        "url": "https://licensed-cdn.example/episode.m3u8",
        "headers": { "Referer": "https://example.com/" },
        "expiresAt": "2027-01-01T00:00:00.000Z",
        "temporary": true,
        "name": "Licensed release",
        "size": "1.2GB"
      }
    ]
  },
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cached": false,
    "providers": [
      { "id": "catalog", "name": "Authorized source catalogue" }
    ]
  }
}
```

Field notes:

- `provider` is `catalog` or `animepahe`. `providerName` is a display label.
- `label` is `Sub`, `Dub` or `DL`.
- **`DL` is a streaming label, not a download action.** Every source has
  `delivery: "stream"`. There is no download endpoint.
- `language` is the audio language code or name, not the label. Use `label` for
  Sub/Dub.
- `type` is `hls`, `dash` or `mp4`.
- `headers` contains playback headers the client should send. It can be `{}`.
- `expiresAt` is `null` or an ISO timestamp. Rows expire 15 seconds early to
  avoid handing out a URL that dies in flight.
- `temporary: true` means the URL should not be treated as permanent.
- `name` and `size` are optional provider detail. `size` is informational only;
  it is not a download size or a download action.
- If no source is configured, the response is `200` with an empty `sources`
  array and a warning explaining how to add authorized sources.
- If every configured provider fails, the response is `502 provider_error`.
  Partial success returns the working providers' sources plus a warning.
- Sources are cached in memory only (default 60 seconds) and are never written
  to the PostgreSQL cache, because signed URLs are short-lived.
- `Cache-Control: no-store` is set.

### `GET /api/episode/:id/subtitles`

Selectable external subtitle tracks, plus factual embedded-subtitle labels.

```bash
curl https://<your-app>/api/episode/anilist:16498:s2:e1/subtitles
```

```json
{
  "data": {
    "episodeId": "anilist:16498:s2:e1",
    "tracks": [
      {
        "id": "sub_01J...",
        "language": "en",
        "label": "English",
        "format": "vtt",
        "url": "https://licensed-cdn.example/episode.en.vtt",
        "headers": {},
        "isDefault": true,
        "source": "catalog",
        "selectable": true
      }
    ],
    "embedded": [
      {
        "language": "en",
        "label": "English (hardsub)",
        "source": "catalog",
        "selectable": false
      }
    ]
  },
  "meta": {
    "requestId": "...",
    "timestamp": "...",
    "cached": false,
    "selectableTrackCount": 1
  }
}
```

Rules:

- Only `tracks` are selectable subtitle files. They are external SRT/VTT URLs.
- Tracks can come from the authorized subtitle catalogue and, when enabled, a
  source provider such as AnimePahe. The API normalizes and deduplicates them.
- `embedded` describes hardcoded or in-stream subtitles. These entries are
  informational only, have `selectable: false`, and **must never be advertised
  as selectable tracks**. A player cannot switch them off.
- If no external track exists, `tracks` is empty. The API does not guess or
  copy embedded subtitles into `tracks`.
- Subtitle responses are memory-only cached (default 120 seconds) and set
  `Cache-Control: no-store`.

## Errors

| HTTP | `error.code` | When |
| --- | --- | --- |
| `400` | `invalid_request` | Bad query, ID format, page or limit. `details.issues` lists fields. |
| `400` | `season_unavailable` | Requested season is not in the catalogue, or an AniList-only title was asked for a season other than `1`. |
| `404` | `not_found` | Unknown route. |
| `404` | `anime_not_found` | AniList/TMDB does not know the anime, or a TMDB ID was not found on either endpoint. |
| `404` | `episode_not_found` | Episode does not exist in the catalogue. |
| `429` | `rate_limited` | Client exceeded `RATE_LIMIT_MAX`; `Retry-After` is set. |
| `502` | `provider_error` | AniList/TMDB failed, returned invalid JSON, or all source providers failed. |
| `503` | `provider_error` | A required provider is not configured (for example, a `tmdb:` request without a TMDB key). |
| `504` | `provider_error` | An upstream request timed out. |
| `500` | `internal_error` | Unexpected server error. Details are logged, not returned. |

Provider errors never include API keys, authorization headers or request query
strings in the response or logs. The logger redacts credential-shaped fields
and URL query strings.

## Caching and stale data

| Data | Default TTL | Cache tier |
| --- | --- | --- |
| Search results | 300 s | memory + PostgreSQL |
| Anime metadata | 6 h | memory + PostgreSQL |
| Episode catalogue | 6 h | memory + PostgreSQL |
| TMDB/AniList match | 24 h | memory + PostgreSQL |
| Sources | 60 s | memory only |
| Subtitles | 120 s | memory only |
| Stale grace | 7 days | memory + PostgreSQL |

TTLs are configured with environment variables; see [.env.example](../.env.example).

When an upstream provider fails and a cached copy is still within its stale
grace window, the API returns the old value with `meta.stale: true` and a
warning. If there is no usable copy, the provider error is returned. Concurrent
requests for the same missing key are coalesced into one upstream call.

Because the deployment may sleep when idle, the memory tier is lost on wake. The
PostgreSQL tier survives, so metadata and episode catalogues usually come back
without hitting AniList or TMDB.

## Rate limiting

Rate limiting is in-process, per client address, and per instance. Defaults:

```text
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX=90
```

`/health` is exempt. Set `TRUST_PROXY=true` only when a trusted reverse proxy
sets `X-Forwarded-For`; otherwise clients could spoof their address.

If you run more than one instance, each instance has its own counter. The
current Antideploy target is a single instance.

## CORS and headers

By default no CORS headers are sent. Set `CORS_ORIGINS` to a comma-separated
list of exact browser origins, or `*` only for a deliberately public API:

```text
CORS_ORIGINS=https://app.example.com,https://www.example.com
```

The API sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY` and a restrictive `Permissions-Policy`.

## Quick examples

```bash
BASE=https://<your-app>

curl "$BASE/health"
curl "$BASE/api/status"
curl "$BASE/api/search?q=frieren&limit=5"
curl "$BASE/api/anime/anilist:154587"
curl "$BASE/api/anime/anilist:154587/episodes"
curl "$BASE/api/episode/anilist:154587:e1"
curl "$BASE/api/episode/anilist:154587:e1/sources"
curl "$BASE/api/episode/anilist:154587:e1/subtitles"
```
