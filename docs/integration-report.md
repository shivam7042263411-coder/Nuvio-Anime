# AnimePahe Integration Report

**Date:** 12 November 2026
**Projects:** AnimePahe API + AnimePahe plugin
**Status:** Implementation complete; local automated verification passed; not deployed and not tested against live AnimePahe or a live NuvioTV device.

---

## 1. Objective

Integrate the existing AnimePahe provider into the central Anime API so NuvioTV can use one plugin and one API, while preserving both original projects.

Constraints followed:

- Preserve both folders and the original plugin.
- Do not create a second Nuvio plugin.
- Keep existing endpoints, response contracts, metadata/episode services, catalogue provider, subtitle system and Nuvio adapter working.
- Keep `DL` as a playable stream label, never a download action.
- Do not bypass Cloudflare, CAPTCHAs, authentication or rate limits.
- Do not expose secrets or internal errors.
- Do not deploy or modify production databases/configuration.

---

## 2. What was inspected

- `/Users/shubhuu2008/Documents/Nuvio+/Animepahe plugin`
- `/Users/shubhuu2008/Documents/Nuvio+/Animepahe API`

Findings:

- The API folder is **not** a Git repository. It was left unchanged.
- The plugin repository is Git and already had uncommitted changes:
  - `README.md` modified
  - `animepahe.js` modified
  - `manifest.json` modified
  - `tests/` untracked
- Baseline before changes: API tests 54/54 passing; plugin tests 8/8 passing.

---

## 3. Implementation

### 3.1 Optional provider

AnimePahe is registered as a second source provider and is disabled by default:

```env
SOURCE_ANIMEPAHE_ENABLED=false
```

When enabled, it reuses the central metadata and episode context instead of performing its own AniList/TMDB resolution.

New modules:

- `src/sources/animepahe/provider.ts` — orchestration, normalization, caching, warnings.
- `src/sources/animepahe/matching.ts` — title, season, movie and special matching.
- `src/sources/animepahe/scraper.ts` — search, releases, play page, kwik playback, DL resolution, subtitle probing.
- `src/sources/animepahe/parse.ts` — HTML/JS parsing, packed-player unpacking, subtitle candidates.

### 3.2 Source contract

The existing `Source` interface was extended additively:

- optional `providerName`
- optional `name`
- optional `size`

AnimePahe results are normalized to the same contract as catalogue sources:

- provider: `animepahe`
- provider name: `AnimePahe`
- labels: `Sub`, `Dub`, `DL`
- delivery: always `stream`
- stream type: `hls` or `mp4`
- headers: sanitized playback headers
- expiry: `null`
- temporary: `true`
- metadata: optional variant name and informational size

`DL` remains a playable stream. No download endpoint or file-transfer action exists.

### 3.3 Subtitles

- Added an optional `getSubtitles()` method to `SourceProvider`.
- The subtitle service merges provider-discovered external tracks with catalogue tracks.
- Provider tracks are validated as HTTP(S) with `srt` or `vtt` format.
- Tracks are deduplicated and marked selectable.
- Embedded subtitle facts remain separate and always `selectable: false`.
- AnimePahe embedded subtitles are not advertised because the upstream does not expose reliable embedded metadata.
- Hardcoded or embedded subtitles are never copied into selectable tracks.

### 3.4 Aggregation and failure isolation

- Providers run in parallel.
- Each provider is wrapped in `SOURCE_PROVIDER_TIMEOUT_MS`.
- A failing or hanging provider produces a warning; other providers still return results.
- If every configured provider fails, the existing `502 provider_error` behavior remains.
- Cross-provider duplicates are detected by label, quality, URL and headers, ignoring provider identity.
- Source ordering remains `Sub`, `Dub`, `DL`, then highest quality.

### 3.5 Caching

- AnimePahe resolutions are cached and shared between `/sources` and `/subtitles`.
- In-flight requests are deduplicated.
- Cached stream URLs remain memory-only, consistent with the existing temporary-source policy.

### 3.6 Nuvio adapter

The existing single plugin was preserved:

- `nuvio-plugin/nuvio-anime-api.js`
- `nuvio-plugin/manifest.json`

Only additive display mapping changed:

- optional API `source.name` appears in the Nuvio display name
- optional API `source.size` is mapped into the result

The adapter still:

- calls only the central API
- maps `hls → m3u8`, `dash → mpd`, `mp4 → mp4`
- sends external subtitle tracks only
- ignores `embedded`
- filters expired, non-`stream` and duplicate URLs
- returns `[]` on API failure
- avoids imports, Node-only APIs and modern syntax for QuickJS compatibility

