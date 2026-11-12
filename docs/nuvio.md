# Nuvio plugin

The adapter in [`nuvio-plugin/`](../nuvio-plugin/) connects NuvioTV to this API.
It is a thin client: all metadata, episode resolution, authorization and
subtitle rules stay in the API.

Files:

```text
nuvio-plugin/
├── manifest.json
└── nuvio-anime-api.js
```

## How Nuvio calls it

Nuvio's `PluginRuntime` loads the JavaScript file and calls:

```js
getStreams(tmdbId, mediaType, season, episode)
  => Promise<LocalScraperResult[]>
```

The adapter does three parallel requests:

```text
GET /api/anime/tmdb:<tmdbId>
GET /api/episode/tmdb:<tmdbId>:s<season>:e<episode>/sources
GET /api/episode/tmdb:<tmdbId>:s<season>:e<episode>/subtitles
```

For a movie it requests:

```text
GET /api/anime/tmdb:<tmdbId>
GET /api/episode/tmdb:<tmdbId>:e1/sources
GET /api/episode/tmdb:<tmdbId>:e1/subtitles
```

The API may resolve the TMDB ID to an AniList canonical ID internally. That is
fine: the episode endpoints accept the TMDB ID form and return sources for the
resolved episode. The adapter does not need to know the canonical ID.

## Requirements

1. The API is deployed and reachable over HTTPS.
2. `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` is configured on the API. Nuvio sends
   TMDB IDs, so the API needs TMDB to resolve them.
3. Authorized sources and subtitles exist for the requested episode. The plugin
   returns an empty list when none are configured.
4. The API is not blocking the device. If you put the API behind a private
   access layer, the plugin will not be able to authenticate.

## Configure the API URL

Edit the top of `nuvio-plugin/nuvio-anime-api.js`:

```js
var DEFAULT_API_BASE = "https://your-anime-api.antideploy.app";
```

Replace it with your real deployment URL, with no trailing slash:

```js
var DEFAULT_API_BASE = "https://anime-api.example.com";
```

Alternatively, the host can provide `globalThis.ANIME_API_URL` (or
`process.env.ANIME_API_URL` where available). The explicit global wins.

If the placeholder is left in place, the adapter logs a clear error and returns
no streams. It does not call `example.com`.

## Install in Nuvio

The manifest describes one scraper:

```json
{
  "id": "anime-api",
  "name": "Anime API",
  "filename": "nuvio-anime-api.js",
  "supportedTypes": ["movie", "tv"],
  "formats": ["m3u8", "mpd", "mp4"]
}
```

Install it the same way as any local Nuvio JS plugin:

1. Put `manifest.json` and `nuvio-anime-api.js` in a plugin repository
   directory (the repository can be a Git repository or a directly loaded local
   plugin, depending on your Nuvio build).
2. Add that repository/plugin in Nuvio and enable **Anime API**.
3. Play a movie or TV episode from a TMDB-backed catalogue.
4. Check Nuvio's plugin logs for `[Anime API]` lines.

Nuvio's runtime provides `fetch`, `console`, `AbortController` and
`module.exports`. The adapter uses only those globals plus standard JavaScript.
It avoids timers and optional chaining for QuickJS compatibility.

> The adapter has been syntax-checked, but it has **not** been executed inside a
> live NuvioTV build in this session. Test one movie and one TV episode on your
> target device before relying on it.

## Result mapping

The API may return catalogue sources, optional AnimePahe provider sources, or a
merged list from both. The adapter treats them identically and never contacts
AnimePahe, kwik or pahe.win directly. Each API source becomes one
`LocalScraperResult`:

| Nuvio field | API value |
| --- | --- |
| `title` | Anime preferred title, plus ` - SxxExx` for TV. Falls back to `Episode N` / `Movie` if metadata is unavailable. |
| `name` | `Anime API · <label> · <variant> · <quality> · <language> · <provider>` (optional pieces omitted) |
| `url` | `source.url` |
| `quality` | `source.quality` |
| `size` | `source.size` when a provider reports an informational file size, otherwise `null` |
| `language` | `Sub`, `Dub` or `DL` from `source.label` |
| `provider` | `Anime API` |
| `type` | `hls → m3u8`, `dash → mpd`, `mp4 → mp4` |
| `headers` | `source.headers`, or `null` when empty |
| `subtitles` | External selectable tracks for the episode |
| `seeders`, `peers`, `infoHash` | `null` (not a torrent source) |

