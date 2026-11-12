import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createContainer } from "../src/container.js";
import { silentLogger, testConfig } from "./helpers.js";

describe("provider registration and configuration", () => {
  it("registers the catalogue provider and the opt-in AnimePahe provider exactly once", () => {
    const container = createContainer(testConfig(), silentLogger(), null);
    const ids = container.sourceProviders.map((provider) => provider.id);

    expect(ids.sort()).toEqual(["animepahe", "catalog"]);
    expect(ids.filter((id) => id === "animepahe")).toHaveLength(1);
    expect(ids.filter((id) => id === "catalog")).toHaveLength(1);
    expect(container.sourceProviders.find((provider) => provider.id === "catalog")?.isConfigured()).toBe(false);
    expect(container.sourceProviders.find((provider) => provider.id === "animepahe")?.isConfigured()).toBe(false);
  });

  it("enables AnimePahe only when the operator opts in", () => {
    const container = createContainer(
      testConfig({ SOURCE_ANIMEPAHE_ENABLED: "true" }),
      silentLogger(),
      null
    );

    expect(container.sourceProviders.find((provider) => provider.id === "animepahe")?.isConfigured()).toBe(true);
    expect(container.config.sources.providerTimeoutMs).toBe(45000);
  });

  it("keeps the catalogue enabled independently of AnimePahe", () => {
    const config = testConfig({
      SOURCE_CATALOG_ENABLED: "false",
      SOURCE_ANIMEPAHE_ENABLED: "true"
    });
    const container = createContainer(config, silentLogger(), null);

    expect(container.sourceProviders.find((provider) => provider.id === "catalog")?.isConfigured()).toBe(false);
    expect(container.sourceProviders.find((provider) => provider.id === "animepahe")?.isConfigured()).toBe(true);
  });

  it("rejects invalid provider configuration instead of silently disabling it", () => {
    expect(() => loadConfig({ NODE_ENV: "test", SOURCE_PROVIDER_TIMEOUT_MS: "10" })).toThrow(
      /SOURCE_PROVIDER_TIMEOUT_MS/
    );
    expect(() => loadConfig({ NODE_ENV: "test", SOURCE_ANIMEPAHE_ENABLED: "maybe" })).toThrow(
      /SOURCE_ANIMEPAHE_ENABLED/
    );
    expect(() => loadConfig({ NODE_ENV: "test", ANIMEPAHE_BASE_URL: "ftp://animepahe.example" })).toThrow(
      /ANIMEPAHE_BASE_URL/
    );
    expect(() => loadConfig({ NODE_ENV: "test", LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});
