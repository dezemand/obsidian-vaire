// The on-disk resolve/backlinks cache backing `persistentCache` (see src/cache/pure.ts for the
// shapes and freshness rule, src/cache/query.ts for the mode-dispatch that reads/writes this
// through `VairePlugin.cache`). Saved as JSON at
// `<vault>/.obsidian/plugins/<id>/cache.json` via `app.vault.adapter.read`/`write` — deliberately
// *not* `loadData`/`saveData`, which hold `data.json` (plugin settings): this file can grow to
// thousands of entries and gets rewritten on a 2s debounce, which isn't something settings
// should be coupled to.
//
// Lifecycle: `VairePlugin.onload` constructs one instance and kicks off `load()` without
// awaiting it (this plugin never blocks `onload` on I/O — see DESIGN.md "On load"); callers
// that need the loaded state (`src/cache/query.ts`) `await plugin.cacheReady` first, which is
// that same `load()` promise. `onunload` calls `flush()` so a pending debounced write isn't
// lost when the plugin (or Obsidian) closes.
//
// No 'obsidian' *value* import here (only `import type`, erased at compile time) — same
// discipline as src/cli.ts — so this class can be unit-tested with a fake `CacheHost` and a
// fake `TimerHost` instead of a real Obsidian `App`/`window`, same reasoning as `VaireCli`'s
// injectable `ExecFn`. See tests/cache.test.ts.

import type { App, Plugin } from 'obsidian';
import { deserialize, emptyCacheFile, evict, serialize, type CacheFileV1, type EvictCandidate, type StoredEntry } from './pure';
import { fingerprint } from './fingerprint';
import type { BacklinkEntry, ResolveResult } from '../types';

const MAX_ENTRIES = 20_000;
const SAVE_DEBOUNCE_MS = 2_000;

export interface CacheStats {
  hits: number;
  misses: number;
  revalidations: number;
  entries: number;
}

/** The bit of `VairePlugin` this module actually needs — kept narrow so `store.ts` doesn't
 *  have to import (and doesn't risk circularly depending on) `main.ts`. */
export interface CacheHost {
  app: App;
  manifest: Plugin['manifest'];
}

/** Just enough of `window.setTimeout`/`window.clearTimeout` to debounce saves — injectable so
 *  tests never have to touch a real `window` (bun's test runner has none; see the module
 *  comment above and tests/cache.test.ts). Defaults to the real thing. */
export interface TimerHost {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const realTimers: TimerHost = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export class PersistentCache {
  private readonly host: CacheHost;
  private readonly timers: TimerHost;
  private data: CacheFileV1 = emptyCacheFile();
  private dirty = false;
  private saveTimer: number | null = null;

  private hits = 0;
  private misses = 0;
  private revalidations = 0;

  constructor(host: CacheHost, timers: TimerHost = realTimers) {
    this.host = host;
    this.timers = timers;
  }

  private get dir(): string {
    return `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}`;
  }

  private get filePath(): string {
    return `${this.dir}/cache.json`;
  }

  /** Reads and validates the cache file, if any. Never throws — a missing, unreadable or
   *  corrupt/unknown-version file (see `deserialize`) just leaves the cache empty, same as a
   *  first run. Safe to call once at startup; not re-entrant-safe against concurrent `load()`s
   *  (the plugin only ever calls it once, from `onload`). */
  async load(): Promise<void> {
    try {
      const exists = await this.host.app.vault.adapter.exists(this.filePath);
      if (!exists) return;
      const text = await this.host.app.vault.adapter.read(this.filePath);
      const parsed = deserialize(text);
      if (parsed) {
        this.data = parsed;
        this.evictIfNeeded(); // in case the file predates a lower MAX_ENTRIES, or was hand-edited
      }
    } catch {
      // Corrupt/unreadable — start fresh rather than fail plugin load over a cache file.
    }
  }

  // ---- reads --------------------------------------------------------------------------

  getResolve(absRoot: string, id: string): StoredEntry<ResolveResult> | undefined {
    return this.data.packages[absRoot]?.resolve[id];
  }

  getBacklinks(absRoot: string, id: string): StoredEntry<BacklinkEntry[]> | undefined {
    return this.data.packages[absRoot]?.backlinks[id];
  }

  getFingerprint(absRoot: string): string | null {
    return this.data.packages[absRoot]?.fingerprint ?? null;
  }

  // ---- writes -------------------------------------------------------------------------

  private pkg(absRoot: string): CacheFileV1['packages'][string] {
    let p = this.data.packages[absRoot];
    if (!p) {
      p = { fingerprint: null, resolve: {}, backlinks: {} };
      this.data.packages[absRoot] = p;
    }
    return p;
  }

