# Authorized sources and subtitles

This API has two source paths:

1. The **authorized catalogue** (default): URLs an operator explicitly added to
   `authorized_sources` or `authorized_subtitles`.
2. The **optional AnimePahe provider** (disabled by default): resolves the public
   AnimePahe play page into normal `Sub`, `Dub` and `DL` stream URLs.

Neither path solves CAPTCHAs, bypasses Cloudflare, impersonates a login, defeats
DRM or downloads files. The AnimePahe provider stops and reports a warning when
the upstream site presents a challenge; it does not try to evade it.

**Authorization is a legal question, not a technical one.** Being able to load a
page or copy a URL does not mean you may redistribute it. Add only content you
own, license, or are otherwise permitted to provide. Enabling the AnimePahe
provider is an operator decision that you must make only where it is lawful and
permitted by the upstream service.

## How a request finds a source

For an episode request, the API:

1. Resolves the anime and builds the episode catalogue.
2. Finds the requested episode, including its canonical `animeId`,
   `seasonNumber` and `episodeNumber`.
3. Calls each configured `SourceProvider`.
4. The built-in catalogue provider runs one SQL query matching:

   ```text
   provider_id = 'catalog'
   and anime_id = <canonical anime id>
   and season_number is not distinct from <episode season>
   and episode_number = <episode number>
   and enabled = true
   and (expires_at is null or expires_at > now() + 15 seconds)
   ```

5. Deduplicates and sorts: `Sub`, then `Dub`, then `DL`, highest quality first.

The `season_number` match is exact, including `NULL`. This is the most common
cause of an empty source list.

## Finding the correct values

Start from the episode endpoint, not from the TMDB URL:

```bash
curl "https://<your-app>/api/anime/tmdb:1429/episodes?season=2&limit=50"
```

Look at the returned episode:

```json
{
  "id": "anilist:16498:s2:e1",
  "animeId": "anilist:16498",
  "seasonNumber": 2,
  "episodeNumber": 1,
  "source": "tmdb"
}
```

Use `animeId`, `seasonNumber` and `episodeNumber` to add the source:

```bash
npm run source:add -- \
  --anime anilist:16498 \
  --season 2 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --language ja \
  --type hls \
  --url "https://licensed-cdn.example/episode.m3u8"
```

### Season rules

| Catalogue | Episode `seasonNumber` | CLI |
| --- | --- | --- |
| TMDB TV match (`"source": "tmdb"`) | a number, including `0` for specials | pass `--season N` |
| AniList-only fallback (`"source": "anilist"`) | `null` | **omit** `--season` |
| Movie | `null` | **omit** `--season` |

An AniList-only catalogue has no season numbers even if the show is commonly
called "season 2". Adding `--season 2` will not match it.

### Anime ID rules

Use the **canonical** `animeId` returned by this API. A TMDB request may resolve
to an AniList ID:

```bash
curl "https://<your-app>/api/anime/tmdb:1429"
# data.id                    -> "anilist:16498"
# data.requestedId           -> "tmdb:1429"
# data.tmdbMatch.id          -> 1429
```

If the returned `data.id` is `anilist:16498`, rows must be added under
`anilist:16498`. A row under `tmdb:1429` will not be found for that episode.

TMDB-only titles (no AniList match) keep `data.id = "tmdb:<n>"`, and rows use
that ID.

## Source labels

| CLI `--label` | Response label | Meaning |
| --- | --- | --- |
| `sub` | `Sub` | Original audio with subtitles. |
| `dub` | `Dub` | Dubbed audio. |
| `dl` | `DL` | The operator's "download" or direct-file release, still served as a **stream**. |

**`DL` is a streaming label.** Every source has `"delivery": "stream"`. The API
never builds a download button, ZIP, torrent or file-transfer endpoint. A client
may play the URL directly if the container supports it.

`language` is separate from the label. It describes the audio language, for
example `ja` or `en`. Clients should use `label` for Sub/Dub selection.

## CLI reference

```bash
npm run source:add -- \
  --anime <anilist:id|tmdb:id> \
  --episode <number> \
  [--season <number>] \
  --label <sub|dub|dl> \
  [--quality <text>] \
  [--language <code-or-name>] \
  [--type <hls|dash|mp4>] \
  --url <http(s) URL> \
  [--expires <ISO-8601 timestamp>] \
  [--header "Name=value"] \
  [--id <stable-id>]
```

