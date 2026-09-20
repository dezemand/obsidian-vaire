import { describe, expect, test } from 'bun:test';
import { evict, isFresh, serialize, deserialize, emptyCacheFile, type CacheFileV1, type PackageCacheV1 } from '../src/cache/pure';
import { PersistentCache, type CacheHost, type TimerHost } from '../src/cache/store';
import type { ResolveResult, BacklinkEntry } from '../src/types';

// ---- evict ------------------------------------------------------------------------------

describe('evict', () => {
  test('keeps everything when under the limit', () => {
    const entries = [{ at: 1 }, { at: 2 }, { at: 3 }];
    expect(evict(entries, 10)).toEqual(entries);
  });

  test('keeps the most-recently-written entries, drops the rest', () => {
    const entries = [
      { id: 'a', at: 10 },
      { id: 'b', at: 30 },
      { id: 'c', at: 20 },
    ];
    const kept = evict(entries, 2);
    expect(kept.map((e) => e.id)).toEqual(['b', 'c']);
  });

  test('exactly at the limit is a no-op (returns a copy, not the same array)', () => {
    const entries = [{ at: 1 }, { at: 2 }];
    const kept = evict(entries, 2);
    expect(kept).toEqual(entries);
    expect(kept).not.toBe(entries);
  });

  test('max 0 drops everything', () => {
    expect(evict([{ at: 1 }, { at: 2 }], 0)).toEqual([]);
  });

  test('ties break by original order (stable)', () => {
    const entries = [
      { id: 'a', at: 5 },
      { id: 'b', at: 5 },
      { id: 'c', at: 5 },
    ];
    expect(evict(entries, 2).map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('empty input', () => {
    expect(evict([], 5)).toEqual([]);
  });

  test('negative max throws', () => {
    expect(() => evict([{ at: 1 }], -1)).toThrow(RangeError);
  });
});

// ---- isFresh ------------------------------------------------------------------------------

describe('isFresh', () => {
  const entry = { at: 123 };

  test('no entry is never fresh, in any mode', () => {
    expect(isFresh(undefined, 'off', null, null)).toBe(false);
    expect(isFresh(undefined, 'stale-while-revalidate', 'fp', 'fp')).toBe(false);
    expect(isFresh(undefined, 'trust-until-reindex', 'fp', 'fp')).toBe(false);
  });

  test("'off' is never fresh even with an entry and matching fingerprints", () => {
    expect(isFresh(entry, 'off', 'fp', 'fp')).toBe(false);
  });

  test("'stale-while-revalidate' is fresh whenever an entry exists, fingerprints ignored", () => {
    expect(isFresh(entry, 'stale-while-revalidate', null, null)).toBe(true);
    expect(isFresh(entry, 'stale-while-revalidate', 'a', 'b')).toBe(true);
  });

  test("'trust-until-reindex' is fresh only when both fingerprints are equal and non-null", () => {
    expect(isFresh(entry, 'trust-until-reindex', 'fp', 'fp')).toBe(true);
    expect(isFresh(entry, 'trust-until-reindex', 'fp-a', 'fp-b')).toBe(false);
    expect(isFresh(entry, 'trust-until-reindex', null, null)).toBe(false);
    expect(isFresh(entry, 'trust-until-reindex', 'fp', null)).toBe(false);
    expect(isFresh(entry, 'trust-until-reindex', null, 'fp')).toBe(false);
  });
});

// ---- serialize / deserialize ------------------------------------------------------------

const SAMPLE_RESOLVE: ResolveResult = {
  id: 'concept:reference',
  type: 'concept',
  path: 'concepts/reference.md',
  frontmatter: { name: 'Reference' },
  superseded_by: null,
};

const SAMPLE_BACKLINKS: BacklinkEntry[] = [
  { id: 'record:a', type: 'record', path: 'records/a.md', ref_type: 'inline', line: 12 },
];

function sampleFile(): CacheFileV1 {
  const pkg: PackageCacheV1 = {
    fingerprint: '123:456',
    resolve: { 'concept:reference': { value: SAMPLE_RESOLVE, at: 1000 } },
    backlinks: { 'concept:reference': { value: SAMPLE_BACKLINKS, at: 2000 } },
  };
  return { version: 1, packages: { '/repo': pkg } };
}

describe('serialize / deserialize', () => {
  test('round-trips a populated file', () => {
    const file = sampleFile();
    const roundTripped = deserialize(serialize(file));
    expect(roundTripped).toEqual(file);
  });

  test('round-trips the empty file', () => {
    expect(deserialize(serialize(emptyCacheFile()))).toEqual(emptyCacheFile());
  });

  test('rejects invalid JSON', () => {
    expect(deserialize('{not json')).toBeNull();
  });

  test('rejects a non-object JSON value', () => {
    expect(deserialize('42')).toBeNull();
    expect(deserialize('"hello"')).toBeNull();
    expect(deserialize('null')).toBeNull();
  });

  test('rejects a missing version', () => {
    expect(deserialize(JSON.stringify({ packages: {} }))).toBeNull();
  });

  test('rejects an unknown version', () => {
    expect(deserialize(JSON.stringify({ version: 2, packages: {} }))).toBeNull();
  });

  test('rejects a missing packages field', () => {
    expect(deserialize(JSON.stringify({ version: 1 }))).toBeNull();
  });

  test('rejects a package entry missing resolve/backlinks/fingerprint', () => {
    const bad = { version: 1, packages: { '/repo': { fingerprint: null, resolve: {} } } };
    expect(deserialize(JSON.stringify(bad))).toBeNull();
  });

  test('rejects a stored entry missing `at`', () => {
    const bad = {
      version: 1,
      packages: { '/repo': { fingerprint: null, resolve: { 'a:b': { value: {} } }, backlinks: {} } },
    };
    expect(deserialize(JSON.stringify(bad))).toBeNull();
  });

  test('rejects the whole file when just one package entry is malformed', () => {
    const file = sampleFile();
    const broken = { ...file, packages: { ...file.packages, '/other': { resolve: {}, backlinks: {} } } };
    expect(deserialize(JSON.stringify(broken))).toBeNull();
  });

  test('accepts a null fingerprint', () => {
    const file = sampleFile();
    file.packages['/repo'].fingerprint = null;
    expect(deserialize(serialize(file))?.packages['/repo'].fingerprint).toBeNull();
  });
});

// ---- PersistentCache (store.ts) ----------------------------------------------------------
//
// Fakes `CacheHost` (an in-memory `DataAdapter`-shaped stand-in — no real Obsidian `App`
// exists under `bun test`, see tests/cli.test.ts's `fakeCli` for the same pattern applied to
// `VaireCli`) and `TimerHost` (so the debounce never touches a real `window`, which doesn't
// exist in this environment either).

function fakeHost(): { host: CacheHost; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['.obsidian/plugins/vaire']);
  const adapter = {
    async exists(p: string): Promise<boolean> {
      return files.has(p) || dirs.has(p);
    },
    async read(p: string): Promise<string> {
      const v = files.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      return v;
    },
    async write(p: string, data: string): Promise<void> {
      files.set(p, data);
    },
    async mkdir(p: string): Promise<void> {
      dirs.add(p);
    },
  };
  const host = {
    app: { vault: { configDir: '.obsidian', adapter } },
    manifest: { id: 'vaire' },
  } as unknown as CacheHost;
  return { host, files };
}

function fakeTimers(): { timers: TimerHost; run: () => void } {
  let pending: (() => void) | null = null;
  const timers: TimerHost = {
    setTimeout: (cb) => {
      pending = cb;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  return {
    timers,
    run: () => {
      const cb = pending;
      pending = null;
      if (cb) cb();
    },
  };
}

describe('PersistentCache', () => {
  test('load() with no file on disk leaves the cache empty', async () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    await cache.load();
    expect(cache.getResolve('/repo', 'concept:reference')).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  test('load() discards a corrupt file and starts empty', async () => {
    const { host, files } = fakeHost();
    files.set('.obsidian/plugins/vaire/cache.json', 'not json at all');
    const cache = new PersistentCache(host, fakeTimers().timers);
    await cache.load();
    expect(cache.stats().entries).toBe(0);
  });

  test('set/get resolve and backlinks round-trip in memory', () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.setResolve('/repo', 'concept:reference', SAMPLE_RESOLVE);
    cache.setBacklinks('/repo', 'concept:reference', SAMPLE_BACKLINKS);
    expect(cache.getResolve('/repo', 'concept:reference')?.value).toEqual(SAMPLE_RESOLVE);
    expect(cache.getBacklinks('/repo', 'concept:reference')?.value).toEqual(SAMPLE_BACKLINKS);
    expect(cache.stats().entries).toBe(2);
  });

  test('dropPackage clears everything for that root only', () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.setResolve('/repo-a', 'concept:x', SAMPLE_RESOLVE);
    cache.setResolve('/repo-b', 'concept:y', SAMPLE_RESOLVE);
    cache.setFingerprint('/repo-a', 'fp-a');
    cache.dropPackage('/repo-a');
    expect(cache.getResolve('/repo-a', 'concept:x')).toBeUndefined();
    expect(cache.getFingerprint('/repo-a')).toBeNull();
    expect(cache.getResolve('/repo-b', 'concept:y')?.value).toEqual(SAMPLE_RESOLVE);
  });

  test('reindexed drops the package and records the given fingerprint function\'s result', () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.setResolve('/no/such/package', 'concept:x', SAMPLE_RESOLVE);
    cache.reindexed('/no/such/package');
    expect(cache.getResolve('/no/such/package', 'concept:x')).toBeUndefined();
    // A directory that doesn't exist fingerprints to null (see tests/cache.integration.test.ts
    // for a real, existing package root).
    expect(cache.getFingerprint('/no/such/package')).toBeNull();
  });

  test('dropResolve removes just that one entry', () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.setResolve('/repo', 'a:1', SAMPLE_RESOLVE);
    cache.setResolve('/repo', 'a:2', SAMPLE_RESOLVE);
    cache.dropResolve('/repo', 'a:1');
    expect(cache.getResolve('/repo', 'a:1')).toBeUndefined();
    expect(cache.getResolve('/repo', 'a:2')).toBeDefined();
  });

  test('hits/misses/revalidations are counted', () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.recordHit();
    cache.recordHit();
    cache.recordMiss();
    cache.recordRevalidation();
    expect(cache.stats()).toEqual({ hits: 2, misses: 1, revalidations: 1, entries: 0 });
  });

  test('a write debounces: nothing is saved until the timer fires', async () => {
    const { host, files } = fakeHost();
    const { timers, run } = fakeTimers();
    const cache = new PersistentCache(host, timers);
    cache.setResolve('/repo', 'concept:reference', SAMPLE_RESOLVE);
    expect(files.has('.obsidian/plugins/vaire/cache.json')).toBe(false);
    run();
    // flush() is async (adapter calls); let its microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(files.has('.obsidian/plugins/vaire/cache.json')).toBe(true);
  });

  test('flush() writes immediately and cancels the pending timer', async () => {
    const { host, files } = fakeHost();
    const { timers } = fakeTimers();
    const cache = new PersistentCache(host, timers);
    cache.setResolve('/repo', 'concept:reference', SAMPLE_RESOLVE);
    await cache.flush();
    const written = files.get('.obsidian/plugins/vaire/cache.json');
    expect(written).toBeDefined();
    expect(deserialize(written!)?.packages['/repo'].resolve['concept:reference'].value).toEqual(SAMPLE_RESOLVE);
  });

  test('flush() is a no-op when nothing changed', async () => {
    const { host, files } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    await cache.flush();
    expect(files.has('.obsidian/plugins/vaire/cache.json')).toBe(false);
  });

  test('a saved cache reloads with the same data', async () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    cache.setResolve('/repo', 'concept:reference', SAMPLE_RESOLVE);
    cache.setFingerprint('/repo', 'fp-1');
    await cache.flush();

    const reloaded = new PersistentCache(host, fakeTimers().timers);
    await reloaded.load();
    expect(reloaded.getResolve('/repo', 'concept:reference')?.value).toEqual(SAMPLE_RESOLVE);
    expect(reloaded.getFingerprint('/repo')).toBe('fp-1');
  });

  test('eviction keeps the cache at or under the 20,000-entry cap', async () => {
    const { host } = fakeHost();
    const cache = new PersistentCache(host, fakeTimers().timers);
    // Cheap enough to actually run at this size; each entry gets a distinct `at` via a manual
    // clock so eviction order is deterministic without depending on wall-clock timing.
    const originalNow = Date.now;
    let clock = 0;
    Date.now = () => ++clock;
    try {
      for (let i = 0; i < 20_050; i++) {
        cache.setResolve('/repo', `concept:${i}`, SAMPLE_RESOLVE);
      }
    } finally {
      Date.now = originalNow;
    }
    await cache.flush();
    const stats = cache.stats();
    expect(stats.entries).toBeLessThanOrEqual(20_000);
    // The most recently written entries survive; the earliest ones are gone.
    expect(cache.getResolve('/repo', 'concept:20049')).toBeDefined();
    expect(cache.getResolve('/repo', 'concept:0')).toBeUndefined();
  });
});
