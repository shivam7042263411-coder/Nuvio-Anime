# AnimePahe Nuvio Plugin

Anime streams from [animepahe.com](https://animepahe.com) (also works with `.pw` / `.org`) for **NuvioTV**.

## What it does

- Searches AnimePahe by TMDB title
- Resolves season + episode to the correct AnimePahe episode entry
- Parses the play page resolution buttons (`#resolutionMenu button`)
- Unpacks the kwik.cx obfuscated player to extract the `.m3u8` stream URL
- Returns `LocalScraperResult` objects that Nuvio's player can play directly
- Attaches `Referer: https://kwik.cx/` + `Origin` headers required by kwik

## How it works in Nuvio

Nuvio's `PluginRuntime` (QuickJS) loads this file as a JavaScript scraper. The runtime provides:

- `fetch` — HTTP client polyfill (OkHttp-backed)
- `require("cheerio")` — Cheerio/DOM parsing backed by Jsoup
- `URL`, `URLSearchParams`, `atob`, `btoa`, `AbortController`
- `TMDB_API_KEY` — injected from `BuildConfig`
- `module.exports` — export `getStreams(tmdbId, mediaType, season, episode)`

The plugin entry point matches Nuvio's contract exactly:

```js
getStreams(tmdbId, mediaType, season, episode) => Promise<LocalScraperResult[]>
```

## Adding the plugin to NuvioTV

Nuvio loads JS scrapers from a **repository manifest URL**. You have two options:

### Option A: Serve the manifest locally (recommended for testing)

1. Host `manifest.json` and `animepahe.js` on any static file server (GitHub Pages, Netlify, local web server, etc.)
2. Open NuvioTV → Plugins → Add Repository
3. Enter the URL to your hosted `manifest.json`
4. Enable the "AnimePahe" scraper
5. Search for an anime and play — AnimePahe streams will appear

### Option B: Add via the PluginManager (advanced)

If you want to bundle this directly, you would need to add a code path in `PluginManager` to load scraper code from `app/src/full/assets/`. Currently Nuvio only loads scrapers from remote manifests, so Option A is the standard path.

## Proxy

All AnimePahe requests are proxied through:

```
https://animepaheproxy.phisheranimepahe.workers.dev/?url=<encoded-target>
```

This bypasses Cloudflare protection on `animepahe.pw` / `.com` / `.org`. The proxy is configured in `PROXY_URL` at the top of `animepahe.js`. If it stops working, replace it with your own proxy endpoint.

## Requirements

- NuvioTV **full** flavor (QuickJS-KT + JS plugin support is `fullImplementation` only)
- `FEATURE_PLUGINS_ENABLED` must be `true` (set in the `full` product flavor by default)
- TMDB API key configured in `local.properties` (`TMDB_API_KEY`) — needed to resolve the title from TMDB ID
- Internet access (proxy + TMDB API + AnimePahe + kwik.cx)

## Notes

- AnimePahe streams are typically hardsubbed; no separate `.vtt` subtitle tracks are exposed by the scraper. Subtitle support can be added later if AnimePahe exposes subtitle URLs.
- Quality labels (360p/720p/1080p) and Sub/Dub are parsed from the resolution button text on the play page.
- Results are deduplicated by URL and capped at 150 by `PluginManager`.

## Files

| File | Purpose |
|------|---------|
| `animepahe.js` | Plugin source (QuickJS-compatible) |
| `manifest.json` | Nuvio plugin repository manifest |
| `README.md` | This file |
