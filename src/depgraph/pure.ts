// Pure model for the dependency graph view. No `obsidian` import (same convention as
// src/graph/model.ts and src/health/pure.ts) so this stays unit-testable with plain `bun
// test` against a real `deps` JSON fixture (tests/fixtures/deps-acme-platform.json). See
// DESIGN.md's dependency graph feature brief and "§3 Dependencies" / "CLI contract nuances".
//
// Two views of the same `deps` tree:
// - `buildDepGraph`: the deduplicated closure (one node per package name, however many parents
//   declare it) — feeds the "graph" (force-layout canvas) and the side panel.
// - `buildDepOutline`: the tree exactly as the CLI nested it, except a package name already
//   shown once (anywhere earlier in the depth-first walk, including the root itself) collapses
//   into a "see above" leaf instead of re-expanding — feeds the "tree" (indented outline).

import { depRowState, type DepRow } from '../deps';
import type { DepNode, DepsResult } from '../types';

export type DepGraphState = 'ok' | 'unlinked' | 'mismatch' | 'error' | 'cycle';

export type ResolvedFrom = 'working copy' | 'linked checkout' | 'store' | 'unresolved';

/** Classifies an absolute dependency root: a vault package's own working copy, somewhere
 *  under `storeDir` (a plain `vaire pull`ed release), any other linked checkout, or
 *  `'unresolved'` when there is no absolute root at all (unlinked / not found). Pure path
 *  comparison only — no `fs` access, so this never needs to be async or handle a missing
 *  directory. */
export function resolvedFromOf(absPath: string | undefined, vaultRoots: string[], storeDir: string): ResolvedFrom {
  if (!absPath) return 'unresolved';
  const normalized = normalizePath(absPath);
  if (vaultRoots.some((root) => normalizePath(root) === normalized)) return 'working copy';
  const store = normalizePath(storeDir);
  if (normalized === store || normalized.startsWith(`${store}/`)) return 'store';
  return 'linked checkout';
}

/** Normalizes a filesystem path for comparison without pulling in `node:path` (this module
 *  otherwise has zero imports beyond `../deps`/`../types`, keeping it trivially portable):
 *  collapses `//`, drops a single trailing slash. Good enough for the absolute, already-joined
 *  paths this module only ever compares (see `deps.ts`'s `flattenDeps`, which produces them the
 *  same way `buildDepGraph` below does). */
