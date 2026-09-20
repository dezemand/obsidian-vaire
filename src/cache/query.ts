// Persistent-cache-aware wrappers around `cli.resolve`/`cli.backlinks`, dispatching on
// `settings.persistentCache`. See src/cache/pure.ts (`isFresh` — the freshness predicate per
// mode, shared by both wrappers below), src/cache/store.ts (the on-disk store) and
// src/cache/fingerprint.ts.
//
// `cachedResolve` backs `VairePlugin.resolveViaCli` (main.ts), which layers the in-memory
// `resolveMemo` on top — a cache hit here is only ever paid once per repo+id per session, same
// as a CLI spawn was before this branch. `cachedBacklinks` backs `src/views/backlinks-data.ts`'s
// backlink-list lookup and, through it, both the node panel and the dedicated backlinks view.
//
// - `'off'`: goes straight to the CLI, exactly like this branch's ancestor — no cache read or
//   write, so the two branches compare cleanly (see BRANCHES.md `perf/disk-cache`).
// - `'stale-while-revalidate'`: a cache hit (if any) is returned immediately, and a background
//   refetch is kicked off alongside it. If the refetched value actually differs, the cache is
//   updated, `resolveMemo` is updated so the *next* lookup this session sees it too, and
//   `'cache-revalidated'` (payload: `absRoot, id`) is triggered — `src/render/ref-el.ts`'s
//   element registry listens for that and redraws anything on screen showing that reference.
// - `'trust-until-reindex'`: a cache hit is trusted for as long as the package's index
//   fingerprint (fingerprint.ts) hasn't moved since it was last confirmed. Any change drops
//   *every* entry cached for that package (both resolve and backlinks) before falling through
//   to a fresh CLI call — see `reconcileFingerprint`.

import { VaireError, resolveMemoKey } from '../cli';
import { fingerprint } from './fingerprint';
import { isFresh, type PersistentCacheMode } from './pure';
import type { PersistentCache } from './store';
import type { BacklinkEntry, ResolveResult } from '../types';
import type VairePlugin from '../main';

function resultsEqual(a: ResolveResult, b: ResolveResult): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function backlinksEqual(a: BacklinkEntry[], b: BacklinkEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * For `'trust-until-reindex'` only: compares the package's currently-stored fingerprint
 * against a freshly-computed one and, if they differ, drops every entry cached for `absRoot`
 * and records the new fingerprint — so a stale entry from before the change is never served
 * past this call. Returns the fingerprint that now matches what's on disk (or `null` for the
 * other modes, which don't gate on it — they pass `fingerprintNow`/`fingerprintThen` as equal,
 * cache-format-agnostic values into `isFresh`, which ignores them outside trust mode anyway).
 */
function reconcileFingerprint(cache: PersistentCache, absRoot: string, mode: PersistentCacheMode): string | null {
  if (mode !== 'trust-until-reindex') return null;
  const now = fingerprint(absRoot);
  if (cache.getFingerprint(absRoot) !== now) {
    cache.dropPackage(absRoot);
    cache.setFingerprint(absRoot, now);
  }
  return now;
}

async function fetchResolve(plugin: VairePlugin, absRoot: string, id: string): Promise<ResolveResult | null> {
  try {
    return await plugin.cli.resolve(absRoot, id);
  } catch (err) {
    if (err instanceof VaireError && err.kind === 'id_not_found') return null;
    throw err;
  }
}

async function fetchBacklinks(plugin: VairePlugin, absRoot: string, id: string): Promise<BacklinkEntry[]> {
  const result = await plugin.cli.backlinks(absRoot, id);
  return result.backlinks;
}

export async function cachedResolve(plugin: VairePlugin, absRoot: string, id: string): Promise<ResolveResult | null> {
  const mode = plugin.settings.persistentCache;
  if (mode === 'off') return fetchResolve(plugin, absRoot, id);

  await plugin.cacheReady;
  const cache = plugin.cache;
  const fingerprintNow = reconcileFingerprint(cache, absRoot, mode);
  const entry = cache.getResolve(absRoot, id);
  const fingerprintThen = cache.getFingerprint(absRoot);

  if (isFresh(entry, mode, fingerprintNow, fingerprintThen)) {
    cache.recordHit();
    if (mode === 'stale-while-revalidate') void revalidateResolve(plugin, absRoot, id);
    return entry!.value;
  }

  cache.recordMiss();
  const value = await fetchResolve(plugin, absRoot, id);
  if (value) cache.setResolve(absRoot, id, value);
  return value;
}

async function revalidateResolve(plugin: VairePlugin, absRoot: string, id: string): Promise<void> {
  let value: ResolveResult | null;
  try {
    value = await fetchResolve(plugin, absRoot, id);
  } catch {
    return; // transient failure (spawn error, index locked, ...) — keep serving the stale value
  }
  const cache = plugin.cache;
  cache.recordRevalidation();
  const previous = cache.getResolve(absRoot, id);
  const memoKey = resolveMemoKey(absRoot, id);

  if (value === null) {
    if (!previous) return; // was already "not found" as far as the cache knew — nothing changed
    cache.dropResolve(absRoot, id);
    plugin.resolveMemo.delete(memoKey);
    plugin.events.trigger('cache-revalidated', absRoot, id);
    return;
  }

  cache.setResolve(absRoot, id, value);
  plugin.resolveMemo.set(memoKey, Promise.resolve(value));
  if (!previous || !resultsEqual(previous.value, value)) {
    plugin.events.trigger('cache-revalidated', absRoot, id);
  }
}

export async function cachedBacklinks(plugin: VairePlugin, absRoot: string, id: string): Promise<BacklinkEntry[]> {
  const mode = plugin.settings.persistentCache;
  if (mode === 'off') return fetchBacklinks(plugin, absRoot, id);

  await plugin.cacheReady;
  const cache = plugin.cache;
  const fingerprintNow = reconcileFingerprint(cache, absRoot, mode);
  const entry = cache.getBacklinks(absRoot, id);
  const fingerprintThen = cache.getFingerprint(absRoot);

  if (isFresh(entry, mode, fingerprintNow, fingerprintThen)) {
    cache.recordHit();
    if (mode === 'stale-while-revalidate') void revalidateBacklinks(plugin, absRoot, id);
    return entry!.value;
  }

  cache.recordMiss();
  const value = await fetchBacklinks(plugin, absRoot, id);
  cache.setBacklinks(absRoot, id, value);
  return value;
}

async function revalidateBacklinks(plugin: VairePlugin, absRoot: string, id: string): Promise<void> {
  let value: BacklinkEntry[];
  try {
    value = await fetchBacklinks(plugin, absRoot, id);
  } catch {
    return;
  }
  const cache = plugin.cache;
  cache.recordRevalidation();
  const previous = cache.getBacklinks(absRoot, id);
  cache.setBacklinks(absRoot, id, value);
  // No dedicated UI registry re-renders on a backlinks change the way ref-el.ts's does for
  // resolve (the node panel/backlinks view re-fetch on their own triggers — file-open,
  // index-rebuilt, a fresh render), but the event still fires: it's cheap, and a future
  // listener (or a debugging session watching the event) shouldn't have to guess why backlinks
  // are silently exempted from it.
  if (!previous || !backlinksEqual(previous.value, value)) {
    plugin.events.trigger('cache-revalidated', absRoot, id);
  }
}