  setResolve(absRoot: string, id: string, value: ResolveResult): void {
    this.pkg(absRoot).resolve[id] = { value, at: Date.now() };
    this.markDirty();
  }

  dropResolve(absRoot: string, id: string): void {
    const p = this.data.packages[absRoot];
    if (!p || !(id in p.resolve)) return;
    delete p.resolve[id];
    this.markDirty();
  }

  setBacklinks(absRoot: string, id: string, value: BacklinkEntry[]): void {
    this.pkg(absRoot).backlinks[id] = { value, at: Date.now() };
    this.markDirty();
  }

  setFingerprint(absRoot: string, fp: string | null): void {
    this.pkg(absRoot).fingerprint = fp;
    this.markDirty();
  }

  /** Drops every resolve/backlinks entry (and the fingerprint) cached for `absRoot`. Used
   *  directly by a fingerprint mismatch under `trust-until-reindex` (src/cache/query.ts) and,
   *  via `reindexed`, by the `'index-rebuilt'` event. */
  dropPackage(absRoot: string): void {
    if (!(absRoot in this.data.packages)) return;
    delete this.data.packages[absRoot];
    this.markDirty();
  }

  /** `'index-rebuilt'` for `absRoot`: its index just changed, so every entry cached for it is
   *  presumed stale — drop them and record the fingerprint that now matches what's on disk, so
   *  the very next `trust-until-reindex` lookup doesn't immediately see another "mismatch" and
   *  drop again for no reason. A no-op read-wise for `stale-while-revalidate`/`off`, which
   *  don't consult the fingerprint, but harmless (and arguably correct — the old entries *are*
   *  stale) to drop for them too. */
  reindexed(absRoot: string): void {
    this.dropPackage(absRoot);
    this.setFingerprint(absRoot, fingerprint(absRoot));
  }

  // ---- stats (status bar) --------------------------------------------------------------

  recordHit(): void {
    this.hits++;
  }

  recordMiss(): void {
    this.misses++;
  }

  recordRevalidation(): void {
    this.revalidations++;
  }

  stats(): CacheStats {
    let entries = 0;
    for (const p of Object.values(this.data.packages)) {
      entries += Object.keys(p.resolve).length + Object.keys(p.backlinks).length;
    }
    return { hits: this.hits, misses: this.misses, revalidations: this.revalidations, entries };
  }

  // ---- eviction + persistence -----------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
    this.scheduleSave();
  }

  private evictIfNeeded(): void {
    const candidates: EvictCandidate[] = [];
    for (const [absRoot, p] of Object.entries(this.data.packages)) {
      for (const [id, entry] of Object.entries(p.resolve)) candidates.push({ absRoot, kind: 'resolve', id, at: entry.at });
      for (const [id, entry] of Object.entries(p.backlinks)) candidates.push({ absRoot, kind: 'backlinks', id, at: entry.at });
    }
    if (candidates.length <= MAX_ENTRIES) return;

    const kept = new Set(evict(candidates, MAX_ENTRIES).map(candidateKey));
    for (const [absRoot, p] of Object.entries(this.data.packages)) {
      for (const id of Object.keys(p.resolve)) {
        if (!kept.has(candidateKey({ absRoot, kind: 'resolve', id, at: 0 }))) delete p.resolve[id];
      }
      for (const id of Object.keys(p.backlinks)) {
        if (!kept.has(candidateKey({ absRoot, kind: 'backlinks', id, at: 0 }))) delete p.backlinks[id];
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Writes the cache to disk now (canceling any pending debounced write), if it's actually
   *  dirty. Called on the debounce timer and once more, directly, from `onunload`. A write
   *  failure is swallowed but leaves `dirty` set, so a later `markDirty()` (or another explicit
   *  `flush()`) will retry — there's no reason a transient adapter error should crash the
   *  plugin over a cache write. */
  async flush(): Promise<void> {
    if (this.saveTimer != null) {
      this.timers.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.evictIfNeeded();
    this.dirty = false;
    try {
      if (!(await this.host.app.vault.adapter.exists(this.dir))) {
        await this.host.app.vault.adapter.mkdir(this.dir);
      }
      await this.host.app.vault.adapter.write(this.filePath, serialize(this.data));
    } catch {
      this.dirty = true;
    }
  }
}

// `String.fromCharCode(0)` rather than a ` NUL ` escape spelled out in this file — same
// separator-safety reasoning as `resolveMemoKey` (cli.ts), but built this way so there's no
// risk of a tool/editor round-trip leaving a literal control byte sitting in the source file.
const KEY_SEP = String.fromCharCode(0);

function candidateKey(c: EvictCandidate): string {
  return [c.absRoot, c.kind, c.id].join(KEY_SEP);
}
