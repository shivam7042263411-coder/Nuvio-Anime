import { randomUUID } from "node:crypto";
import { loadConfig, loadLocalEnv } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrateWithRetry } from "../src/db/migrate.js";
import { Logger } from "../src/logger.js";
import { headers, optional, optionalNumber, parseFlags, required } from "./cli.js";

const usage = `
Add a source you are authorized to distribute.

npm run source:add -- \\
  --anime anilist:21 \\
  --episode 1 \\
  [--season 1] \\
  --label sub|dub|dl \\
  [--quality 1080p] \\
  [--language ja] \\
  [--type hls|dash|mp4] \\
  --url "https://licensed-cdn.example/episode.m3u8" \\
  [--expires 2027-01-01T00:00:00Z] \\
  [--header "Referer=https://example.com/"] \\
  [--id src_my_id]
`;

const flags = parseFlags(process.argv.slice(2));
if (flags.has("help")) {
  process.stdout.write(usage);
  process.exit(0);
}

const animeId = required(flags, "anime");
if (!/^(anilist|tmdb):\d+$/.test(animeId)) {
  throw new Error("--anime must look like anilist:21 or tmdb:123");
}

const episode = optionalNumber(flags, "episode");
if (episode === undefined || !Number.isInteger(episode) || episode < 0) {
  throw new Error("--episode must be a non-negative integer");
}

const label = required(flags, "label").toLowerCase();
if (!["sub", "dub", "dl"].includes(label)) throw new Error("--label must be sub, dub or dl");

const streamType = (optional(flags, "type") ?? "hls").toLowerCase();
if (!["hls", "dash", "mp4"].includes(streamType)) {
  throw new Error("--type must be hls, dash or mp4");
}

const url = required(flags, "url");
if (!/^https?:\/\//i.test(url)) throw new Error("--url must start with http:// or https://");

const season = optionalNumber(flags, "season");
if (season !== undefined && (!Number.isInteger(season) || season < 0)) {
  throw new Error("--season must be a non-negative integer");
}

const expires = optional(flags, "expires");
if (expires && Number.isNaN(Date.parse(expires))) {
  throw new Error("--expires must be an ISO date, for example 2027-01-01T00:00:00Z");
}

const id = optional(flags, "id") ?? `src_${randomUUID()}`;

loadLocalEnv();
const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");

const logger = new Logger(config.logLevel);
const pool = createPool(config.databaseUrl, logger);
try {
  await migrateWithRetry(pool, logger);
  await pool.query(
    `insert into authorized_sources
       (id, provider_id, anime_id, season_number, episode_number, label, language, quality, stream_type, url, headers, expires_at)
     values ($1, 'catalog', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     on conflict (id) do update
       set anime_id = excluded.anime_id,
           season_number = excluded.season_number,
           episode_number = excluded.episode_number,
           label = excluded.label,
           language = excluded.language,
           quality = excluded.quality,
           stream_type = excluded.stream_type,
           url = excluded.url,
           headers = excluded.headers,
           expires_at = excluded.expires_at,
           enabled = true,
           updated_at = now()`,
    [
      id,
      animeId,
      season ?? null,
      episode,
      label,
      optional(flags, "language") ?? null,
      optional(flags, "quality") ?? null,
      streamType,
      url,
      JSON.stringify(headers(flags)),
      expires ?? null
    ]
  );
  process.stdout.write(`Saved source ${id} for ${animeId} episode ${episode} (${label}).\n`);
} finally {
  await pool.end();
}
