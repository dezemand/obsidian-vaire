// Pure model + layout helpers for the whole-package graph view (`feat/package-graph`,
// BRANCHES.md wave 7). No `obsidian` import — mirrors src/graph/{model,layout,pure}.ts's own
// convention so this stays unit-testable in plain `bun test` (see tests/package-graph.test.ts).
//
// Unlike the local graph (src/graph/model.ts's `buildGraph`, one node's CLI-fetched
// neighborhood), the package graph draws *every* node of the active vault package and *every*
// edge between them, built entirely locally: no CLI calls, no `refs`/`backlinks` round trips.
// The edges come from the same source the reading-mode relations footer and node panel already
// use (`src/render/relations-data.ts`'s `outgoingRefs`, itself `extractFrontmatterEdges` +
// prose wikilink targets from the metadata cache) — so "every edge" here means exactly what a
// reader would see as References→ on each node's own page, just assembled package-wide instead
// of per-node.

import { familyOf } from '../theme/families';
import { outgoingRefs } from '../render/relations-data';

// ---- buildPackageGraph ---------------------------------------------------------------------

/** Structural shape of `LocalNode` (src/packages.ts) that `buildPackageGraph` needs — kept
 *  narrow (rather than importing `LocalNode` itself, which drags in `obsidian`'s `TFile`) so
 *  this module has no `obsidian` dependency. */
export interface PackageGraphNodeInput {
  /** Full local id, e.g. `type:id` or `scope/type:id` (never `@pkg/…` — these are always this
   *  package's own nodes). */
  full: string;
  type: string;
  name: string;
  frontmatter: Record<string, unknown>;
  supersededBy?: string;
}

export interface PackageGraphNode {
  /** Full address: a local node's `full`, or `@pkg/type:id` for a cross-package ghost node. */
  id: string;
  type: string;
  name: string;
  /** A cross-package dependency reference with no file in this vault — drawn distinctly
   *  (see DESIGN.md's "Show dependencies" toggle) and only present when
   *  `opts.includeDependencies` was true. */
  isGhost: boolean;
  supersededBy?: string;
}

export interface PackageGraphEdge {
  /** Source node's full address (the node the reference is written in). */
  source: string;
  /** Target node's full address (what it references). */
  target: string;
}

export interface PackageGraphModel {
  nodes: PackageGraphNode[];
  edges: PackageGraphEdge[];
}

export interface BuildPackageGraphOptions {
  /** Include cross-package (`@pkg/…`) references as ghost nodes. Default `false` — the
   *  feature's own default, per DESIGN.md's "Show dependencies" toggle. */
  includeDependencies?: boolean;
  /** Drop nodes with `supersededBy` set (and every edge touching one). Default `true` — the
   *  feature's own default ("Hide superseded"). */
  hideSuperseded?: boolean;
  /** Drop nodes with no surviving edge, evaluated *after* every other filter. Default `false`. */
  hideOrphans?: boolean;
  /** When given and non-empty, keep only nodes whose `type` is in this set (evaluated before
   *  `hideOrphans`, so a node orphaned purely by a type filter is dropped by that filter, not
   *  silently kept because "hide orphans" is off). `undefined`/empty: no type filtering. */
  types?: ReadonlySet<string>;
  /** Display name for a ghost (`@pkg/…`) node — e.g. from a sibling vault package's own
   *  `LocalIndex` if that dependency also happens to be open (same trick
   *  `src/graph/graph-view.ts`'s `namesResolver` uses). Falls back to the reference's bare
   *  local id (`ref.id`) when unset or it returns `undefined` — never a CLI call, per this
   *  module's "no CLI calls" contract. */
  resolveDependencyName?: (fullId: string) => string | undefined;
}

/**
 * Builds the deduped node/edge set for the whole-package graph from every node's frontmatter
 * plus its prose wikilink targets (the metadata cache's per-file `links`, keyed by the node's
 * *own* full id — the view builds this map from `app.metadataCache.getFileCache(file)?.links`).
 * Reuses `outgoingRefs` (src/render/relations-data.ts) node-by-node, so an edge here is exactly
 * one that would appear in that node's own "References →" section.
 *
 * A local reference (no `@pkg`) only becomes an edge when its target is itself one of `nodes` —
 * a dangling local reference is a `vaire check` `dangling_ref` finding, not something this view
 * fabricates a node for. A cross-package reference becomes a ghost node + edge only when
 * `opts.includeDependencies` is true; otherwise it is dropped entirely (neither node nor edge).
 * A self-reference (a node referencing its own address) is dropped, matching `buildGraph`'s
 * local-graph precedent (src/graph/model.ts) of never drawing a loop.
 */
