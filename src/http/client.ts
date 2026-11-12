import { ProviderError } from "../errors.js";
import type { Logger } from "../logger.js";
import { Semaphore } from "./semaphore.js";

export interface HttpClientOptions {
  timeoutMs: number;
  maxConcurrency: number;
  retries: number;
  userAgent: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  provider: string;
  /** Do not retry POST requests unless the caller knows they are idempotent. */
  retry?: boolean;
}

export interface TextRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Raw request body, used for form posts. */
  body?: string;
  provider: string;
  redirect?: "follow" | "manual";
  retry?: boolean;
}

export interface TextResponse {
  status: number;
  ok: boolean;
  /** Final response URL after redirects. */
  url: string;
  headers: Headers;
  text: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class HttpClient {
  private readonly semaphore: Semaphore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async json<T>(url: string, request: JsonRequest): Promise<T> {
    const method = request.method ?? "GET";
    const retryable = request.retry ?? method === "GET";
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        return await this.semaphore.run(() => this.execute<T>(url, request));
      } catch (error) {
        lastError = error;
        if (!retryable || attempt === this.options.retries || !isRetryable(error)) throw error;
        const delay = retryDelay(error, attempt);
        this.options.logger.warn("upstream request retry", {
          provider: request.provider,
          attempt: attempt + 1,
          delayMs: delay,
          status: error instanceof ProviderError ? error.upstreamStatus : null
        });
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Fetch text/HTML without assuming JSON. Non-2xx statuses are returned so the
   * caller can inspect a challenge page or a redirect. Only network failures
   * and timeouts are retried.
   */
  async text(url: string, request: TextRequest): Promise<TextResponse> {
    const method = request.method ?? "GET";
    const retryable = request.retry ?? method === "GET";
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        return await this.semaphore.run(() => this.executeText(url, request));
      } catch (error) {
        lastError = error;
        if (!retryable || attempt === this.options.retries || !isRetryable(error)) throw error;
        const delay = retryDelay(error, attempt);
        this.options.logger.warn("upstream request retry", {
          provider: request.provider,
          attempt: attempt + 1,
          delayMs: delay,
          status: error instanceof ProviderError ? error.upstreamStatus : null
        });
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private async executeText(url: string, request: TextRequest): Promise<TextResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: request.method ?? "GET",
        headers: {
          "User-Agent": this.options.userAgent,
          ...request.headers
        },
        body: request.body,
        redirect: request.redirect,
        signal: controller.signal
      });

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_BODY_BYTES) {
        throw new ProviderError(request.provider, `${request.provider} response was too large`, {
          status: 502
        });
      }

      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
        throw new ProviderError(request.provider, `${request.provider} response was too large`, {
          status: 502
        });
      }

      return {
        status: response.status,
        ok: response.ok,
        url: response.url || url,
        headers: response.headers,
        text
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError(request.provider, `${request.provider} request timed out`, {
          status: 504,
          cause: error
        });
      }
      throw new ProviderError(request.provider, `${request.provider} request failed`, {
        status: 502,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute<T>(url: string, request: JsonRequest): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: request.method ?? "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": this.options.userAgent,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...request.headers
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal
      });

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

      if (!response.ok) {
        const text = await safeReadText(response);
        throw new ProviderError(
          request.provider,
          `${request.provider} returned HTTP ${response.status}`,
          {
            upstreamStatus: response.status,
            retryAfterSeconds: retryAfter,
            status: response.status === 404 ? 502 : 502,
            cause: new Error(truncate(text, 500))
          }
        );
      }

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_BODY_BYTES) {
        throw new ProviderError(request.provider, `${request.provider} response was too large`, {
          status: 502
        });
      }

      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
        throw new ProviderError(request.provider, `${request.provider} response was too large`, {
          status: 502
        });
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderError(request.provider, `${request.provider} returned invalid JSON`, {
          status: 502
        });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError(request.provider, `${request.provider} request timed out`, {
          status: 504,
          cause: error
        });
      }
      throw new ProviderError(request.provider, `${request.provider} request failed`, {
        status: 502,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const status = error.upstreamStatus;
  return status === null || status === 408 || status === 429 || status >= 500;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof ProviderError && error.retryAfterSeconds) {
    return Math.min(error.retryAfterSeconds * 1000, 5000);
  }
  return Math.min(250 * 2 ** attempt, 2000);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return truncate(await response.text(), 1000);
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
