// Per-document prefetch: batches every non-local reference in a vault node's outbound refs
// into at most two CLI calls (`refs` + `render`) instead of one `resolve` spawn per link.
// Seeds `plugin.resolveMemo` under the same key `resolveViaCli` uses (see `resolveMemoKey` in
// cli.ts), so `createRefElement`'s per-link fallback (ref-el.ts's `settleAsync`) finds
// everything already settled and never re-spawns for what this pass already covered. See
// DESIGN.md "Local index" / "CLI adapter" and BRANCHES.md `perf/refs-prefetch` for the
// trade-off this branch exists to compare against `main`'s per-link `resolve`.
//
// Deliberately best-effort: any failure here (CLI error, timeout, `prefetchMode: 'off'`) is
// swallowed and simply leaves the memo unseeded — ref-el.ts's per-link `resolveViaCli`
// fallback still resolves anything this pass didn't cover (added-since-last-index links, a
// missing binary, etc.), which is the whole point of keeping that path intact.

import { resolveMemoKey } from '../cli';
import { extractRenderedLinks, hrefMatchesPath } from './prefetch-pure';
import type { LocalNode, PackageInfo } from '../packages';
import type { RefEntry, ResolveResult } from '../types';
import type VairePlugin from '../main';

/** How long a document's prefetch stays valid before a fresh render re-fetches it. Long
 *  enough that a single document's several post-processor passes (one per section, plus the
 *  header) share one pair of CLI calls; short enough that editing dependencies elsewhere
 *  doesn't go stale for long between index rebuilds (which invalidate it immediately anyway,
 *  see the `index-rebuilt` listener below). */
const TTL_MS = 30_000;

interface CacheEntry {
  promise: Promise<void>;
  expiresAt: number;
}

/**
 * Owns the per-file prefetch cache backing `plugin.prefetchDocument`. Instantiated once by
 * `registerRendering` (render/index.ts), which wires `plugin.prefetchDocument` to
 * `prefetcher.prefetch(pkg, node)`.
 */
export class DocumentPrefetcher {
  private readonly plugin: VairePlugin;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(plugin: VairePlugin) {
    this.plugin = plugin;
    plugin.registerEvent(plugin.events.on('index-rebuilt', () => this.cache.clear()));
  }

  /**
   * Prefetches `node`'s outbound refs and rendered display names, deduped and TTL-cached per
   * file: concurrent or rapid-succession calls for the same node (reading-mode sections, the
   * node header, a re-render) share one in-flight pair of CLI calls rather than issuing their
   * own. A no-op when `settings.prefetchMode` is `'off'`.
   */
  prefetch(pkg: PackageInfo, node: LocalNode): Promise<void> {
    if (this.plugin.settings.prefetchMode === 'off') return Promise.resolve();

    const key = `${pkg.absRoot} ${node.full}`;
    const now = Date.now();
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > now) return existing.promise;

    const promise = this.run(pkg, node).catch(() => {
      // Best-effort: swallow errors and let ref-el.ts's per-link fallback handle it.
    });
    this.cache.set(key, { promise, expiresAt: now + TTL_MS });
    return promise;
  }

  private async run(pkg: PackageInfo, node: LocalNode): Promise<void> {
    const [refsResult, renderResult] = await Promise.all([
      this.plugin.cli.refs(pkg.absRoot, node.full),
      this.plugin.cli.render(pkg.absRoot, node.full),
    ]);

    const links = extractRenderedLinks(renderResult.markdown);

    for (const ref of refsResult.refs) {
      if (!needsSeeding(pkg, ref)) continue;

      const memoKey = resolveMemoKey(pkg.absRoot, ref.id);
      if (this.plugin.resolveMemo.has(memoKey)) continue; // don't clobber an in-flight/settled lookup

      const name = links.find((l) => hrefMatchesPath(l.href, ref.path))?.display;
      const result: ResolveResult = {
        id: ref.id,
        type: ref.type,
        path: ref.path,
        package: ref.package,
        // Left undefined (falls back to the file basename in ref-el.ts) when `render` never
        // linked this target — e.g. it's only reachable via a frontmatter edge, which
        // `render`'s link-rewriting doesn't touch.
        frontmatter: name ? { name } : {},
        superseded_by: null,
      };
      this.plugin.resolveMemo.set(memoKey, Promise.resolve(result));
    }
  }
}

/**
 * Whether a `refs` entry is worth seeding: `createRefElement` (via `resolveLocalSync` in
 * ref-el.ts) already resolves same-package hits straight from `LocalIndex`, synchronously and
 * without touching the CLI at all — seeding those would just be dead weight in the memo. Worth
 * seeding: anything naming a dependency package, or a same-package id this package's own index
 * doesn't have (index/vault drift).
 */
function needsSeeding(pkg: PackageInfo, ref: RefEntry): boolean {
  if (ref.package) return true;
  return pkg.index.get(ref.id) == null;
}
