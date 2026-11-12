export type ErrorCode =
  | "invalid_request"
  | "not_found"
  | "anime_not_found"
  | "episode_not_found"
  | "season_unavailable"
  | "provider_error"
  | "provider_unavailable"
  | "rate_limited"
  | "database_unavailable"
  | "internal_error";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "invalid_request", message, { details });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: "not_found" | "anime_not_found" | "episode_not_found" = "not_found") {
    super(404, code, message);
    this.name = "NotFoundError";
  }
}

export class ProviderError extends AppError {
  readonly provider: string;
  readonly upstreamStatus: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    provider: string,
    message: string,
    options: {
      upstreamStatus?: number | null;
      retryAfterSeconds?: number | null;
      cause?: unknown;
      status?: number;
    } = {}
  ) {
    super(options.status ?? 502, "provider_error", message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
