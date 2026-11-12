import type { SubtitleFormat } from "../../subtitles/parse.js";

export interface PlayButton {
  url: string;
  quality: string;
  audio: string;
  fansub: string;
  av1: boolean;
}

export interface DownloadLink {
  url: string;
  label: string;
  quality: string;
  size: string;
  audio: string;
  source: string;
}

export interface SubtitleCandidate {
  url: string;
  language: string;
  label: string;
  format: SubtitleFormat;
}

export function attr(tag: string, name: string): string | null {
  let match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  if (match?.[1] !== undefined) return match[1];
  match = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return match?.[1] ?? null;
}

export function decodeEntities(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  text = text.replace(/&#(\d+);/g, (_match, number: string) =>
    String.fromCharCode(parseInt(number, 10))
  );
  const map: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    middot: "\u00b7",
    ndash: "\u2013",
    mdash: "\u2014",
    hellip: "\u2026",
    rsquo: "\u2019",
    lsquo: "\u2018",
    ldquo: "\u201c",
    rdquo: "\u201d"
  };
  return text.replace(/&([a-z]+);/gi, (match, name: string) => map[name.toLowerCase()] ?? match);
}

export function stripTags(html: unknown): string {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function isCloudflareBlock(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("Just a moment") ||
    text.includes("Sorry, you have been blocked") ||
    text.includes("Attention Required! | Cloudflare") ||
    text.includes("cf-error-details") ||
    text.includes("Enable JavaScript and cookies to continue")
  );
}

export function originOf(url: string): string {
  const match = String(url ?? "").match(/^(https?:\/\/[^/]+)/i);
  return match?.[1] ?? "";
}

export function resolveUrl(base: string, reference: string | null | undefined): string {
  const value = decodeEntities(reference ?? "").trim();
  if (!value) return String(base ?? "");
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (/^(data:|blob:|mailto:|javascript:)/i.test(value)) return value;

  const baseClean = String(base ?? "").replace(/[?#].*$/, "");
  const origin = originOf(baseClean);
  if (!origin) return value;
  if (value.startsWith("/")) return origin + value;

  const slash = baseClean.lastIndexOf("/");
  const directory = slash <= origin.length ? `${origin}/` : baseClean.substring(0, slash + 1);
  const parts = `${directory}${value}`.split("/");
  const out: string[] = [];

  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }

  return `${out[0] ?? ""}//${out.slice(1).join("/")}`;
}

export function parseQuality(text: unknown): string {
  const match = String(text ?? "").match(/(\d{3,4})\s*p\b/i);
  return match?.[1] ? `${match[1]}p` : "";
}

export function parseSize(text: unknown): string {
  const match = String(text ?? "").match(/\(([^)]*(?:MB|GB|MiB|GiB)[^)]*)\)/i);
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, "") : "";
}

export function parseAudioFromText(text: unknown): string {
  const value = String(text ?? "").toLowerCase();
  if (/\beng\b|\benglish\b|\bdub\b/.test(value)) return "eng";
  if (/\bjpn\b|\bjapanese\b|\bjap\b/.test(value)) return "jpn";
  return "";
}

export function audioLabel(audio: string): "Sub" | "Dub" {
  const value = String(audio ?? "").toLowerCase();
  if (value === "eng" || value === "en" || value === "english" || value === "dub") return "Dub";
  return "Sub";
}

export function parsePlayButtons(html: string): PlayButton[] {
  const start = html.indexOf('id="resolutionMenu"');
  const scope = start === -1 ? html : html.substring(start);
  const buttons: PlayButton[] = [];
  const seen = new Set<string>();
  const pattern = /<(?:button|a)\b[^>]*\bdata-src\s*=\s*["'][^"']+["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(scope))) {
    const tag = match[0];
    const source = attr(tag, "data-src") ?? attr(tag, "data-url");
    if (!source || !/kwik\./i.test(source)) continue;
    if (seen.has(source)) continue;
    seen.add(source);

    let quality = attr(tag, "data-resolution");
    if (quality) quality = `${String(quality).replace(/p$/i, "")}p`;
    else quality = parseQuality(tag);

    buttons.push({
      url: decodeEntities(source),
      quality: quality ?? "",
      audio: attr(tag, "data-audio") ?? "",
      fansub: decodeEntities(attr(tag, "data-fansub") ?? ""),
      av1: String(attr(tag, "data-av1") ?? "") === "1"
    });
  }

  return buttons;
}

