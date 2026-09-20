// Pure logic for the disk-resident resolve/backlinks cache (`perf/disk-cache`). No Obsidian,
// no filesystem, no CLI — just the data shapes, the freshness predicate, eviction, and
// (de)serialization with validation. See src/cache/store.ts (the stateful wrapper that reads
// and writes `<vault>/.obsidian/plugins/vaire/cache.json` through these), src/cache/query.ts
// (the mode-dispatch that decides when to call these) and src/cache/fingerprint.ts.
//
// DESIGN.md's disk-cache trade-off, restated: today every Obsidian restart starts with empty
// in-memory caches, so the first render of each page pays CLI spawns again. This persists
// resolve results and backlink lists to disk so a restart can render external/cross-package
// links instantly, at the risk of showing stale names until revalidated. `persistentCache`
// picks how that risk is managed — see `isFresh` below for the exact rule per mode.

import type { BacklinkEntry, ResolveResult } from '../types';

export type PersistentCacheMode = 'off' | 'stale-while-revalidate' | 'trust-until-reindex';

/** One cached value plus when it was last written (ms since epoch) — the basis for LRU-ish eviction. */
export interface StoredEntry<T> {
  value: T;
  at: number;
}

/** Everything cached for one package root: its last-known index fingerprint (see
 *  fingerprint.ts) and its resolve/backlink entries, each keyed by full id. */
export interface PackageCacheV1 {
  fingerprint: string | null;
  resolve: Record<string, StoredEntry<ResolveResult>>;
  backlinks: Record<string, StoredEntry<BacklinkEntry[]>>;
}

/** The whole on-disk file. `version` is bumped on any incompatible shape change — see
 *  `deserialize`, which discards anything that isn't exactly this version. */
export interface CacheFileV1 {
  version: 1;
  packages: Record<string, PackageCacheV1>;
}

export function emptyCacheFile(): CacheFileV1 {
  return { version: 1, packages: {} };
}

/**
 * Whether a cached entry can be served without a fresh CLI call right now.
 *
 * - `'off'`: never — the cache isn't consulted in this mode at all.
 * - `'stale-while-revalidate'`: yes, whenever an entry exists at all. The caller is expected
 *   to also kick off a background revalidation alongside using the cached value — this
 *   predicate only governs whether *something* can be shown immediately, not whether it's
 *   guaranteed current.
 * - `'trust-until-reindex'`: yes, but only while the package's index fingerprint hasn't moved
 *   since the entry (or rather, the whole package's cache line) was last confirmed against it
 *   — i.e. `fingerprintNow` and `fingerprintThen` are the same non-null value. A `null`
 *   fingerprint (index.db missing or unreadable) never counts as fresh, even against another
 *   `null` — there's nothing to have "stayed the same".
 */
export function isFresh(
  entry: { at: number } | undefined,
  mode: PersistentCacheMode,
  fingerprintNow: string | null,
  fingerprintThen: string | null,
): boolean {
  if (!entry) return false;
  if (mode === 'off') return false;
  if (mode === 'stale-while-revalidate') return true;
  return fingerprintNow !== null && fingerprintNow === fingerprintThen;
}

export interface EvictCandidate {
  absRoot: string;
  kind: 'resolve' | 'backlinks';
  id: string;
  at: number;
}

/**
 * Keeps the `max` most-recently-written entries (highest `at`) out of `entries`, dropping the
 * rest — the "LRU-ish" eviction DESIGN.md asks for (it's write-recency, not read-recency,
 * since a cache hit doesn't currently bump `at`; see `PersistentCache.setResolve`). Ties break
 * by original array order so the result is deterministic for equal timestamps (this matters
 * for tests, and for a batch of entries written in the same millisecond). A no-op (returns a
 * copy) when already at or under `max`.
 */
export function evict<T extends { at: number }>(entries: T[], max: number): T[] {
  if (max < 0) throw new RangeError('evict: max must be >= 0');
  if (entries.length <= max) return entries.slice();
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || a.index - b.index)
    .slice(0, max)
    .map((x) => x.entry);
}

function isStoredEntry(x: unknown): x is StoredEntry<unknown> {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return 'value' in e && typeof e.at === 'number' && Number.isFinite(e.at);
}

function isRecordOf(x: unknown, check: (v: unknown) => boolean): x is Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  return Object.values(x as Record<string, unknown>).every(check);
}

function isPackageCache(x: unknown): x is PackageCacheV1 {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (!('fingerprint' in p) || !('resolve' in p) || !('backlinks' in p)) return false;
  if (p.fingerprint !== null && typeof p.fingerprint !== 'string') return false;
  if (!isRecordOf(p.resolve, isStoredEntry)) return false;
  if (!isRecordOf(p.backlinks, isStoredEntry)) return false;
  return true;
}

/** `JSON.stringify` — split out mostly so `store.ts` never has to think about the wire format
 *  directly, and so a future format tweak (e.g. pretty-printing) has one place to happen. */
export function serialize(data: CacheFileV1): string {
  return JSON.stringify(data);
}

/**
 * Parses and validates a cache file: wrong JSON, a missing/wrong `version`, or any package
 * entry that doesn't match the expected shape discards the *entire* file (returns `null`)
 * rather than trying to salvage part of it — per DESIGN.md, "corrupt/unknown-version files are
 * discarded". The caller (`PersistentCache.load`) treats `null` the same as "no file yet":
 * start from an empty cache.
 */
export function deserialize(text: string): CacheFileV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (!isRecordOf(obj.packages, isPackageCache)) return null;
  return { version: 1, packages: obj.packages as unknown as Record<string, PackageCacheV1> };
}
