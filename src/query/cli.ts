// CLI evaluator for `vaire` query blocks: `backlinks-to` via `cli.backlinks`, `refs-from` via
// `cli.refs`, `search` via `cli.search` (real ranked hybrid search, includes dependencies),
// `unresolved` via `cli.unresolved` — then filtered/sorted locally (src/query/pure.ts).
// Re-renders on `index-rebuilt` only (see src/query/index.ts). See DESIGN.md's task brief for
// the local/cli/auto trade-off.

import { parseRef, type IdRef, type LooseRef } from '../ids';
import type { PackageInfo } from '../packages';
import type { LooseEndItem } from '../types';
import type VairePlugin from '../main';
import { finalizeResults, resolveTargetRef, type ParsedQuery, type QueryNode } from './pure';

interface IdLike {
  id: string;
  type: string;
  package?: string;
}

/**
 * Builds the `IdRef` a CLI result entry addresses. vaire 0.3.2 already returns dependency hits
 * with an `@pkg/`-prefixed `id` (verified for `backlinks`, `refs`, `search`, `suggest`) plus a
 * `package` field; the re-stamp below only applies if a result ever carries `package` with an
 * unprefixed id, so both shapes resolve to the same full address.
 */
function buildRef(entry: IdLike): IdRef | null {
  const parsed = parseRef(entry.id);
  if (!parsed || parsed.kind !== 'id') return null;
  if (entry.package && !parsed.pkg) {
    const full = `@${entry.package}/${parsed.local}`;
    return { ...parsed, pkg: entry.package, full };
  }
  return parsed;
}

/**
 * Turns CLI result entries into `QueryNode`s, fetching each one's frontmatter via
 * `plugin.resolveViaCli` (memoized — see `resolveMemoKey`, src/cli.ts) so `where:`/`sort:`/
 * `columns:` have data to work with, exactly like every other CLI-backed reference in this
 * plugin. A hydration failure leaves that row's frontmatter empty rather than dropping the
 * row — its name/type link still renders correctly via `createRefElement`'s own resolution.
 */
async function hydrate(plugin: VairePlugin, repo: string, entries: IdLike[]): Promise<QueryNode[]> {
  const nodes = await Promise.all(
    entries.map(async (entry): Promise<QueryNode | null> => {
      const ref = buildRef(entry);
      if (!ref) return null;
      let frontmatter: Record<string, unknown> = {};
      try {
        const resolved = await plugin.resolveViaCli(repo, ref.full);
        if (resolved) frontmatter = resolved.frontmatter ?? {};
      } catch {
        // leave frontmatter empty; the row still renders.
      }
      const fmName = frontmatter.name;
      const name = typeof fmName === 'string' && fmName.trim() ? fmName.trim() : entry.id;
      return { ref, name, frontmatter };
    }),
  );
  return nodes.filter((n): n is QueryNode => n !== null);
}

function looseNode(item: LooseEndItem): QueryNode {
  const ref: LooseRef = {
    kind: 'loose',
    typeHint: item.type_guess ?? undefined,
    descriptor: item.descriptor,
    raw: `?${item.type_guess ?? ''}: ${item.descriptor}`,
  };
  return { ref, name: item.descriptor, frontmatter: {} };
}

/**
 * Evaluates `query` via the `vaire` CLI: `backlinks-to`/`refs-from`/`search`/`unresolved` each
 * drive one CLI call (checked in that order — a block combining more than one of these clauses
 * uses whichever comes first, per DESIGN.md's "clauses combine with AND" over the *result set*
 * of the first structural clause found), then `type`/`where`/`sort`/`limit` are applied locally
 * via `finalizeResults`. A block with none of those clauses (a pure type/where/sort query
 * explicitly pinned to `source: cli`) has no CLI call that answers it — there is no "list every
 * node" command (see DESIGN.md's CLI adapter surface) — so it falls back to the same
 * `LocalIndex` scan the `local` source would use; the footer still reports `cli` because that
 * is what the block asked for.
 */
export async function evaluateCli(
  plugin: VairePlugin,
  pkg: PackageInfo,
  query: ParsedQuery,
  thisFull: string | undefined,
): Promise<QueryNode[]> {
  let candidates: QueryNode[];

  if (query.backlinksTo) {
    const target = resolveTargetRef(query.backlinksTo, thisFull);
    if (!target) return [];
    const result = await plugin.cli.backlinks(pkg.absRoot, target, { type: query.type, limit: query.limit });
    candidates = await hydrate(plugin, pkg.absRoot, result.backlinks);
  } else if (query.refsFrom) {
    const target = resolveTargetRef(query.refsFrom, thisFull);
    if (!target) return [];
    const result = await plugin.cli.refs(pkg.absRoot, target, 1);
    candidates = await hydrate(plugin, pkg.absRoot, result.refs);
  } else if (query.unresolved) {
    const result = await plugin.cli.unresolved(pkg.absRoot);
    candidates = result.unresolved.map(looseNode);
  } else if (query.search) {
    const result = await plugin.cli.search(pkg.absRoot, query.search, { type: query.type, limit: query.limit ?? 50 });
    candidates = await hydrate(plugin, pkg.absRoot, result.results);
  } else {
    candidates = pkg.index.all().map((n) => ({
      ref: { kind: 'id', type: n.type, id: n.id, scope: n.scope, full: n.full, local: n.full } as IdRef,
      name: n.name,
      frontmatter: n.frontmatter,
    }));
  }

  return finalizeResults(candidates, query);
}
