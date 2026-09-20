// Rendering feature: reading-mode links + node header, live-preview decorations, the
// live-preview click router, and clickable `vaire/…` shape links in rendered Mermaid
// diagrams. See DESIGN.md "Features §1 Rendering" and "Phase 2 ownership".

import type VairePlugin from '../main';
import { registerReadingPostProcessor } from './reading';
import { registerLivePreview } from './live';
import { registerClickRouter } from './click';
import { registerPropertiesLinks } from './properties';
import { registerRelationsFooter } from './relations';
import { registerDiagramLinks } from './diagrams';
import { registerHoverPreview } from './hover-preview';
import { DocumentPrefetcher } from './prefetch';
import { registerEmbeds } from './embeds';
import { registerExplorerBadges } from './explorer';
import { registerTypeLabels } from './type-labels';
import { registerCacheRevalidation } from './ref-el';

export function registerRendering(plugin: VairePlugin): void {
  // perf/refs-prefetch: wires `plugin.prefetchDocument` to the per-document batched
  // refs+render prefetch (see prefetch.ts); a no-op on `main`, which has no such field.
  const prefetcher = new DocumentPrefetcher(plugin);
  plugin.prefetchDocument = (pkg, node) => prefetcher.prefetch(pkg, node);

  // perf/disk-cache: redraws a rendered reference in place when a background revalidation
  // (persistentCache: 'stale-while-revalidate') changes its value — see ref-el.ts.
  registerCacheRevalidation(plugin);

  registerReadingPostProcessor(plugin);
  registerLivePreview(plugin);
  registerClickRouter(plugin);
  registerPropertiesLinks(plugin);
  registerRelationsFooter(plugin);
  registerDiagramLinks(plugin);
  registerHoverPreview(plugin);
  // Registered after the reading post processor (post processors run in registration order
  // for a given sortOrder): embeds.ts's `.internal-embed` sweep only needs to run once per
  // section and doesn't depend on link rewriting having happened first, but keeping rendering
  // concerns grouped together here (rather than interleaved) matches the other passes.
  registerEmbeds(plugin);
  registerExplorerBadges(plugin);
  registerTypeLabels(plugin);
}
