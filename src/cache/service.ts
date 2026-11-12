import type { Logger } from "../logger.js";
import { MemoryCache } from "./memory.js";
import type {
  CacheBackend,
  CacheRecord,
  RememberOptions,
  RememberResult
} from "./types.js";

interface CacheServiceOptions {
  memory: MemoryCache;
  postgres?: CacheBackend;
  logger: Logger;
  defaultStaleSeconds: number;
}

/**
 * Two-tier cache with request coalescing and stale-on-error.
 *
 * - L1: process memory, lost when the app sleeps. Fast.
 * - L2: Postgres, shared across restarts and deployments. Not used for
 *   short-lived signed source/subtitle URLs.
 */
export class CacheService {
  private readonly inflight = new Map<string, Promise<RememberResult<unknown>>>();

  constructor(private readonly options: CacheServiceOptions) {}

  get memory(): MemoryCache {
    return this.options.memory;
  }

  /**
   * Read a value. `memoryOnly` callers (signed source/subtitle URLs) must not
   * fall through to Postgres, otherwise a value persisted by an older release
   * or another process could be replayed after it was meant to be memory-only.
   */
  async get<T>(key: string, options: RememberOptions = {}): Promise<CacheRecord<T> | undefined> {
    const local = await this.options.memory.get(key);
    if (local) return local as CacheRecord<T>;
    if (options.memoryOnly) return undefined;

    const shared = await this.options.postgres?.get(key).catch((error) => {
      this.options.logger.warn("cache read failed", { key, error });
      return undefined;
    });
    if (!shared) return undefined;

    await this.options.memory.set(key, shared);
    return shared as CacheRecord<T>;
  }

  async set<T>(key: string, value: T, ttlSeconds: number, options: RememberOptions = {}): Promise<void> {
    const now = Date.now();
    const staleSeconds = options.staleTtlSeconds ?? this.options.defaultStaleSeconds;
    const record: CacheRecord<T> = {
      value,
      expiresAt: now + ttlSeconds * 1000,
      staleUntil: now + (ttlSeconds + staleSeconds) * 1000
    };

    await this.options.memory.set(key, record);
    if (options.memoryOnly) return;

    await this.options.postgres?.set(key, record, ttlSeconds * 1000).catch((error) => {
      this.options.logger.warn("cache write failed", { key, error });
    });
  }

  async delete(key: string): Promise<void> {
    await this.options.memory.delete(key);
    await this.options.postgres?.delete(key).catch(() => undefined);
  }

  /**
   * Return a fresh value when possible. When the upstream loader fails and a
   * stale value exists, serve it with `stale: true` instead of failing.
   * Concurrent misses for the same key share one upstream request.
   */
  async remember<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: RememberOptions = {}
  ): Promise<RememberResult<T>> {
    const existing = await this.get<T>(key, options);
    if (existing && existing.expiresAt > Date.now()) {
      return { value: existing.value, cached: true, stale: false };
    }

    const running = this.inflight.get(key) as Promise<RememberResult<T>> | undefined;
    if (running) return running;

    const promise = this.loadAndStore(key, ttlSeconds, loader, options, existing)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise as Promise<RememberResult<unknown>>);
    return promise;
  }

  private async loadAndStore<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: RememberOptions,
    existing: CacheRecord<T> | undefined
  ): Promise<RememberResult<T>> {
    try {
      const value = await loader();
      await this.set(key, value, ttlSeconds, options);
      return { value, cached: false, stale: false };
    } catch (error) {
      if (existing && existing.staleUntil > Date.now()) {
        this.options.logger.warn("serving stale cache after upstream failure", {
          key,
          error
        });
        return { value: existing.value, cached: true, stale: true };
      }
      throw error;
    }
  }
}
