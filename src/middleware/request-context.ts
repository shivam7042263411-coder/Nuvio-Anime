import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env.js";

export type { AppEnv } from "./app-env.js";

export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id =
      incoming && /^[a-zA-Z0-9._-]{8,80}$/.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.set("startedAt", Date.now());
    c.header("X-Request-Id", id);
    await next();
  };
}