Example:

```json
[
  {
    "title": "Frieren: Beyond Journey's End - S01E01",
    "name": "Anime API · Sub · 1080p · ja",
    "url": "https://licensed-cdn.example/frieren/ep1/master.m3u8",
    "quality": "1080p",
    "size": null,
    "language": "Sub",
    "provider": "Anime API",
    "type": "m3u8",
    "seeders": null,
    "peers": null,
    "infoHash": null,
    "headers": { "Referer": "https://player.example/" },
    "subtitles": [
      {
        "id": "sub_01J...",
        "url": "https://licensed-cdn.example/frieren/ep1.en.vtt",
        "lang": "en",
        "language": "en",
        "name": "English",
        "addonName": "Anime API",
        "addonLogo": null,
        "isStreamProvided": false,
        "headers": null
      }
    ]
  }
]
```

### Sub, Dub and DL

- `language` carries the API's `Sub`/`Dub`/`DL` label so Nuvio can group and sort
  variants.
- **`DL` is a stream label.** The adapter returns a normal playable URL with
  `type` `mp4` or `m3u8`. It never creates a download action.
- Actual audio language (for example `ja` or `en`) is included in `name`.

### Subtitles

- Only `data.tracks` from `/subtitles` are mapped. These are external SRT/VTT
  files.
- `data.embedded` is deliberately ignored. Hardcoded or in-stream subtitles are
  not selectable tracks and must not be advertised as such.
- Every stream for the episode receives the same external subtitle list, since
  the API stores tracks per episode rather than per source.
- `isStreamProvided` is `false`: the track is provided by the API, not embedded
  by the stream provider.
- If the subtitle request fails, streams are still returned with an empty
  subtitle list.

## Failure behaviour

The adapter is deliberately quiet and empty rather than wrong:

| Situation | Result |
| --- | --- |
| API unreachable or times out | Logs the error, returns `[]`. |
| TMDB ID cannot be resolved | API returns `404 anime_not_found`; adapter returns `[]`. |
| Episode does not exist | API returns `404 episode_not_found`; adapter returns `[]`. |
| No authorized source | API returns `200` with an empty list; adapter returns `[]`. |
| All source providers fail | API returns `502`; adapter returns `[]`. |
| Subtitle endpoint fails | Streams still return, with no subtitles. |
| Source `delivery` is not `stream` | Adapter skips it. |
| Source URL already expired | Adapter skips it. |

The plugin never invents an episode or a stream URL. It never falls back to
scraping another site.

## Rate limits and caching

The API applies its own rate limit. Nuvio may call several plugins for one
episode, so keep `RATE_LIMIT_MAX` reasonable for your household or user count.
The adapter makes three requests per `getStreams` call. The API caches episode
catalogues and reuses them across the three calls.

Source responses are cached in memory for 60 seconds by default. Subtitle
responses are cached for 120 seconds. Both set `Cache-Control: no-store`, but
the adapter does not add its own cache.

## Testing

Syntax check:

```bash
node --check nuvio-plugin/nuvio-anime-api.js
```

The API test suite also executes the adapter in a Node `vm` context with stubbed
`fetch`/`console`/`module.exports`. It verifies source mapping, subtitle mapping,
expired/non-stream/duplicate filtering, API failures, unconfigured URL handling
and the absence of imports or Node-only APIs:

```bash
npm test -- tests/nuvio-plugin.test.ts
```

Test the API side exactly as the adapter calls it:

```bash
BASE=https://<your-app>

curl "$BASE/api/anime/tmdb:1429"
curl "$BASE/api/episode/tmdb:1429:s1:e1/sources"
curl "$BASE/api/episode/tmdb:1429:s1:e1/subtitles"
```

If those return the expected title, sources and tracks, the adapter has the data
it needs. Then test in Nuvio on a real device:

1. One movie.
2. One TV episode with a normal season.
3. One episode with no authorized source (should return no streams, not an
   invented one).
4. One episode with an external subtitle track.

## What this plugin does not do

- It does not contact AnimePahe, kwik, pahe.win or any streaming site.
- It does not solve CAPTCHAs, bypass Cloudflare, impersonate a login, or handle
  DRM.
- It does not download files.
- It does not create sources. Operators add authorized URLs with
  `npm run source:add`.
- It does not advertise embedded subtitles as selectable tracks.

See [sources.md](sources.md) for the authorization rules and CLI.