---

## 4. Configuration

Added to `.env.example` and documentation:

```env
SOURCE_PROVIDER_TIMEOUT_MS=45000

SOURCE_ANIMEPAHE_ENABLED=false
ANIMEPAHE_BASE_URL=https://animepahe.pw
ANIMEPAHE_USER_AGENT=
ANIMEPAHE_DEADLINE_MS=45000
ANIMEPAHE_MAX_SEARCH_PAGES=2
ANIMEPAHE_MAX_DOWNLOAD_OPTIONS=4
```

Invalid integers, booleans and URLs fail configuration validation instead of silently disabling behavior.

---

## 5. Files changed

### Implementation

- `src/sources/animepahe/provider.ts`
- `src/sources/animepahe/matching.ts`
- `src/sources/animepahe/scraper.ts`
- `src/sources/animepahe/parse.ts`
- `src/sources/types.ts`
- `src/sources/normalize.ts`
- `src/sources/service.ts`
- `src/subtitles/service.ts`
- `src/subtitles/types.ts`
- `src/config.ts`
- `src/container.ts`
- `src/http/client.ts`
- `src/routes/status.ts`
- `nuvio-plugin/nuvio-anime-api.js`

### Tests

- `tests/animepahe-provider.test.ts`
- `tests/animepahe-matching.test.ts`
- `tests/sources-subtitles.test.ts`
- `tests/container.test.ts`
- `tests/api.test.ts`
- `tests/nuvio-plugin.test.ts`

### Documentation

- `.env.example`
- `README.md`
- `docs/api.md`
- `docs/sources.md`
- `docs/nuvio.md`
- `docs/deployment.md`
- `docs/final-report.md`
- `docs/integration-report.md` (this report)

---

## 6. Verification performed

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 90 passed across 11 files |
| `npm run build` | Passed |
| `node --check nuvio-plugin/nuvio-anime-api.js` | Passed |
| Existing plugin `node tests/run-tests.js` | 8/8 passed |
| Built-container import check | Passed; `catalog,animepahe`; AnimePahe registered once |

New automated coverage:

- provider registration and opt-in configuration
- configuration validation
- TV season 1 and season 2 matching
- named/final-season matching
- split-cour matching
- movie context and movie mismatch
- specials
- empty search results and missing episodes
- alternate-title search
- Sub/Dub/DL normalization
- external subtitle normalization and merging
- embedded subtitle separation
- empty play/release pages
- Cloudflare challenge handling
- provider failures and timeout isolation
- partial success
- cross-provider deduplication
- existing API, catalogue and Nuvio contract compatibility
- Nuvio adapter execution in a Node `vm` with stubbed `fetch`

All provider tests use synthetic fixtures. No live AnimePahe request was made.

---

## 7. Not verified

The following are environmental limitations, not claimed successes:

- No live AnimePahe request or playback.
- No live kwik or `pahe.win` resolution.
- No Antideploy deployment.
- No migration against a real PostgreSQL server.
- No execution inside a live NuvioTV build or device.
- No verification of regional availability, upstream rate limits or long-term upstream markup stability.
- Local Node was `v24.22.0`; `package.json` declares Node 22. Validate on the deployment runtime.

---

## 8. Deployment steps

1. Review authorization and upstream terms before enabling AnimePahe.
2. Set `SOURCE_ANIMEPAHE_ENABLED=true` only if permitted.
3. Tune `SOURCE_PROVIDER_TIMEOUT_MS` and `ANIMEPAHE_*` values if needed.
4. Run `npm run build`.
5. Run `npm start`.
6. Confirm migrations complete and `/health` returns `200`.
7. Check `/api/status` and confirm AnimePahe is `configured: true`.
8. Test one TV episode and one movie through the API.
9. Install the existing `nuvio-plugin/` in Nuvio and test one movie and one TV episode on a real device.
10. Review warnings for challenges, region blocks, missing releases or timeouts.

---

## 9. Preservation confirmation

- Both original folders remain present.
- The original AnimePahe plugin was not rewritten or replaced.
- No second Nuvio plugin was created.
- The plugin repository status remains as it was before this work:
  - `M README.md`
  - `M animepahe.js`
  - `M manifest.json`
  - `?? tests/`
- The API folder remains without a Git repository.
- No production database, deployment configuration or repository boundary was modified.