export function buildPackageGraph(
  nodes: PackageGraphNodeInput[],
  linksByFile: Map<string, string[]>,
  opts: BuildPackageGraphOptions = {},
): PackageGraphModel {
  const includeDependencies = opts.includeDependencies ?? false;
  const hideSuperseded = opts.hideSuperseded ?? true;
  const hideOrphans = opts.hideOrphans ?? false;

  const localIds = new Set(nodes.map((n) => n.full));
  const nodeMap = new Map<string, PackageGraphNode>();
  for (const n of nodes) {
    nodeMap.set(n.full, { id: n.full, type: n.type, name: n.name, isGhost: false, supersededBy: n.supersededBy });
  }

  const edgeKeys = new Set<string>();
  const edges: PackageGraphEdge[] = [];
  const addEdge = (source: string, target: string): void => {
    if (source === target) return; // no self-loops
    const key = `${source}->${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target });
  };

  for (const n of nodes) {
    const proseLinks = linksByFile.get(n.full) ?? [];
    for (const ref of outgoingRefs(n.frontmatter, proseLinks)) {
      if (ref.pkg) {
        if (!includeDependencies) continue;
        if (!nodeMap.has(ref.full)) {
          nodeMap.set(ref.full, {
            id: ref.full,
            type: ref.type,
            name: opts.resolveDependencyName?.(ref.full) ?? ref.id,
            isGhost: true,
          });
        }
        addEdge(n.full, ref.full);
        continue;
      }
      if (localIds.has(ref.full)) addEdge(n.full, ref.full);
    }
  }

  let nodeList = [...nodeMap.values()];
  let edgeList = edges;

  const applyNodeFilter = (keep: (n: PackageGraphNode) => boolean): void => {
    const kept = new Set(nodeList.filter(keep).map((n) => n.id));
    nodeList = nodeList.filter((n) => kept.has(n.id));
    edgeList = edgeList.filter((e) => kept.has(e.source) && kept.has(e.target));
  };

  if (hideSuperseded) applyNodeFilter((n) => !n.supersededBy);
  if (opts.types && opts.types.size > 0) applyNodeFilter((n) => opts.types!.has(n.type));
  if (hideOrphans) {
    const deg = degrees({ nodes: nodeList, edges: edgeList });
    applyNodeFilter((n) => (deg.get(n.id) ?? 0) > 0);
  }

  return { nodes: nodeList, edges: edgeList };
}

// ---- degrees --------------------------------------------------------------------------------

/** Total degree (in + out) per node id — used for node radius (sqrt scale, see
 *  `radiusForDegree`) and lane-layout ordering within a lane. Every node in `graph.nodes` gets
 *  an entry, defaulting to 0, even if it has no edges. */
export function degrees(graph: Pick<PackageGraphModel, 'nodes' | 'edges'>): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of graph.nodes) map.set(n.id, 0);
  for (const e of graph.edges) {
    map.set(e.source, (map.get(e.source) ?? 0) + 1);
    map.set(e.target, (map.get(e.target) ?? 0) + 1);
  }
  return map;
}

/** Node radius on a sqrt scale of its degree, per DESIGN.md ("Sizes: node radius by degree
 *  (sqrt scale)") — sqrt rather than linear so a handful of hub nodes don't dwarf everything
 *  else on a package with a very high-degree node. Floored so a zero-degree (orphan, when
 *  "Hide orphans" is off) node stays visible and clickable. */
export function radiusForDegree(degree: number, opts: { min?: number; max?: number; scale?: number } = {}): number {
  const min = opts.min ?? 4;
  const max = opts.max ?? 22;
  const scale = opts.scale ?? 2.2;
  return Math.min(max, min + Math.sqrt(Math.max(0, degree)) * scale);
}

// ---- laneLayout -----------------------------------------------------------------------------

export interface LaneLayoutSize {
  width: number;
  height: number;
}

export interface LanePosition {
  x: number;
  y: number;
  /** 0-based lane index, left to right — useful for drawing lane dividers/labels. */
  lane: number;
}

/**
 * One vertical lane per type. Lanes are ordered by the renderer family a type belongs to
 * (`familyOf`, src/theme/families.ts — the built-in `who/what/how/when/why/where` table plus
 * its deterministic hash fallback for a type it doesn't know; a package's own
 * `vaire-renderer.toml` is deliberately not consulted here, keeping this function pure of any
 * per-package config), per `familyOrder` (pass `FAMILY_ORDER` from that module for the
 * renderer's own who/what/how/when/why/where sequence), then alphabetically by type slug within
 * the same family. Nodes within a lane are sorted by degree **descending** then name
 * ascending — hubs near the top of their lane, matching the intuition that a lane reads
 * top-to-bottom as "most-referenced first" (see DESIGN.md: lanes make positions meaningful —
 * "where are the decisions?" — and a hub decision belongs where the eye lands first). A type
 * that doesn't appear in `familyOrder` at all sorts after every family that does, alphabetically
 * among any other such families.
 *
 * Positions are a pure function of `graph`'s node/edge set, `familyOrder` and `size` — same
 * inputs always produce the same `{x, y, lane}` map (see tests/package-graph.test.ts), and
 * within one lane no two nodes ever share a y (distinct index -> distinct row), so nothing
 * overlaps vertically. This is a single deterministic placement, not a running simulation —
 * unlike `force`, `laneLayout` has no ticks to converge.
 */
export function laneLayout(
  graph: Pick<PackageGraphModel, 'nodes' | 'edges'>,
  familyOrder: readonly string[],
  size: LaneLayoutSize,
): Map<string, LanePosition> {
  const deg = degrees(graph);
  const familyRank = new Map<string, number>();
  familyOrder.forEach((fam, i) => familyRank.set(fam, i));
  const rankOf = (family: string): number => familyRank.get(family) ?? familyOrder.length;

  const types = [...new Set(graph.nodes.map((n) => n.type))].sort((a, b) => {
    const ra = rankOf(familyOf(a));
    const rb = rankOf(familyOf(b));
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  const positions = new Map<string, LanePosition>();
  const laneWidth = size.width / Math.max(1, types.length);

  types.forEach((type, laneIdx) => {
    const laneNodes = graph.nodes
      .filter((n) => n.type === type)
      .sort((a, b) => {
        const da = deg.get(a.id) ?? 0;
        const db = deg.get(b.id) ?? 0;
        if (da !== db) return db - da; // higher degree first
        return a.name.localeCompare(b.name);
      });

    const x = laneWidth * laneIdx + laneWidth / 2;
    const rowHeight = size.height / (laneNodes.length + 1);
    laneNodes.forEach((n, i) => {
      positions.set(n.id, { x, y: rowHeight * (i + 1), lane: laneIdx });
    });
  });

  return positions;
}
