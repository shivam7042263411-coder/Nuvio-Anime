import { z } from "zod";
import { ValidationError } from "./errors.js";

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "q must be at least 2 characters")
    .max(100, "q must be at most 100 characters"),
  page: z.coerce.number().int().min(1).max(100).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export const animeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^(anilist|tmdb):\d+$/,
    "id must look like anilist:123 or tmdb:456"
  );

export const episodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^(anilist|tmdb):\d+:(?:s\d+:)?e\d+$/,
    "episode id must look like anilist:123:e1, anilist:123:s2:e5 or tmdb:456:s1:e3"
  );

export const episodesQuerySchema = z.object({
  season: z.coerce.number().int().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export function parseWith<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Invalid request parameters", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }
  return result.data;
}

export function clientIp(headers: Headers, trustProxy: boolean, fallback = "unknown"): string {
  if (trustProxy) {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]?.trim() || fallback;
    const real = headers.get("x-real-ip");
    if (real) return real;
  }
  return fallback;
}
