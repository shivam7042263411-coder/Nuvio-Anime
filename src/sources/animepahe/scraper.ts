import { ProviderError } from "../../errors.js";
import type { TextRequest, TextResponse } from "../../http/client.js";
import type { Logger } from "../../logger.js";
import {
  extractKwikLink,
  extractMp4Url,
  extractToken,
  findM3u8,
  isCloudflareBlock,
  originOf,
  parseForm,
  parseHlsSubtitles,
  parseSetCookie,
  parseTrackSubtitles,
  resolveUrl,
  type SubtitleCandidate
} from "./parse.js";
import { parseIntSafe, type AnimePaheEntry } from "./matching.js";

const KWIK_HOST = /^(?:[a-z0-9-]+\.)*kwik\.[a-z]{2,}$/i;
const PAHE_HOST = /^(?:[a-z0-9-]+\.)*pahe\.[a-z]{2,}$/i;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True only when the URL host is exactly kwik.<tld> or a subdomain of it. */
function isKwikHost(url: string): boolean {
  return KWIK_HOST.test(hostnameOf(url));
}

/** True only when the URL host is exactly pahe.<tld> or a subdomain of it. */
function isPaheHost(url: string): boolean {
  return PAHE_HOST.test(hostnameOf(url));
}

export interface AnimePaheHttp {
  text(url: string, request: TextRequest): Promise<TextResponse>;
}

export type AnimePaheFailureKind = "blocked" | "http" | "network" | "invalid";

export class AnimePaheRequestError extends Error {
  constructor(
    readonly kind: AnimePaheFailureKind,
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "AnimePaheRequestError";
  }
}

export interface Release {
  session: string;
  episode: number;
  episode2: number;
}

interface ReleasePage {
  data: Release[];
  lastPage: number;
}

export interface ResolvedPlayback {
  url: string;
  headers: Record<string, string>;
  type: "hls" | "mp4";
  subtitles: SubtitleCandidate[];
}

export interface ScraperOptions {
  http: AnimePaheHttp;
  logger: Logger;
  baseUrl: string;
  userAgent: string;
  maxSearchPages: number;
  maxDownloadOptions: number;
}

interface RawEntry {
  session?: unknown;
  id?: unknown;
  title?: unknown;
  type?: unknown;
  episodes?: unknown;
  year?: unknown;
  status?: unknown;
}

interface RawRelease {
  session?: unknown;
  episode?: unknown;
  episode2?: unknown;
}

export class AnimePaheScraper {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly searchHeaders: Record<string, string>;
  private readonly playbackHeaders: Record<string, string>;

