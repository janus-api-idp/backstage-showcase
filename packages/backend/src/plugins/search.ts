import { useHotCleanup } from '@backstage/backend-common';
import {
  LegacyBackendPluginInstaller,
  LegacyPluginEnvironment as PluginEnvironment,
} from '@backstage/backend-plugin-manager';
import { DefaultCatalogCollatorFactory } from '@backstage/plugin-catalog-backend';
import { createRouter } from '@backstage/plugin-search-backend';
import {
  IndexBuilder,
  LunrSearchEngine,
} from '@backstage/plugin-search-backend-node';
import { PluginEnvironment } from '../types';
import { DefaultCatalogCollatorFactory } from '@backstage/plugin-catalog-backend';
import { DefaultTechDocsCollatorFactory } from '@backstage/plugin-techdocs-backend';
import { Router } from 'express';
import { ConfluenceCollatorFactory } from '@k-phoen/backstage-plugin-confluence-backend';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  // Initialize a connection to a search engine.
  const searchEngine = new LunrSearchEngine({
    logger: env.logger,
  });
  const indexBuilder = new IndexBuilder({
    logger: env.logger,
    searchEngine,
  });

  const schedule = env.scheduler.createScheduledTaskRunner({
    frequency: { minutes: 10 },
    timeout: { minutes: 15 },
    // A 3 second delay gives the backend server a chance to initialize before
    // any collators are executed, which may attempt requests against the API.
    initialDelay: { seconds: 3 },
  });

  // Collators are responsible for gathering documents known to plugins. This
  // collator gathers entities from the software catalog.
  indexBuilder.addCollator({
    schedule,
    factory: DefaultCatalogCollatorFactory.fromConfig(env.config, {
      discovery: env.discovery,
      tokenManager: env.tokenManager,
    }),
  });

  env.pluginProvider
    .backendPlugins()
    .map(p => p.installer)
    .filter((i): i is LegacyBackendPluginInstaller => i.kind === 'legacy')
    .forEach(i => {
      if (i.search) {
        i.search(indexBuilder, schedule, env);
      }
    });

  // Confluence indexing
  const halfHourSchedule = env.scheduler.createScheduledTaskRunner({
    frequency: { minutes: 30 },
    timeout: { minutes: 15 },
    // A 3 second delay gives the backend server a chance to initialize before
    // any collators are executed, which may attempt requests against the API.
    initialDelay: { seconds: 3 },
  });
  indexBuilder.addCollator({
    schedule: halfHourSchedule,
    factory: ConfluenceCollatorFactory.fromConfig(env.config, {
      logger: env.logger,
    }),
  });

  // The scheduler controls when documents are gathered from collators and sent
  // to the search engine for indexing.
  const { scheduler } = await indexBuilder.build();
  setTimeout(() => scheduler.start(), 3000);

  useHotCleanup(module, () => scheduler.stop());

  return await createRouter({
    engine: indexBuilder.getSearchEngine(),
    types: indexBuilder.getDocumentTypes(),
    permissions: env.permissions,
    config: env.config,
    logger: env.logger,
  });
}
