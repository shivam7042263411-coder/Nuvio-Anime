import type { CacheBackend, CacheRecord } from "./types.js";

/** Bounded in-process TTL cache. The first tier in front of Postgres. */
export class MemoryCache implements CacheBackend {
  private readonly entries = new Map<string, CacheRecord>();

  constructor(private readonly maxEntries = 500) {}

  async get(key: string): Promise<CacheRecord | undefined> {
    const record = this.entries.get(key);
    if (!record) return undefined;
    if (record.staleUntil <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, record);
    return record;
  }

  async set(key: string, record: CacheRecord): Promise<void> {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, record);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
