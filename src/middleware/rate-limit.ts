import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { AppEnv } from "./app-env.js";

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(config: Config): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  const windowMs = config.rateLimit.windowSeconds * 1000;
  let lastSweep = Date.now();

  return async (c, next) => {
    if (!config.rateLimit.enabled || c.req.path === "/health") {
      await next();
      return;
    }

    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const key = clientKey(c, config.trustProxy);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, config.rateLimit.max - bucket.count);
    c.header("X-RateLimit-Limit", String(config.rateLimit.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > config.rateLimit.max) {
      throw new AppError(429, "rate_limited", "Too many requests; try again later", {
        details: {
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        }
      });
    }

    await next();
  };
}

export function clientKey(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }

  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