| Flag | Notes |
| --- | --- |
| `--anime` | Required. `anilist:<n>` or `tmdb:<n>`. |
| `--episode` | Required. A non-negative number. Episode IDs use integers. |
| `--season` | Optional. Omit for AniList-only catalogues and movies. `0` is TMDB specials. |
| `--label` | Required. `sub`, `dub` or `dl`. |
| `--quality` | Optional text such as `1080p`, `720p`, `4K`. Used for sorting and display. |
| `--language` | Optional audio language, for example `ja`, `en`, `Japanese`. |
| `--type` | `hls` (default), `dash` or `mp4`. |
| `--url` | Required. Must start with `http://` or `https://`. |
| `--expires` | Optional ISO timestamp. The row is ignored 15 seconds before this time. |
| `--header` | Repeatable. Playback header, for example `--header "Referer=https://example.com/"`. |
| `--id` | Optional stable primary key. Reusing an ID updates that row. |

The command runs pending migrations first, then upserts the row.

### Examples

HLS, Japanese audio with subtitles:

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --language ja \
  --type hls \
  --url "https://licensed-cdn.example/frieren/ep1/master.m3u8"
```

English dub:

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label dub \
  --quality 1080p \
  --language en \
  --type hls \
  --url "https://licensed-cdn.example/frieren/ep1/dub.m3u8"
```

Direct MP4 labeled DL:

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label dl \
  --quality 1080p \
  --language ja \
  --type mp4 \
  --url "https://licensed-cdn.example/frieren/ep1.mp4"
```

Expiring signed URL with a header:

```bash
npm run source:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --label sub \
  --quality 720p \
  --url "https://signed.example/ep1.m3u8?token=..." \
  --expires "2026-12-01T00:00:00Z" \
  --header "Referer=https://player.example/"
```

## URL and header handling

- URLs must be absolute `http` or `https`. Non-HTTP rows are ignored with a
  warning.
- `headers` is a JSON object of strings. At read time, keys up to 100 characters
  and values up to 2000 characters are kept; other entries are dropped.
- Headers are returned to clients because players need them. **Never store a
  credential there that you do not want a client to see.** This includes
  cookies, tokens and private authorization values.
- The API does not log source URLs in requests, and it removes URL query strings
  before logging. The rows themselves are stored in PostgreSQL because the
  catalogue must survive restarts.
- Cached source responses are memory-only and never written to the PostgreSQL
  cache, because signed URLs are short-lived.

## Duplicate rows and updates

The table has a unique identity on:

```text
provider_id, anime_id, season_number, episode_number, label, quality
```

Adding the same identity with a different `--id` fails. Reuse the existing
`--id` to update it:

```bash
npm run source:add -- \
  --id src_frieren_ep1_sub_1080 \
  --anime anilist:154587 \
  --episode 1 \
  --label sub \
  --quality 1080p \
  --url "https://licensed-cdn.example/new-master.m3u8"
```

`id` is the primary key. Reusing it changes the row and sets `enabled = true`.

## Temporarily disabling a source

There is intentionally no admin HTTP endpoint. Use SQL through your normal
database access:

```sql
update authorized_sources
set enabled = false, updated_at = now()
where id = 'src_frieren_ep1_sub_1080';

update authorized_sources
set enabled = true, updated_at = now()
where id = 'src_frieren_ep1_sub_1080';
```

Delete an expired row:

```sql
delete from authorized_sources where id = 'src_frieren_ep1_sub_1080';
```

The API is read-only against these tables. It never changes source rows on its
own.

## Subtitles

Subtitles are stored separately from sources. There are two kinds:

| Kind | Response location | Selectable | Meaning |
| --- | --- | --- | --- |
| `external` | `data.tracks` | Yes | A real SRT/VTT file the player can load. |
| `embedded` | `data.embedded` | No | Hardcoded or in-stream subtitles. Informational only. |

Hardcoded subtitles are burned into the video. The API never copies them into
`tracks`, because a player cannot select, replace or disable them.

### Add an external track

```bash
npm run subtitle:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --kind external \
  --language en \
  --label "English" \
  --format vtt \
  --url "https://licensed-cdn.example/frieren/ep1.en.vtt" \
  [--season 1] \
  [--default] \
  [--header "Referer=https://player.example/"] \
  [--file ./ep1.en.vtt]
