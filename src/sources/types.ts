import type { Episode } from "../episodes/types.js";
import type { AnimeMetadata } from "../metadata/types.js";
import type { ProviderSubtitleResult } from "../subtitles/types.js";

export type SourceLabel = "Sub" | "Dub" | "DL";
export type StreamType = "hls" | "dash" | "mp4";

export interface Source {
  id: string;
  provider: string;
  /** Human-readable provider label, for example "AnimePahe". */
  providerName?: string;
  /** Sub, Dub or DL. DL is a streaming label, never a download action. */
  label: SourceLabel;
  language: string | null;
  quality: string | null;
  type: StreamType;
  delivery: "stream";
  url: string;
  headers: Record<string, string>;
  expiresAt: string | null;
  temporary: boolean;
  /** Optional variant detail such as a fansub group or DL release name. */
  name?: string;
  /** Optional informational size for a direct-file release. */
  size?: string | null;
}

export interface SourceContext {
  anime: AnimeMetadata;
  episode: Episode;
}

export interface ProviderResult {
  sources: Source[];
  warnings: string[];
}

export interface SourceProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  getSources(context: SourceContext): Promise<ProviderResult>;
  /** Optional: providers that can discover subtitles alongside their sources. */
  getSubtitles?(context: SourceContext): Promise<ProviderSubtitleResult>;
}