export function parseDownloadLinks(html: string, maxOptions: number): DownloadLink[] {
  const start = html.indexOf('id="pickDownload"');
  let scope = html;

  if (start !== -1) {
    scope = html.substring(start);
    const end = scope.indexOf("</div>");
    if (end !== -1) scope = scope.substring(0, end);
  }

  const links: DownloadLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(scope))) {
    const href = decodeEntities(match[1]);
    if (!/pahe\.win\//i.test(href) && !/kwik\.[a-z]+\/[fd]\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const label = stripTags(match[2]);
    const quality = parseQuality(label);
    const size = parseSize(label);
    const audio = parseAudioFromText(label);
    let source = "";
    const firstPart = label.split("\u00b7")[0];
    if (firstPart && firstPart !== label) source = firstPart.trim();
    if (!source) {
      const sourceMatch = label.match(/^(Retail|BluRay|BD|WEB[- ]?DL|TV|DVD)\b/i);
      if (sourceMatch?.[1]) source = sourceMatch[1];
    }

    links.push({ url: href, label, quality, size, audio, source });
  }

  if (maxOptions >= 0 && links.length > maxOptions) {
    links.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
    return links.slice(0, maxOptions);
  }

  return links;
}

export function extractKwikLink(text: string): string {
  const source = String(text ?? "");
  let match = source.match(/https?:\/\/(?:kwik\.[a-z]+)\/[fd]\/[A-Za-z0-9]+/i);
  if (match?.[0]) return match[0];
  match = source.match(/(?:kwik\.[a-z]+)\/[fd]\/[A-Za-z0-9]+/i);
  return match?.[0] ? `https://${match[0]}` : "";
}

export function extractMp4Url(text: string): string {
  const source = String(text ?? "");
  const patterns = [
    /url\s*[:=]\s*['"]([^'"]+)['"]/i,
    /(?:location\.href|window\.location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/i,
    /downloadUrl\s*[:=]\s*['"]([^'"]+)['"]/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match?.[1]) continue;
    const candidate = decodeEntities(unescapeJsString(match[1]));
    if (/^https?:\/\//i.test(candidate) && /\.mp4(\?|#|$)/i.test(candidate)) return candidate;
  }

  const direct = source.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  return direct?.[0] ? decodeEntities(unescapeJsString(direct[0])) : "";
}

export function parseForm(
  html: string,
  baseUrl: string
): { action: string; method: string; body: string; token: string } | null {
  const match = String(html ?? "").match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!match) return null;

  const openTag = `<form${match[1] ?? ""}>`;
  const action = attr(openTag, "action") ?? baseUrl;
  const method = String(attr(openTag, "method") ?? "POST").toUpperCase();
  const bodyParts: string[] = [];
  let token = "";
  const inputPattern = /<input\b[^>]*>/gi;
  let input: RegExpExecArray | null;

  while ((input = inputPattern.exec(match[2] ?? ""))) {
    const name = attr(input[0], "name");
    if (!name) continue;
    const value = attr(input[0], "value") ?? "";
    if (name === "_token") token = value;
    bodyParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }

  return { action: resolveUrl(baseUrl, action), method, body: bodyParts.join("&"), token };
}

export function extractToken(html: string): string {
  const source = String(html ?? "");
  let match = source.match(/name\s*=\s*["']_token["'][^>]*value\s*=\s*["']([^"']+)["']/i);
  if (match?.[1]) return decodeEntities(match[1]);
  match = source.match(/value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']_token["']/i);
  if (match?.[1]) return decodeEntities(match[1]);
  match = source.match(/_token\s*[:=]\s*["']([^"']+)["']/i);
  return match?.[1] ? decodeEntities(match[1]) : "";
}

export function parseSetCookie(headers: Headers): string {
  const raw = headers.get("set-cookie");
  if (!raw) return "";

  const parts = raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const match = part.match(/^\s*([A-Za-z0-9_-]+)=([^;]*)/);
    if (!match?.[1]) continue;
    const name = match[1];
    if (/^(path|expires|max-age|domain|samesite|secure|httponly|priority)$/i.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(`${name}=${match[2] ?? ""}`);
  }

  return out.join("; ");
}

function parseM3u8Attrs(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  let buffer = "";
  let inQuotes = false;

  function add(part: string): void {
    const equals = part.indexOf("=");
    if (equals === -1) return;
    const key = part.substring(0, equals).trim().toUpperCase();
    let valuePart = part.substring(equals + 1).trim();
    if (valuePart.startsWith('"')) valuePart = valuePart.substring(1, valuePart.length - 1);
    if (key) out[key] = valuePart;
  }

  for (let index = 0; index <= value.length; index += 1) {
    const character = index < value.length ? value.charAt(index) : ",";
    if (character === '"') {
      inQuotes = !inQuotes;
      buffer += character;
    } else if (character === "," && !inQuotes) {
      add(buffer);
      buffer = "";
    } else {
      buffer += character;
    }
  }

  return out;
}

export function inferSubtitleFormat(url: string): SubtitleFormat | null {
  const path = String(url).split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".srt")) return "srt";
  if (path.endsWith(".ass") || path.endsWith(".ssa")) return null;
  return "vtt";
}