  constructor(private readonly options: ScraperOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.userAgent = options.userAgent;
    this.searchHeaders = {
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${this.baseUrl}/`
    };
    this.playbackHeaders = {
      "User-Agent": this.userAgent,
      Referer: "https://kwik.cx/",
      Origin: "https://kwik.cx",
      Accept: "*/*"
    };
  }

  async search(query: string): Promise<AnimePaheEntry[]> {
    const value = String(query ?? "").trim();
    if (!value) return [];

    const firstUrl = `${this.baseUrl}/api?m=search&l=30&q=${encodeURIComponent(value)}`;
    const first = await this.getJson(firstUrl);
    const entries: AnimePaheEntry[] = [];
    const seen = new Set<string>();

    const add = (items: unknown): number => {
      if (!Array.isArray(items)) return 0;
      let added = 0;
      for (const item of items) {
        const entry = normalizeEntry(item);
        if (!entry || seen.has(entry.session)) continue;
        seen.add(entry.session);
        entries.push(entry);
        added += 1;
      }
      return added;
    };

    const firstPayload = first as { data?: unknown; last_page?: unknown } | unknown[];
    const firstList = Array.isArray(firstPayload) ? firstPayload : firstPayload?.data;
    add(firstList);

    const lastPage = Array.isArray(firstPayload) ? 1 : parseIntSafe(firstPayload?.last_page) || 1;
    const maxPage = Math.min(lastPage, this.options.maxSearchPages);

    for (let page = 2; page <= maxPage; page += 1) {
      const payload = await this.getJson(`${firstUrl}&page=${page}`);
      const pagePayload = payload as { data?: unknown } | unknown[];
      const pageList = Array.isArray(pagePayload) ? pagePayload : pagePayload?.data;
      if (add(pageList) === 0) break;
    }

    return entries;
  }

  async findEpisode(
    animeSession: string,
    targetEpisode: number,
    allowFirst: boolean
  ): Promise<Release | null> {
    let target = parseIntSafe(targetEpisode);
    if (target < 1) target = 1;

    const cache = new Map<number, ReleasePage>();

    const getPage = async (pageNumber: number): Promise<ReleasePage> => {
      const cached = cache.get(pageNumber);
      if (cached) return cached;
      const page = await this.releasePage(animeSession, pageNumber);
      cache.set(pageNumber, page);
      return page;
    };

    const first = await getPage(1);
    const firstList = first.data;

    let exact = findExactEpisode(firstList, target);
    if (exact) return exact;

    let range = findRangeEpisode(firstList, target);
    const lastPage = Math.max(1, first.lastPage);

    if (lastPage <= 1) {
      if (allowFirst && firstList.length > 0) return firstList[0] ?? null;
      return range;
    }

    let low = 1;
    let high = lastPage;
    let guard = 0;

    while (low <= high && guard < 20) {
      guard += 1;
      const middle = Math.floor((low + high) / 2);
      if (middle === 1) {
        low = 2;
        continue;
      }

      const pageData = await getPage(middle);
      if (pageData.data.length === 0) {
        high = middle - 1;
        continue;
      }

      exact = findExactEpisode(pageData.data, target);
      if (exact) return exact;

      if (!range) range = findRangeEpisode(pageData.data, target);

      const bounds = episodeBounds(pageData.data);
      if (bounds.min === null) {
        high = middle - 1;
        continue;
      }
      if (target < bounds.min) {
        high = middle - 1;
        continue;
      }
      if (bounds.max !== null && target > bounds.max) {
        low = middle + 1;
        continue;
      }

      for (const offset of [-1, 1]) {
        const neighbor = middle + offset;
        if (neighbor < 1 || neighbor > lastPage) continue;
        const neighborData = await getPage(neighbor);
        exact = findExactEpisode(neighborData.data, target);
        if (exact) return exact;
        if (!range) range = findRangeEpisode(neighborData.data, target);
      }
      break;
    }

    if (allowFirst && firstList.length > 0) return firstList[0] ?? null;
    return range;
  }

  async playPage(animeSession: string, releaseSession: string): Promise<{ html: string; url: string }> {
    const url = `${this.baseUrl}/play/${encodeURIComponent(animeSession)}/${encodeURIComponent(releaseSession)}`;
    const response = await this.get(url, this.searchHeaders, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    return { html: response.text, url: response.url || url };
  }

  async resolveKwik(kwikUrl: string): Promise<ResolvedPlayback | null> {
    if (!isKwikHost(kwikUrl)) {
      this.options.logger.warn("animepahe refused non-kwik playback host", {
        provider: "animepahe",
        host: hostnameOf(kwikUrl)
      });
      return null;
    }

    try {
      const page = await this.fetchKwikPage(kwikUrl, `${this.baseUrl}/`);
      if (!page) return null;

      const playlist = findM3u8(page.html);
      if (!playlist) {
        this.options.logger.warn("animepahe kwik player exposed no playlist", {
          provider: "animepahe"
        });
        return null;
      }

      return {
        url: playlist,
        headers: { ...this.playbackHeaders },
        type: "hls",
        subtitles: parseTrackSubtitles(page.html, page.url)
      };
    } catch (error) {
      this.logOptionalFailure("animepahe kwik playback", error);
      return null;
    }
  }

  async resolveDownload(paheUrl: string): Promise<ResolvedPlayback | null> {
    if (!isPaheHost(paheUrl) && !isKwikHost(paheUrl)) {
      this.options.logger.warn("animepahe refused non-pahe download host", {
        provider: "animepahe",
        host: hostnameOf(paheUrl)
      });
      return null;
    }

    try {
      const paheResult = await this.tryGet(paheUrl, {
        ...this.searchHeaders,
        Referer: `${this.baseUrl}/`
      });
      if (!paheResult) return null;

      let kwikUrl = extractKwikLink(paheResult.text);
      if (!kwikUrl && /kwik\./i.test(paheResult.url)) kwikUrl = paheResult.url;
      if (!kwikUrl) {
        this.options.logger.warn("animepahe download page exposed no kwik link", {
          provider: "animepahe"
        });
        return null;
      }

      const fileUrl = kwikUrl.replace(/\/d\//i, "/f/");
      const downloadUrl = kwikUrl.replace(/\/f\//i, "/d/");
      if (!isKwikHost(downloadUrl)) {
        this.options.logger.warn("animepahe refused non-kwik download host", {
          provider: "animepahe",
          host: hostnameOf(downloadUrl)
        });
        return null;
      }
      const pageOrigin = originOf(downloadUrl);

      const pageResult = await this.tryGet(downloadUrl, {
        ...this.playbackHeaders,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: fileUrl,
        Origin: pageOrigin
      });
      if (!pageResult) return null;

      const form = parseForm(pageResult.text, pageResult.url || downloadUrl);
      const token = form?.token || extractToken(pageResult.text);
      const cookies = parseSetCookie(pageResult.headers);

      if (!form && !token) {
        this.options.logger.warn("animepahe kwik download page had no form or token", {
          provider: "animepahe"
        });
        return null;
      }

      const requestUrl = form ? form.action : pageResult.url || downloadUrl;
      if (!isKwikHost(requestUrl)) {
        this.options.logger.warn("animepahe refused non-kwik form action", {
          provider: "animepahe",
          host: hostnameOf(requestUrl)
        });
        return null;
      }
      const method = form ? form.method : "POST";
      let body = form ? form.body : `_token=${encodeURIComponent(token)}`;
      if (!body) body = `_token=${encodeURIComponent(token ?? "")}`;

      const requestHeaders: Record<string, string> = {
        ...this.playbackHeaders,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: fileUrl,
        Origin: pageOrigin,
        "Content-Type": "application/x-www-form-urlencoded"
      };
      if (cookies) requestHeaders.Cookie = cookies;

      const downloadResult = await this.tryGet(
        method === "GET"
          ? `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}${body}`
          : requestUrl,
        requestHeaders,
        method === "GET" ? undefined : body,
        method === "GET" ? "follow" : "manual"
      );
      if (!downloadResult) return null;

      if (downloadResult.status >= 300 && downloadResult.status < 400) {
        const location = downloadResult.headers.get("location");
        if (location) {
          const redirected = resolveUrl(requestUrl, location);
          if (/\.mp4(\?|#|$)/i.test(redirected)) {
            return {
              url: redirected,
              headers: { ...this.playbackHeaders },
              type: "mp4",
              subtitles: []
            };
          }
        }
        return null;
      }

      if (!downloadResult.ok) {
        this.options.logger.warn("animepahe kwik download request failed", {
          provider: "animepahe",
          status: downloadResult.status
        });
        return null;
      }

      const mp4Url = extractMp4Url(downloadResult.text);
      if (!mp4Url) {
        this.options.logger.warn("animepahe kwik download exposed no direct mp4", {
          provider: "animepahe"
        });
        return null;
      }

      return {
        url: mp4Url,
        headers: { ...this.playbackHeaders },
        type: /\.m3u8(\?|#|$)/i.test(mp4Url) ? "hls" : "mp4",
        subtitles: []
      };
    } catch (error) {
      this.logOptionalFailure("animepahe download", error);
      return null;
    }
  }

  async probeHlsSubtitles(
    playlistUrl: string,
    headers: Record<string, string>
  ): Promise<SubtitleCandidate[]> {
    try {
      const response = await this.options.http.text(playlistUrl, {
        headers,
        provider: "animepahe",
        retry: false
      });
      if (!response.ok || !response.text.includes("#EXT-X-MEDIA:")) return [];
      return parseHlsSubtitles(response.text, response.url || playlistUrl);
    } catch (error) {
      this.logOptionalFailure("animepahe subtitle probe", error);
      return [];
    }
  }

  private async releasePage(animeSession: string, page: number): Promise<ReleasePage> {
    const payload = await this.getJson(
      `${this.baseUrl}/api?m=release&id=${encodeURIComponent(animeSession)}&sort=episode_asc&page=${page}`
    );
    const data = payload as { data?: unknown; last_page?: unknown } | unknown[];
    const list = Array.isArray(data) ? data : data?.data;
    const releases = Array.isArray(list) ? list.map(normalizeRelease).filter((item): item is Release => item !== null) : [];
    return {
      data: releases,
      lastPage: Array.isArray(data) ? 1 : parseIntSafe(data?.last_page) || 1
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.get(url, this.searchHeaders, "application/json, text/plain, */*");
    const clean = response.text.replace(/^\uFEFF/, "").trim();
    try {
      return JSON.parse(clean) as unknown;
    } catch {
      throw new AnimePaheRequestError("invalid", "AnimePahe returned a non-JSON response");
    }
  }

  private async fetchKwikPage(
    url: string,
    referer: string
  ): Promise<{ html: string; url: string } | null> {
    const origin = originOf(url) || "https://kwik.cx";
    const response = await this.tryGet(url, {
      ...this.playbackHeaders,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: referer || `${origin}/`,
      Origin: origin
    });
    if (!response) return null;
    return { html: response.text, url: response.url || url };
  }

  private async get(
    url: string,
    headers: Record<string, string>,
    accept: string
  ): Promise<TextResponse> {
    const response = await this.request(url, headers, accept);
    this.assertUsable(response);
    return response;
  }

  private async tryGet(
    url: string,
    headers: Record<string, string>,
    body?: string,
    redirect: "follow" | "manual" = "follow"
  ): Promise<TextResponse | null> {
    try {
      const response = await this.request(
        url,
        headers,
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        body,
        redirect
      );
      if (isCloudflareBlock(response.text)) {
        this.options.logger.warn("animepahe host returned a challenge", {
          provider: "animepahe",
          challenge: true,
          status: response.status
        });
        return null;
      }
      if (response.status >= 400) {
        this.options.logger.warn("animepahe host returned an error", {
          provider: "animepahe",
          status: response.status
        });
        return null;
      }
      return response;
    } catch (error) {
      this.logOptionalFailure("animepahe host request", error);
      return null;
    }
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    accept: string,
    body?: string,
    redirect: "follow" | "manual" = "follow"
  ): Promise<TextResponse> {
    try {
      return await this.options.http.text(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, Accept: accept },
        body,
        redirect,
        provider: "animepahe"
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new AnimePaheRequestError(
          error.upstreamStatus === null ? "network" : "http",
          error.message,
          error.upstreamStatus
        );
      }
      throw new AnimePaheRequestError("network", "AnimePahe request failed");
    }
  }

  private assertUsable(response: TextResponse): void {
    if (isCloudflareBlock(response.text)) {
      throw new AnimePaheRequestError(
        "blocked",
        "AnimePahe is showing a Cloudflare challenge",
        response.status
      );
    }
    if (!response.ok) {
      throw new AnimePaheRequestError(
        "http",
        `AnimePahe returned HTTP ${response.status}`,
        response.status
      );
    }
  }

  private logOptionalFailure(label: string, error: unknown): void {
    this.options.logger.warn(`${label} failed`, {
      provider: "animepahe",
      status: error instanceof AnimePaheRequestError ? error.status : null,
      kind: error instanceof AnimePaheRequestError ? error.kind : "unknown"
    });
  }
}

function normalizeEntry(value: unknown): AnimePaheEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RawEntry;
  const session = String(raw.session ?? raw.id ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!session || !title) return null;

  return {
    session,
    title,
    type: String(raw.type ?? ""),
    episodes: parseIntSafe(raw.episodes),
    year: parseIntSafe(raw.year) || parseTitleYear(title) || null,
    status: String(raw.status ?? "")
  };
}

function normalizeRelease(value: unknown): Release | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RawRelease;
  const session = String(raw.session ?? "").trim();
  if (!session) return null;
  return {
    session,
    episode: parseFloat(String(raw.episode ?? "")),
    episode2: parseFloat(String(raw.episode2 ?? ""))
  };
}

function parseTitleYear(title: string): number {
  const match = title.match(/\((\d{4})\)/);
  return match?.[1] ? parseIntSafe(match[1]) : 0;
}

function findExactEpisode(list: Release[], target: number): Release | null {
  for (const release of list) {
    if (
      !Number.isNaN(release.episode) &&
      release.episode === target &&
      (Number.isNaN(release.episode2) || release.episode2 <= release.episode)
    ) {
      return release;
    }
  }
  return null;
}

function findRangeEpisode(list: Release[], target: number): Release | null {
  for (const release of list) {
    if (
      !Number.isNaN(release.episode) &&
      !Number.isNaN(release.episode2) &&
      release.episode2 > release.episode &&
      target >= release.episode &&
      target <= release.episode2
    ) {
      return release;
    }
  }
  return null;
}

function episodeBounds(list: Release[]): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;

  for (const release of list) {
    if (!Number.isNaN(release.episode)) {
      if (min === null || release.episode < min) min = release.episode;
      if (max === null || release.episode > max) max = release.episode;
    }
    if (!Number.isNaN(release.episode2)) {
      if (max === null || release.episode2 > max) max = release.episode2;
    }
  }

  return { min, max };
}