```

- `--format` must be `srt` or `vtt`.
- `--url` must be absolute HTTP(S).
- `--file` is optional. It parses a local file and prints cue/warning counts
  before saving. It does not upload the file.
- `--default` marks the track as preferred.

### Record embedded subtitles

```bash
npm run subtitle:add -- \
  --anime anilist:154587 \
  --episode 1 \
  --kind embedded \
  --language en \
  --label "English (hardsub)"
```

Embedded rows do not need a URL or format. The database enforces that they
cannot have one.

Inspect a local file without saving anything:

```bash
npm run subtitle:inspect -- ./ep1.en.vtt
```

### Subtitle delivery

- Subtitle URLs are returned to the player. The player must be able to fetch
  them, including any CORS requirements of the file host.
- Subtitle responses are memory-only cached (default 120 seconds) and set
  `Cache-Control: no-store`.
- If an external row is missing its URL or format, it is skipped with a warning
  instead of being advertised as broken.

## Optional AnimePahe provider

The provider is **off by default**. It is an adapter around AnimePahe's public
search, release, play and kwik links. It does not use a second API, a proxy or a
separate plugin.

```env
SOURCE_ANIMEPAHE_ENABLED=true
SOURCE_PROVIDER_TIMEOUT_MS=45000
ANIMEPAHE_BASE_URL=https://animepahe.pw
ANIMEPAHE_DEADLINE_MS=45000
ANIMEPAHE_MAX_SEARCH_PAGES=2
ANIMEPAHE_MAX_DOWNLOAD_OPTIONS=4
```

What it does:

1. Uses the already-resolved central `AnimeMetadata` and its TMDB season
   information. It does not perform its own AniList/TMDB lookup.
2. Searches AnimePahe, matches the title, season, episode or movie, and reads
   the release's play page.
3. Resolves Sub/Dub buttons and up to `ANIMEPAHE_MAX_DOWNLOAD_OPTIONS` DL links
   through their kwik pages.
4. Normalizes every result to the same `Source` contract. `DL` is still
   `delivery: "stream"`; `name` and informational `size` are optional additions.
5. Discovers external HLS/subtitle tracks where the upstream exposes them. It
   never invents a subtitle URL. AnimePahe does not reliably expose embedded
   subtitle metadata, so `embedded` stays empty.
6. Stops on a Cloudflare challenge, login wall or rate limit and returns a
   warning. It does not bypass, retry aggressively or solve anything.

Operational notes:

- Upstream markup, domains and region availability change. An empty source list
  with a warning is expected when a title is not uploaded or is blocked.
- Resolved URLs are temporary (`temporary: true`) and cached in memory briefly.
- The provider is isolated by `SOURCE_PROVIDER_TIMEOUT_MS`. A hang or failure
  adds a warning; other configured providers still return their sources.
- Set `SOURCE_ANIMEPAHE_ENABLED=false` to remove it from `/sources` and
  `/subtitles` immediately. `/api/status` shows both `configured` and available
  providers.

The provider's automated tests use synthetic fixtures, not the live site. They
cover title/season/movie/special matching, Sub/Dub/DL normalization, subtitle
separation, empty pages, challenges, partial failures and deduplication.

## Adding a source provider

Providers are independent. The API runs every configured provider in parallel
under one timeout, keeps the others when one fails, normalizes and deduplicates
the combined result, and returns one stable response shape. Adding a provider
requires no change to the Nuvio adapter, the routes, or the database schema.

The catalogue is one implementation of a small interface:

```ts
// src/sources/types.ts
export interface SourceProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  getSources(context: SourceContext): Promise<ProviderResult>;
  /** Optional: providers that can discover subtitles alongside their sources. */
  getSubtitles?(context: SourceContext): Promise<ProviderSubtitleResult>;
}
```

`context` contains the resolved `AnimeMetadata` and `Episode`, so a provider
never performs its own AniList/TMDB lookup. A provider returns `Source` objects:

```ts
{
  id: string;
  provider: string;
  providerName?: string;
  label: "Sub" | "Dub" | "DL";
  language: string | null;
  quality: string | null;
  type: "hls" | "dash" | "mp4";
  delivery: "stream";
  url: string;
  headers: Record<string, string>;
  expiresAt: string | null;
  temporary: boolean;
  name?: string;
  size?: string | null;
}
```

### Minimal provider skeleton

```ts
// src/sources/example/provider.ts
import type { Config } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { ProviderResult, SourceContext, SourceProvider } from "../types.js";

