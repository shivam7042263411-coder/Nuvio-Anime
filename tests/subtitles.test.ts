import { describe, expect, it } from "vitest";
import {
  detectSubtitleFormat,
  formatTimestamp,
  parseSubtitle,
  toVtt
} from "../src/subtitles/parse.js";

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
General Kenobi.
`;

const VTT = `WEBVTT

NOTE this is a comment

intro
00:00:01.000 --> 00:00:03.500 align:start
Hello there.

00:04.000 --> 00:06.000
General Kenobi.
`;

describe("subtitle parsing", () => {
  it("parses SRT cues and timestamps", () => {
    const parsed = parseSubtitle(SRT);
    expect(parsed.format).toBe("srt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({
      index: 1,
      startMs: 1000,
      endMs: 3500,
      text: "Hello there."
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("parses WebVTT with cue identifiers and settings", () => {
    const parsed = parseSubtitle(VTT);
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[1]?.startMs).toBe(4000);
    expect(parsed.cues[1]?.text).toBe("General Kenobi.");
  });

  it("detects format from the header", () => {
    expect(detectSubtitleFormat(SRT)).toBe("srt");
    expect(detectSubtitleFormat(VTT)).toBe("vtt");
  });

  it("reports malformed blocks without throwing", () => {
    const parsed = parseSubtitle(`garbage\n\n1\n00:00:01,000 --> 00:00:02,000\nok`);
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.warnings.length).toBe(1);
  });

  it("rejects reversed time ranges", () => {
    const parsed = parseSubtitle(`1\n00:00:05,000 --> 00:00:02,000\nbad`);
    expect(parsed.cues).toHaveLength(0);
    expect(parsed.warnings[0]).toContain("invalid SRT time range");
  });

  it("converts parsed cues to WebVTT", () => {
    const parsed = parseSubtitle(SRT);
    const vtt = toVtt(parsed);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.500");
  });

  it("formats timestamps with hours", () => {
    expect(formatTimestamp(3_723_004)).toBe("01:02:03,004");
  });
});
