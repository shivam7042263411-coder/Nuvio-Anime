import { readFile } from "node:fs/promises";
import { parseSubtitle } from "../src/subtitles/parse.js";

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  process.stderr.write("Usage: npm run subtitle:inspect -- ./episode1.srt\n");
  process.exit(1);
}

const content = await readFile(file, "utf8");
const parsed = parseSubtitle(content);
const summary = {
  file,
  format: parsed.format,
  cues: parsed.cues.length,
  durationMs: parsed.cues.at(-1)?.endMs ?? 0,
  warnings: parsed.warnings,
  firstCues: parsed.cues.slice(0, 3)
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