function normalizePath(p: string): string {
  const collapsed = p.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/** Joins a `deps` node's `resolved` (relative to the run root) onto the absolute run root,
 *  mirroring `flattenDeps`'s `absRoot` derivation exactly (see deps.ts) without needing
 *  `node:path`'s platform-aware join — every `resolved` value the CLI emits is already a plain
 *  POSIX-style relative path (`../../../.vaire/store/...`, `.`), so simple segment resolution
 *  is sufficient and keeps this module free of Node built-ins. */
function joinResolved(rootAbs: string, resolved: string): string {
  const base = normalizePath(rootAbs).split('/');
  for (const seg of resolved.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return base.join('/') || '/';
}

const STATE_PRIORITY: DepGraphState[] = ['error', 'mismatch', 'unlinked', 'cycle', 'ok'];

function mergeState(a: DepGraphState, b: DepGraphState): DepGraphState {
  return STATE_PRIORITY.indexOf(a) <= STATE_PRIORITY.indexOf(b) ? a : b;
}

/** One `deps` occurrence's state: the usual ok/unlinked/mismatch/error classification
 *  (`depRowState`, src/deps.ts — the single source of truth shared with the flat dependency
 *  table), promoted to `'cycle'` when the CLI marked this occurrence as re-entering a package
 *  already on the current path. */
function occurrenceState(dep: DepNode): DepGraphState {
  const row: DepRow = {
    name: dep.name,
    constraint: dep.constraint,
    version: dep.version,
    resolved: dep.resolved,
    satisfied: dep.satisfied ?? false,
    note: dep.note,
    depth: 0,
    parent: '',
  };
  const base = depRowState(row);
  return dep.cycle ? 'cycle' : base;
}

export interface DepGraphParent {
  name: string;
  constraint: string;
}

export interface DepGraphNode {
  name: string;
  /** Every distinct resolved version seen across occurrences, in first-seen order. More than
   *  one entry is a version conflict — see `conflicts()`. */
  versions: string[];
  /** Every distinct declared constraint seen across occurrences, in first-seen order. */
  constraints: string[];
  resolvedFrom: ResolvedFrom;
  state: DepGraphState;
  /** True if this package is declared directly by the run root (depth 1) — the only
   *  dependencies `vaire add`/`vaire pull` can act on from here (DESIGN.md "CLI contract
   *  nuances": "the CLI only links into the run root"). */
  direct: boolean;
  /** Every declaring parent (package name + the constraint *that parent* declared), deduped. */
  parents: DepGraphParent[];
  /** Absolute root, if any occurrence resolved to one (first-seen). */
  absRoot?: string;
  /** Every distinct `note` seen across occurrences (dependency errors, version mismatches). */
  notes: string[];
}

export interface DepGraphEdge {
  /** Declaring package's name (the run root's own name for a direct dependency). */
  source: string;
  /** Dependency's name. */
  target: string;
}

export interface DepGraphResult {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
}

export interface BuildDepGraphOptions {
  /** The run root's own package name (`deps.name`) — the synthetic source of every direct
   *  dependency's edge. */
  rootName: string;
  /** The run root's absolute path — `resolved` fields are relative to this, regardless of
   *  nesting depth (see `flattenDeps`'s doc comment, deps.ts). */
  rootAbs: string;
  /** Absolute roots of every package open in this vault — feeds `resolvedFromOf`. */
  vaultRoots: string[];
  /** Absolute path of `~/.vaire/store` — feeds `resolvedFromOf`. */
  storeDir: string;
}

/**
 * Builds the deduplicated dependency closure: one node per package name (however many parents
 * declare it, or however many times the raw tree repeats it), with a directed edge for every
 * distinct declaring relationship. Every occurrence in the raw tree is visited (its state is
 * merged into the shared node — see `mergeState` — even where it's buried behind a diamond the
 * closure also reaches some other, shorter way), *except* that a `cycle: true` occurrence is
 * never descended into — the CLI itself omits `dependencies` there, and doing so is what stops
 * the walk from re-entering a real cycle. `depsResult` is already a finite, fully materialized
 * JSON tree (not a lazy/live structure), so a plain depth-first walk over it always terminates
 * on its own; the `cycle` guard exists to match the CLI's own recursion boundary, not because
 * termination would otherwise be at risk.
 */
export function buildDepGraph(depsResult: DepsResult, opts: BuildDepGraphOptions): DepGraphResult {
  const byName = new Map<string, DepGraphNode>();
  const edgeKeys = new Set<string>();
  const edges: DepGraphEdge[] = [];

  function addEdge(source: string, target: string): void {
    const key = `${source}\u0000${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target });
  }

  function addParent(node: DepGraphNode, parent: DepGraphParent): void {
    if (!node.parents.some((p) => p.name === parent.name && p.constraint === parent.constraint)) {
      node.parents.push(parent);
    }
  }

  function walk(nodes: DepNode[] | undefined, parentName: string, depth: number): void {
    if (!nodes) return;
    for (const dep of nodes) {
      const absRoot = dep.resolved ? joinResolved(opts.rootAbs, dep.resolved) : undefined;
      const state = occurrenceState(dep);
      addEdge(parentName, dep.name);

      let node = byName.get(dep.name);
      if (!node) {
        node = {
          name: dep.name,
          versions: [],
          constraints: [],
          resolvedFrom: resolvedFromOf(absRoot, opts.vaultRoots, opts.storeDir),
          state,
          direct: depth === 1,
          parents: [],
          absRoot,
          notes: [],
        };
        byName.set(dep.name, node);
      } else {
        node.direct = node.direct || depth === 1;
        node.state = mergeState(node.state, state);
        if (absRoot && !node.absRoot) node.absRoot = absRoot;
      }
      if (dep.version && !node.versions.includes(dep.version)) node.versions.push(dep.version);
      if (!node.constraints.includes(dep.constraint)) node.constraints.push(dep.constraint);
      if (dep.note && !node.notes.includes(dep.note)) node.notes.push(dep.note);
      addParent(node, { name: parentName, constraint: dep.constraint });

      if (!dep.cycle) walk(dep.dependencies, dep.name, depth + 1);
    }
  }

  walk(depsResult.dependencies, opts.rootName, 1);
  return { nodes: [...byName.values()], edges };
}

/** Nodes with more than one distinct resolved version across occurrences — the same
 *  dependency name resolved to different versions somewhere in the closure. */
export function conflicts(nodes: DepGraphNode[]): DepGraphNode[] {
  return nodes.filter((n) => n.versions.length > 1);
}

// ---- Tree outline (mirrors the CLI's raw nesting) ------------------------------------------

export interface DepOutlineNode {
  name: string;
  constraint: string;
  version?: string;
  resolvedFrom: ResolvedFrom;
  state: DepGraphState;
  note?: string;
  absRoot?: string;
  direct: boolean;
  /** True when this package name was already shown once earlier in the outline (including
   *  being the run root itself) — rendered as a collapsed "see above" leaf instead of
   *  re-expanding, per DESIGN.md's tree-layout brief. Always has no `children` when true. */
  seeAbove: boolean;
  children: DepOutlineNode[];
}

/**
 * Builds the indented outline exactly as the CLI nested the tree, except a package name
 * already shown once earlier in the depth-first walk (anywhere — not just on the current
 * path, unlike the CLI's own `cycle` flag, which only fires for a true ancestor cycle) collapses
 * to a childless `seeAbove` leaf. This is a stricter, UI-driven dedup than the CLI's: a diamond
 * dependency reached twice from unrelated branches (e.g. `acme-security` under both the run root
 * and `acme-vision`) is fully expanded the first time and collapsed the second,
 * even though neither occurrence is a `cycle` per the CLI — scannability, not correctness, is
 * the goal (DESIGN.md: "repeated subtrees shown collapsed with a 'see above' link").
 */
export function buildDepOutline(depsResult: DepsResult, opts: BuildDepGraphOptions): DepOutlineNode[] {
  const seen = new Set<string>([opts.rootName]);

  function walk(nodes: DepNode[] | undefined, depth: number): DepOutlineNode[] {
    if (!nodes) return [];
    return nodes.map((dep) => {
      const absRoot = dep.resolved ? joinResolved(opts.rootAbs, dep.resolved) : undefined;
      const alreadySeen = seen.has(dep.name);
      const seeAbove = alreadySeen || !!dep.cycle;
      if (!alreadySeen) seen.add(dep.name);

      return {
        name: dep.name,
        constraint: dep.constraint,
        version: dep.version,
        resolvedFrom: resolvedFromOf(absRoot, opts.vaultRoots, opts.storeDir),
        state: occurrenceState(dep),
        note: dep.note,
        absRoot,
        direct: depth === 1,
        seeAbove,
        children: seeAbove ? [] : walk(dep.dependencies, depth + 1),
      };
    });
  }

  return walk(depsResult.dependencies, 1);
}
