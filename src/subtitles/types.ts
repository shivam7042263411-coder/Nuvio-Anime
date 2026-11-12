import type { SubtitleFormat } from "./parse.js";

export interface SubtitleTrack {
  id: string;
  language: string;
  label: string;
  format: SubtitleFormat;
  url: string;
  headers: Record<string, string>;
  isDefault: boolean;
  source: string;
  /** External tracks are the only tracks advertised as selectable. */
  selectable: true;
}

export interface EmbeddedSubtitle {
  language: string;
  label: string;
  source: string;
  selectable: false;
}

/** Returned by source providers that can discover external/embedded subtitles. */
export interface ProviderSubtitleResult {
  tracks: SubtitleTrack[];
  embedded: EmbeddedSubtitle[];
  warnings: string[];
}
