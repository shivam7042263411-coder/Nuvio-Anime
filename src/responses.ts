import type { Context } from "hono";
import { AppError, isProviderError } from "./errors.js";
import type { Logger } from "./logger.js";

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  cached?: boolean;
  stale?: boolean;
  pagination?: Pagination;
  warnings?: string[];
  [key: string]: unknown;
}

export function requestId(c: Context): string {
  return (c.get("requestId" as never) as string | undefined) ?? "unknown";
}

export function meta(c: Context, extra: Omit<ResponseMeta, "requestId" | "timestamp"> = {}): ResponseMeta {
  const requestMeta: ResponseMeta = {
    requestId: requestId(c),
    timestamp: new Date().toISOString(),
    ...extra
  };
  if (requestMeta.warnings?.length === 0) delete requestMeta.warnings;
  return requestMeta;
}

export function pagination(page: number, limit: number, total: number): Pagination {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1
  };
}

export function ok<T>(c: Context, data: T, extraMeta: Omit<ResponseMeta, "requestId" | "timestamp"> = {}): Response {
  return c.json({ data, meta: meta(c, extraMeta) });
}

export function errorResponse(
  c: Context,
  logger: Logger,
  error: unknown
): Response {
  const id = requestId(c);

  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error("request failed", {
        requestId: id,
        code: error.code,
        status: error.status,
        error
      });
    } else {
      logger.warn("request rejected", {
        requestId: id,
        code: error.code,
        status: error.status,
        message: error.message
      });
    }

    const headers: Record<string, string> = {};
    if (error.code === "rate_limited") {
      const retryAfter = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retryAfter) headers["Retry-After"] = String(retryAfter);
    }
    if (isProviderError(error) && error.retryAfterSeconds) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
    }

    return c.json(
      {
        error: {
          code: error.code,
          message: error.expose ? error.message : "Internal server error",
          ...(error.details === undefined ? {} : { details: error.details })
        },
        meta: { requestId: id, timestamp: new Date().toISOString() }
      },
      error.status as 400,
      headers
    );
  }

  logger.error("unhandled error", { requestId: id, error });
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "An unexpected error occurred"
      },
      meta: { requestId: id, timestamp: new Date().toISOString() }
    },
    500
  );
}
