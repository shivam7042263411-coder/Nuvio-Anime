import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppEnv } from "./app-env.js";

export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    logger.info("request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start
    });
  };
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  };
}

export function cors(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed =
      origin &&
      (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin));

    if (allowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
      c.header("Access-Control-Expose-Headers", "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining");
      c.header("Access-Control-Max-Age", "600");
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, allowed ? 204 : 403);
    }

    await next();
  };
}
