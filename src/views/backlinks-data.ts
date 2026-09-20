// Shared backlink-context loader for the node panel's Backlinks ← section and the dedicated
// Vairë backlinks view. See BRANCHES.md "feat/backlinks-context".
//
// For every backlink row, reads the referencing file *once per (package, path)* — a vault file
// via `vault.cachedRead`, a dependency file by locating its root the same way `external-catalog
// .ts` resolves an `@pkg/...` reference's target, then `fs.readFileSync` — and turns the row's
// 1-based `line` into a `LineSnippet` via `snippetForLine` (src/views/pure-backlinks.ts). Results
// are memoized per `repo id` for 30s and dropped on `index-rebuilt`.
//
// `perf/disk-cache`: the underlying `cli.backlinks` call itself (the id list, not this module's
// enriched contexts) goes through `cachedBacklinks` (src/cache/query.ts), which persists that
// list to disk per `settings.persistentCache` — see DESIGN.md's disk-cache trade-off note. This
// module's own 30s in-memory cache sits on top unchanged; it's what both `node-view.ts` and
// `backlinks-view.ts` actually call.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TFile } from 'obsidian';
import { basenameNoExt } from '../render/pure';
import { cachedBacklinks } from '../cache/query';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import type { BacklinkEntry, ResolveResult } from '../types';
import { resolveDependencyRoot } from './external-catalog';
import { snippetForLine, type BacklinkContext } from './pure-backlinks';
import { vaultPathFor } from './pure-pkg';

export type { BacklinkContext } from './pure-backlinks';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expires: number;
  promise: Promise<BacklinkContext[]>;
}

const cache = new Map<string, CacheEntry>();

/** Drops every cached entry for `repo` (or, with no argument, every entry — used by tests). */
export function clearBacklinkContextCache(repo?: string): void {
  if (!repo) {
    cache.clear();
    return;
  }
  const prefix = `${repo} `;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Registers the `index-rebuilt` listener that drops this module's cache for the rebuilt package. */
export function registerBacklinkContextCache(plugin: VairePlugin): void {
  plugin.registerEvent(
    plugin.events.on('index-rebuilt', (root) => {
      if (typeof root === 'string') clearBacklinkContextCache(root);
    }),
  );
}

/**
 * Backlinks for `node` (in `pkg`), each enriched with the referencing line's snippet and the
 * referencing node's display name. Memoized per `pkg.absRoot + node.full` for `CACHE_TTL_MS`.
 */
export function loadBacklinkContexts(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): Promise<BacklinkContext[]> {
  const key = `${pkg.absRoot} ${node.full}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.promise;

  const promise = loadFresh(plugin, pkg, node);
  cache.set(key, { expires: now + CACHE_TTL_MS, promise });
  // A failed load shouldn't be remembered for the full TTL — let the next call retry.
  promise.catch(() => cache.delete(key));
  return promise;
}

interface RowGroup {
  package?: string;
  path: string;
  rows: BacklinkEntry[];
}

function groupByFile(rows: BacklinkEntry[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const key = `${row.package ?? ''}\u0000${row.path}`;
    let group = groups.get(key);
    if (!group) {
      group = { package: row.package, path: row.path, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

async function loadFresh(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): Promise<BacklinkContext[]> {
  // perf/disk-cache: goes through the on-disk cache per `settings.persistentCache` (src/cache/
  // query.ts) instead of a bare `cli.backlinks` — see DESIGN.md's disk-cache trade-off note.
  const backlinks = await cachedBacklinks(plugin, pkg.absRoot, node.full);
  const groups = groupByFile(backlinks);

  const contexts: BacklinkContext[] = [];
  for (const group of groups) {
    const depRoot = group.package ? await resolveDependencyRoot(plugin, group.package, pkg.absRoot) : null;
    const lines = await readGroupLines(plugin, pkg, group, depRoot);
    for (const row of group.rows) {
      const name = await nameForRow(plugin, pkg, group, row, depRoot);
      const lineText = lines && row.line >= 1 && row.line <= lines.length ? lines[row.line - 1] : null;
      const snippet = lineText != null ? snippetForLine(lineText, node.full) : null;
      contexts.push({
        id: row.id,
        type: row.type,
        path: row.path,
        package: row.package,
        ref_type: row.ref_type,
        line: row.line,
        name,
        snippet,
      });
    }
  }
  return contexts;
}

async function readGroupLines(
  plugin: VairePlugin,
  pkg: PackageInfo,
  group: RowGroup,
  depRoot: string | null,
): Promise<string[] | null> {
  if (!group.package) {
    const file = plugin.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, group.path));
    if (!(file instanceof TFile)) return null;
    try {
      return (await plugin.app.vault.cachedRead(file)).split('\n');
    } catch {
      return null;
    }
  }
  if (!depRoot) return null;
  try {
    return fs.readFileSync(path.join(depRoot, group.path), 'utf8').split('\n');
  } catch {
    return null;
  }
}

function nameFromResolve(result: ResolveResult | null, fallbackId: string): string {
  const fmName = result?.frontmatter.name;
  if (typeof fmName === 'string' && fmName.trim()) return fmName.trim();
  if (result) {
    const base = basenameNoExt(result.path);
    if (base) return base;
  }
  return fallbackId;
}

async function nameForRow(
  plugin: VairePlugin,
  pkg: PackageInfo,
  group: RowGroup,
  row: BacklinkEntry,
  depRoot: string | null,
): Promise<string> {
  if (!group.package) return pkg.index.get(row.id)?.name ?? row.id;
  if (!depRoot) return row.id;
  try {
    const result = await plugin.resolveViaCli(depRoot, row.id);
    return nameFromResolve(result, row.id);
  } catch {
    return row.id;
  }
}