export function parseHlsSubtitles(text: string, baseUrl: string): SubtitleCandidate[] {
  const candidates: SubtitleCandidate[] = [];
  const seen = new Set<string>();

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;

    const attributes = parseM3u8Attrs(line.substring("#EXT-X-MEDIA:".length));
    if (String(attributes.TYPE ?? "").toUpperCase() !== "SUBTITLES") continue;

    const uri = attributes.URI ?? "";
    if (!uri) continue;

    const url = resolveUrl(baseUrl, uri);
    const format = inferSubtitleFormat(url);
    if (!url || !format || seen.has(url)) continue;
    seen.add(url);

    const language = attributes.LANGUAGE || "und";
    candidates.push({
      url,
      language,
      label: attributes.NAME || language || "Subtitles",
      format
    });
  }

  return candidates;
}

export function parseTrackSubtitles(html: string, pageUrl: string): SubtitleCandidate[] {
  const candidates: SubtitleCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /<track\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(String(html ?? "")))) {
    const tag = match[0];
    const kind = String(attr(tag, "kind") ?? "").toLowerCase();
    if (kind !== "subtitles" && kind !== "captions") continue;

    const source = attr(tag, "src");
    if (!source) continue;
    if (/^(data:|blob:)/i.test(source)) continue;

    const url = resolveUrl(pageUrl, source);
    const format = inferSubtitleFormat(url);
    if (!url || !/^https?:\/\//i.test(url) || !format || seen.has(url)) continue;
    seen.add(url);

    const label = decodeEntities(attr(tag, "label") ?? "");
    const language = decodeEntities(attr(tag, "srclang") ?? attr(tag, "lang") ?? "");
    candidates.push({
      url,
      language: language || "und",
      label: label || "Subtitles",
      format
    });
  }

  return candidates;
}

export function mergeSubtitles(
  first: SubtitleCandidate[],
  second: SubtitleCandidate[]
): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = [];
  const seen = new Set<string>();
  for (const item of [...first, ...second]) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packed-player unpacker (dean.edwards packer, base-a alphabet)
// ---------------------------------------------------------------------------

function readJsString(source: string, start: number): { value: string; end: number } | null {
  const quote = source.charAt(start);
  if (quote !== "'" && quote !== '"') return null;
  let index = start + 1;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      return { value: source.substring(start + 1, index), end: index + 1 };
    }
    index += 1;
  }
  return null;
}

export function unescapeJsString(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character !== "\\") {
      out += character;
      continue;
    }
    const next = value.charAt(++index);
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "v") out += "\v";
    else if (next === "0") out += "\0";
    else if (next === "x") {
      out += String.fromCharCode(parseInt(value.substring(index + 1, index + 3), 16));
      index += 2;
    } else if (next === "u") {
      out += String.fromCharCode(parseInt(value.substring(index + 1, index + 5), 16));
      index += 4;
    } else if (next !== "\n") {
      out += next;
    }
  }
  return out;
}

function packerBase(number: number, base: number): string {
  const prefix = number < base ? "" : packerBase(Math.floor(number / base), base);
  const digit = number % base;
  return prefix + (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36));
}

function unpackPackedBlock(block: string): string | null {
  const marker = block.indexOf("}(");
  if (marker === -1) return null;
  let index = marker + 2;

  const payloadLiteral = readJsString(block, index);
  if (!payloadLiteral) return null;
  index = payloadLiteral.end;

  const numbers = block.substring(index).match(/^\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*/);
  if (!numbers?.[1] || !numbers[2]) return null;
  const base = parseInt(numbers[1], 10);
  const count = parseInt(numbers[2], 10);
  if (!base || !count) return null;
  index += numbers[0].length;

  const wordsLiteral = readJsString(block, index);
  if (!wordsLiteral) return null;

  const payload = unescapeJsString(payloadLiteral.value);
  const words = unescapeJsString(wordsLiteral.value).split("|");
  const dictionary: Record<string, string> = {};

  for (let item = 0; item < count; item += 1) {
    const token = packerBase(item, base);
    dictionary[token] = words[item] || token;
  }

  return payload.replace(/\b\w+\b/g, (word) => dictionary[word] ?? word);
}

function extractPackedBlocks(html: string): string[] {
  const blocks: string[] = [];
  const markers = [".split('|'),0,{}))", '.split("|"),0,{}))'];
  let position = 0;

  for (;;) {
    const start = html.indexOf("eval(function", position);
    if (start === -1) break;

    let end = -1;
    let markerLength = 0;
    for (const marker of markers) {
      const candidate = html.indexOf(marker, start);
      if (candidate !== -1 && (end === -1 || candidate < end)) {
        end = candidate;
        markerLength = marker.length;
      }
    }
    if (end === -1) break;

    blocks.push(html.substring(start, end + markerLength));
    position = end + markerLength;
  }

  return blocks;
}

export function findM3u8(html: string): string | null {
  for (const block of extractPackedBlocks(html)) {
    const code = unpackPackedBlock(block);
    if (!code) continue;

    const absolute = code.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/i);
    if (absolute?.[0]) return decodeEntities(absolute[0]);

    const relative = code.match(/\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/i);
    if (relative?.[0]) return `https:${decodeEntities(relative[0])}`;
  }

  const raw = html.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/i);
  return raw?.[0] ? decodeEntities(raw[0]) : null;
}
