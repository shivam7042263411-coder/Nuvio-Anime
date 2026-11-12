import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/cache/memory.js";
import { CacheService } from "../src/cache/service.js";
import type { CacheBackend, CacheRecord } from "../src/cache/types.js";
import { silentLogger, testCache, testConfig } from "./helpers.js";

class FakeBackend implements CacheBackend {
  readonly values = new Map<string, CacheRecord>();
  writes = 0;

  async get(key: string): Promise<CacheRecord | undefined> {
    return this.values.get(key);
  }
  async set(key: string, record: CacheRecord): Promise<void> {
    this.writes += 1;
    this.values.set(key, record);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

afterEach(() => vi.useRealTimers());

describe("cache service", () => {
  it("returns a fresh cached value without calling the loader twice", async () => {
    const config = testConfig();
    const cache = testCache(config);
    const loader = vi.fn(async () => ({ value: 42 }));

    const first = await cache.remember("key", 60, loader);
    const second = await cache.remember("key", 60, loader);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent misses into one upstream request", async () => {
    const config = testConfig();
    const cache = testCache(config);
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "value";
    };

    const results = await Promise.all([
      cache.remember("same-key", 60, loader),
      cache.remember("same-key", 60, loader),
      cache.remember("same-key", 60, loader)
    ]);

    expect(calls).toBe(1);
    expect(results.map((result) => result.value)).toEqual(["value", "value", "value"]);
  });

  it("expires fresh values but serves stale data when the loader fails", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const cache = testCache(config);

    await cache.remember("stale-key", 1, async () => "old", { staleTtlSeconds: 60 });
    vi.advanceTimersByTime(2_000);

    const result = await cache.remember(
      "stale-key",
      1,
      async () => {
        throw new Error("upstream down");
      },
      { staleTtlSeconds: 60 }
    );

    expect(result.value).toBe("old");
    expect(result.stale).toBe(true);
  });

  it("writes memory-only entries only to the memory tier", async () => {
    const config = testConfig();
    const backend = new FakeBackend();
    const cache = testCache(config, backend);

    await cache.remember("signed-url", 60, async () => "temporary", { memoryOnly: true });

    expect(backend.writes).toBe(0);
    expect(await cache.get("signed-url")).toBeDefined();
  });

  it("does not read a persisted value for memory-only keys", async () => {
    const config = testConfig();
    const backend = new FakeBackend();
    const cache = testCache(config, backend);
    backend.values.set("sources:v2:anilist:1:e1", {
      value: { url: "https://cdn.example/expired.m3u8" },
      expiresAt: Date.now() + 60_000,
      staleUntil: Date.now() + 120_000
    });

    const loader = vi.fn(async () => ({ url: "https://cdn.example/fresh.m3u8" }));
    const result = await cache.remember("sources:v2:anilist:1:e1", 60, loader, {
      memoryOnly: true
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.value).toEqual({ url: "https://cdn.example/fresh.m3u8" });
    expect(result.cached).toBe(false);
    expect((await cache.get("sources:v2:anilist:1:e1"))?.value).toEqual({
      url: "https://cdn.example/fresh.m3u8"
    });
  });

  it("promotes a Postgres value into memory", async () => {
    const config = testConfig();
    const backend = new FakeBackend();
    const cache = testCache(config, backend);
    backend.values.set("shared", {
      value: "from-postgres",
      expiresAt: Date.now() + 60_000,
      staleUntil: Date.now() + 120_000
    });

    const result = await cache.get<string>("shared");
    expect(result?.value).toBe("from-postgres");
    expect(cache.memory.size).toBe(1);
  });

  it("bounds memory usage", async () => {
    const memory = new MemoryCache(2);
    const record = { value: 1, expiresAt: Date.now() + 1000, staleUntil: Date.now() + 2000 };
    await memory.set("a", record);
    await memory.set("b", record);
    await memory.set("c", record);
    expect(memory.size).toBe(2);
    expect(await memory.get("a")).toBeUndefined();
  });
});
