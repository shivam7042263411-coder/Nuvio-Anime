import { withTimeout } from "../async.js";
import type { CacheService } from "../cache/service.js";
import type { Config } from "../config.js";
import type { EpisodesService } from "../episodes/service.js";
import { ProviderError } from "../errors.js";
import type { Logger } from "../logger.js";
import { dedupeAndSortSources } from "./normalize.js";
import type { Source, SourceProvider } from "./types.js";

export interface SourcesResult {
  episodeId: string;
  sources: Source[];
  providers: Array<{ id: string; name: string }>;
  warnings: string[];
}

export class SourcesService {
  constructor(
    private readonly options: {
      episodeService: EpisodesService;
      providers: SourceProvider[];
      cache: CacheService;
      config: Config;
      logger: Logger;
    }
  ) {}

  async getSources(episodeId: string): Promise<SourcesResult & { cached: boolean; stale: boolean }> {
    const key = `sources:v2:${episodeId}`;
    const result = await this.options.cache.remember(
      key,
      this.options.config.cache.sourcesTtl,
      () => this.loadSources(episodeId),
      // Signed stream URLs are never written to Postgres.
      { memoryOnly: true }
    );

    return { ...result.value, cached: result.cached, stale: result.stale };
  }

  private async loadSources(episodeId: string): Promise<SourcesResult> {
    const { episode, warnings: episodeWarnings } = await this.options.episodeService.getEpisode(episodeId);
    const providers = this.options.providers.filter((provider) => provider.isConfigured());
    const warnings = [...episodeWarnings];
    const sources: Source[] = [];
    let failures = 0;

    if (providers.length === 0) {
      warnings.push(
        "No source provider is configured. Enable the authorized catalogue or the opt-in AnimePahe provider after confirming you are allowed to serve the sources."
      );
      return { episodeId, sources, providers: [], warnings };
    }

    const anime = await this.options.episodeService.getAnimeForEpisode(episode.animeId);
    const context = { anime, episode };

    const results = await Promise.allSettled(
      providers.map((provider) =>
        withTimeout(
          provider.getSources(context),
          this.options.config.sources.providerTimeoutMs,
          provider.id
        )
      )
    );

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const provider = providers[index]!;
      if (result.status === "fulfilled") {
        sources.push(...result.value.sources);
        warnings.push(...result.value.warnings);
      } else {
        failures += 1;
        this.options.logger.warn("source provider failed", {
          provider: provider.id,
          episodeId,
          error: result.reason
        });
        warnings.push(`Source provider ${provider.name} was unavailable.`);
      }
    }

    if (failures === providers.length) {
      throw new ProviderError("sources", "All configured source providers were unavailable");
    }

    return {
      episodeId,
      sources: dedupeAndSortSources(sources),
      providers: providers.map((provider) => ({ id: provider.id, name: provider.name })),
      warnings
    };
  }
}
