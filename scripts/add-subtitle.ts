import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig, loadLocalEnv } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrateWithRetry } from "../src/db/migrate.js";
import { Logger } from "../src/logger.js";
import { parseSubtitle, type SubtitleFormat } from "../src/subtitles/parse.js";
import { has, headers, optional, optionalNumber, parseFlags, required } from "./cli.js";

const usage = `
Add an authorized subtitle track, or record that an episode has hardcoded subtitles.

External (selectable) track:
npm run subtitle:add -- --anime anilist:21 --episode 1 --kind external \\
  --language en --label "English" --format vtt --url "https://cdn.example/ep1.vtt"

Embedded (hardsub, never selectable):
npm run subtitle:add -- --anime anilist:21 --episode 1 --kind embedded \\
  --language en --label "English (hardsub)"

Optional: --season 1, --default, --header "Referer=https://example.com/", --id sub_my_id
Optional validation: --file ./episode1.vtt
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

const kind = required(flags, "kind").toLowerCase();
if (!["external", "embedded"].includes(kind)) {
  throw new Error("--kind must be external or embedded");
}

const language = required(flags, "language");
const label = required(flags, "label");
const season = optionalNumber(flags, "season");
const id = optional(flags, "id") ?? `sub_${randomUUID()}`;

let format: SubtitleFormat | null = null;
let url: string | null = null;

if (kind === "external") {
  const rawFormat = required(flags, "format").toLowerCase();
  if (!["srt", "vtt"].includes(rawFormat)) throw new Error("--format must be srt or vtt");
  format = rawFormat as SubtitleFormat;
  url = required(flags, "url");
  if (!/^https?:\/\//i.test(url)) throw new Error("--url must start with http:// or https://");
}

const localFile = optional(flags, "file");
if (localFile) {
  const content = await readFile(localFile, "utf8");
  const parsed = parseSubtitle(content, format ?? undefined);
  process.stdout.write(
    `Validated ${localFile}: ${parsed.format}, ${parsed.cues.length} cue(s), ${parsed.warnings.length} warning(s).\n`
  );
  for (const warning of parsed.warnings.slice(0, 5)) process.stdout.write(`  warning: ${warning}\n`);
}

loadLocalEnv();
const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");

const logger = new Logger(config.logLevel);
const pool = createPool(config.databaseUrl, logger);
try {
  await migrateWithRetry(pool, logger);
  await pool.query(
    `insert into authorized_subtitles
       (id, provider_id, anime_id, season_number, episode_number, kind, language, label, format, url, headers, is_default)
     values ($1, 'catalog', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     on conflict (id) do update
       set anime_id = excluded.anime_id,
           season_number = excluded.season_number,
           episode_number = excluded.episode_number,
           kind = excluded.kind,
           language = excluded.language,
           label = excluded.label,
           format = excluded.format,
           url = excluded.url,
           headers = excluded.headers,
           is_default = excluded.is_default,
           enabled = true,
           updated_at = now()`,
    [
      id,
      animeId,
      season ?? null,
      episode,
      kind,
      language,
      label,
      format,
      url,
      JSON.stringify(headers(flags)),
      has(flags, "default")
    ]
  );
  process.stdout.write(`Saved subtitle ${id} for ${animeId} episode ${episode} (${kind}).\n`);
} finally {
  await pool.end();
}
