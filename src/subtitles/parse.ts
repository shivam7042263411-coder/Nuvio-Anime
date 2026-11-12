export type SubtitleFormat = "srt" | "vtt";

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParsedSubtitle {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  warnings: string[];
}

const SRT_TIMING =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?$/;
const VTT_TIMING =
  /^\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})(?:\s+.*)?$/;

export function detectSubtitleFormat(content: string): SubtitleFormat {
  const head = content.replace(/^\uFEFF/, "").trimStart().slice(0, 200).toUpperCase();
  if (head.startsWith("WEBVTT")) return "vtt";
  return "srt";
}

export function parseSubtitle(content: string, format?: SubtitleFormat): ParsedSubtitle {
  const clean = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const resolved = format ?? detectSubtitleFormat(clean);
  return resolved === "vtt" ? parseVtt(clean) : parseSrt(clean);
}

function parseSrt(content: string): ParsedSubtitle {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];
  const blocks = content.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    let cursor = 0;
    if (/^\d+$/.test(lines[0]!.trim())) cursor = 1;
    const timing = lines[cursor];
    const match = timing ? SRT_TIMING.exec(timing) : null;
    if (!match) {
      warnings.push(`Skipped a block without a valid SRT timing line: ${lines[0]?.slice(0, 60) ?? ""}`);
      continue;
    }

    const startMs = parseSrtTimestamp(match[1]!);
    const endMs = parseSrtTimestamp(match[2]!);
    if (startMs === null || endMs === null || endMs < startMs) {
      warnings.push("Skipped a block with an invalid SRT time range");
      continue;
    }

    const text = lines
      .slice(cursor + 1)
      .join("\n")
      .trim();
    if (!text) continue;

    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }

  return { format: "srt", cues, warnings };
}

function parseVtt(content: string): ParsedSubtitle {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];
  const blocks = content.split(/\n{2,}/);

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    const first = lines[0]!.trim();
    if (/^WEBVTT/.test(first) || /^NOTE\b/.test(first) || /^STYLE\b/.test(first) || /^REGION\b/.test(first)) {
      continue;
    }

    let cursor = 0;
    if (!VTT_TIMING.test(lines[0]!)) {
      if (lines.length < 2) continue;
      cursor = 1;
    }

    const timing = lines[cursor];
    const match = timing ? VTT_TIMING.exec(timing) : null;
    if (!match) {
      warnings.push(`Skipped a block without a valid WebVTT timing line: ${first.slice(0, 60)}`);
      continue;
    }

    const startMs = vttTimestamp(match[1], match[2], match[3], match[4]);
    const endMs = vttTimestamp(match[5], match[6], match[7], match[8]);
    if (startMs === null || endMs === null || endMs < startMs) {
      warnings.push("Skipped a block with an invalid WebVTT time range");
      continue;
    }

    const text = lines
      .slice(cursor + 1)
      .join("\n")
      .trim();
    if (!text) continue;

    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }

  return { format: "vtt", cues, warnings };
}

function parseSrtTimestamp(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  return toMs(match[1], match[2], match[3], match[4]);
}

function vttTimestamp(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  millis: string | undefined
): number | null {
  return toMs(hours ?? "0", minutes, seconds, millis);
}

function toMs(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  millis: string | undefined
): number | null {
  const h = Number(hours ?? 0);
  const m = Number(minutes);
  const s = Number(seconds);
  const ms = Number((millis ?? "0").padEnd(3, "0").slice(0, 3));
  if (![h, m, s, ms].every(Number.isFinite)) return null;
  if (m > 59 || s > 59) return null;
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

export function formatTimestamp(ms: number, separator: "," | "." = ","): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

export function toVtt(parsed: ParsedSubtitle): string {
  const lines = ["WEBVTT", ""];
  for (const cue of parsed.cues) {
    lines.push(
      `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}`,
      cue.text,
      ""
    );
  }
  return lines.join("\n");
}