export class ExampleProvider implements SourceProvider {
  readonly id = "example";
  readonly name = "Example";

  constructor(private readonly options: { config: Config; logger: Logger }) {}

  isConfigured(): boolean {
    return this.options.config.sources.example.enabled;
  }

  async getSources(_context: SourceContext): Promise<ProviderResult> {
    return {
      sources: [
        {
          id: "example:episode-1",
          provider: this.id,
          providerName: this.name,
          label: "Sub",
          language: "ja",
          quality: "1080p",
          type: "hls",
          delivery: "stream",
          url: "https://licensed-cdn.example/episode-1.m3u8",
          headers: {},
          expiresAt: null,
          temporary: true
        }
      ],
      warnings: []
    };
  }
}
```

Add a disabled-by-default flag in `src/config.ts`:

```ts
sources: {
  example: { enabled: readBool(env, "SOURCE_EXAMPLE_ENABLED", false) }
}
```

Register the provider once in `src/container.ts`:

```ts
const sourceProviders: SourceProvider[] = [
  new CatalogSourceProvider(pool, config.sources.catalogEnabled, logger),
  new AnimePaheProvider({ http, metadata, config, logger })
  // new ExampleProvider({ config, logger })
];
```

### What the service guarantees

- **Parallel execution.** All configured providers are queried at once.
- **Isolation.** A throwing, hanging or timed-out provider becomes a warning;
  other providers still return sources. If every configured provider fails, the
  endpoint returns `502 provider_error`.
- **Timeout.** `SOURCE_PROVIDER_TIMEOUT_MS` (default 45s) caps each provider.
- **Normalization.** Labels and stream types are canonicalized, headers are
  sanitized, expiry is converted to ISO-8601, and an unknown `temporary` value
  defaults to `true` so signed URLs are never persisted.
- **Validation.** Sources without an `http(s)` URL, without
  `delivery: "stream"`, or with an unknown label/type are dropped. The response
  warns that the provider returned unusable sources.
- **Deduplication.** The same URL, label, quality and playback headers are
  returned once even when two providers surface it.
- **Status.** `/api/status` lists each registered provider with `configured`
  and whether it can contribute subtitles.
- **Adapter compatibility.** The Nuvio adapter reads only
  `/api/episode/<id>/sources`; provider changes never require a plugin update.

### Tests

Use synthetic fixtures only. [`tests/multi-provider.test.ts`](../tests/multi-provider.test.ts)
shows the expected shape: two independent mock providers, deduplication,
disabled providers, malformed output, failure isolation and status reporting.

The catalogue provider stores only what an operator deliberately added. The
optional AnimePahe provider resolves public links at request time and must not
bypass Cloudflare, CAPTCHA or other access controls, use stolen cookies, or
resolve DRM-protected media. Those behaviours are out of scope for this project.

## Verifying

```bash
BASE=https://<your-app>

# Confirm the canonical ID and episode numbering.
curl "$BASE/api/anime/anilist:154587/episodes?limit=3"

# Sources
curl "$BASE/api/episode/anilist:154587:e1/sources"

# Subtitles
curl "$BASE/api/episode/anilist:154587:e1/subtitles"
```

Checklist for an empty source list:

1. Is `SOURCE_CATALOG_ENABLED=true` (or `SOURCE_ANIMEPAHE_ENABLED=true`)?
2. Is the canonical `animeId` exactly the returned `data.id`?
3. Does `season_number` match exactly, including `NULL`?
4. Is `episode_number` the same integer?
5. Is `enabled = true`?
6. Has `expires_at` passed, or is it within 15 seconds?
7. Did the label spelling use `sub`, `dub` or `dl`?
8. If using AnimePahe, does `/api/status` show it as `configured: true`? Read
   the response `warnings`: no release, region blocking, a Cloudflare challenge
   or an upstream timeout are reported there instead of being bypassed.
