export interface CacheRecord<T = unknown> {
  value: T;
  /** Fresh until this Unix epoch millisecond. */
  expiresAt: number;
  /** May still be served when the loader fails, until this epoch millisecond. */
  staleUntil: number;
}

export interface CacheBackend {
  get(key: string): Promise<CacheRecord | undefined>;
  set(key: string, record: CacheRecord, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RememberOptions {
  /** Extra time after freshness during which a failed load may serve the old value. */
  staleTtlSeconds?: number;
  /** Skip the Postgres layer. Use for signed or short-lived URLs. */
  memoryOnly?: boolean;
}

export interface RememberResult<T> {
  value: T;
  cached: boolean;
  stale: boolean;
}
