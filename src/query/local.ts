// Local evaluator for `vaire` query blocks: answers entirely from `LocalIndex` + Obsidian's
// metadata cache, vault packages only. See DESIGN.md's task brief for the local/cli/auto
// trade-off and src/query/pure.ts for the clause-matching/sorting logic this calls into.

import type { App } from 'obsidian';
import { extractFrontmatterEdges, parseRef, type IdRef } from '../ids';
import type { LocalNode, PackageInfo } from '../packages';
import { finalizeResults, resolveTargetRef, type ParsedQuery, type QueryNode } from './pure';

function toQueryNode(node: LocalNode): QueryNode {
  const ref: IdRef = {
    kind: 'id',
    type: node.type,
    id: node.id,
    scope: node.scope,
    full: node.full,
    local: node.full,
  };
  return { ref, name: node.name, frontmatter: node.frontmatter };
}

function proseLinkTargetsOf(app: App, node: LocalNode): string[] {
  return (app.metadataCache.getFileCache(node.file)?.links ?? []).map((l) => l.link);
}

/** Every local node with a frontmatter edge or prose link pointing at `targetFull`. */
function backlinksLocal(app: App, pkg: PackageInfo, targetFull: string): LocalNode[] {
  const hits: LocalNode[] = [];
  for (const node of pkg.index.all()) {
    const inFrontmatter = extractFrontmatterEdges(node.frontmatter).some((edge) =>
      edge.values.some((v) => v.kind === 'id' && v.full === targetFull),
    );
    const inProse =
      !inFrontmatter &&
      proseLinkTargetsOf(app, node).some((link) => {
        const ref = parseRef(link);
        return ref?.kind === 'id' && ref.full === targetFull;
      });
    if (inFrontmatter || inProse) hits.push(node);
  }
  return hits;
}

/** Every local node `sourceFull` points at (frontmatter edges + prose links), deduped. */
function refsFromLocal(app: App, pkg: PackageInfo, sourceFull: string): LocalNode[] {
  const source = pkg.index.get(sourceFull);
  if (!source) return [];
  const seen = new Set<string>();
  const hits: LocalNode[] = [];
  const add = (full: string): void => {
    if (seen.has(full)) return;
    seen.add(full);
    const target = pkg.index.get(full);
    if (target) hits.push(target);
  };
  for (const edge of extractFrontmatterEdges(source.frontmatter)) {
    for (const v of edge.values) if (v.kind === 'id') add(v.full);
  }
  for (const link of proseLinkTargetsOf(app, source)) {
    const ref = parseRef(link);
    if (ref?.kind === 'id') add(ref.full);
  }
  return hits;
}

/**
 * Evaluates `query` entirely from `pkg`'s `LocalIndex` and Obsidian's metadata cache — instant,
 * re-renders on every metadata change, vault packages only (per DESIGN.md's trade-off). `search`
 * is a substring match over name/aliases only (no body text is cached locally — that's what the
 * `cli` source's real hybrid search is for). `unresolved` can't be answered locally (loose ends
 * aren't nodes in the index) and always yields no matches; use `source: cli`/`auto` for that
 * clause. `thisFull` is the full id of the node the block is written in (when that file is
 * itself a node), used to resolve a `this` value in `backlinks-to`/`refs-from`.
 */
export function evaluateLocal(
  app: App,
  pkg: PackageInfo,
  query: ParsedQuery,
  thisFull: string | undefined,
): QueryNode[] {
  let candidates: LocalNode[];

  if (query.backlinksTo) {
    const target = resolveTargetRef(query.backlinksTo, thisFull);
    candidates = target ? backlinksLocal(app, pkg, target) : [];
  } else if (query.refsFrom) {
    const target = resolveTargetRef(query.refsFrom, thisFull);
    candidates = target ? refsFromLocal(app, pkg, target) : [];
  } else if (query.unresolved) {
    candidates = [];
  } else {
    candidates = query.type ? (pkg.index.byType().get(query.type) ?? []) : pkg.index.all();
  }

  if (query.search) {
    const needle = query.search.toLowerCase();
    candidates = candidates.filter(
      (n) => n.name.toLowerCase().includes(needle) || n.aliases.some((a) => a.toLowerCase().includes(needle)),
    );
  }

  return finalizeResults(candidates.map(toQueryNode), query);
}
