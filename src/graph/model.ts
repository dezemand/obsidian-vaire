// Pure graph model for the local-graph view: turns `cli.refs` + `cli.backlinks` results into
// a deduped node/edge set. No `obsidian` import — see DESIGN.md "Local graph" and the
// "Implementation guidance" note that model.ts and layout.ts stay obsidian-free and testable.
//
// A note on topology: `vaire refs --depth N` returns every node reachable within N hops as a
// *flat* list with a `distance` field, but no parent pointer — we cannot know which distance-1
// node a given distance-2 node was actually reached through (see DESIGN.md "JSON shapes":
// `RefEntry` has no `from`). Drawing an exact tree would need one CLI round trip per
// intermediate node, which the view does not do. Instead every ref (at any distance) is drawn
// as a direct edge from the center node, and `distance` is kept as a node property that the
// layout uses to bias initial placement/spring length — an honest approximation of "how far
// out" a node is, not a literal traversal path.

import type { BacklinksResult, RefsResult } from '../types';

export interface GraphNode {
  /** Full Vairë address, e.g. `concept:x`, `scope/type:id`, or `@pkg/type:id`. */
  id: string;
  type: string;
  name: string;
  pkg?: string;
  /** 0 for the center; otherwise the smallest known hop count (see module note above). */
  distance: number;
  isCenter: boolean;
  fromRefs: boolean;
  fromBacklinks: boolean;
}

export interface GraphEdge {
  /** Node id this edge points from. */
  source: string;
  /** Node id this edge points to (arrowhead end). */
  target: string;
  /** Merged `ref_type`: `'inline'` when any underlying occurrence was prose, else a frontmatter key. */
  refType: string;
  /** `refType !== 'inline'` — drawn dashed vs. solid per DESIGN.md. */
  frontmatter: boolean;
  /** `'out'`: source is the center (an outbound ref). `'in'`: target is the center (a backlink). */
  direction: 'out' | 'in';
}

export interface GraphCenter {
  id: string;
  type: string;
  name: string;
}

export interface BuildGraphInput {
  center: GraphCenter;
  refs: RefsResult;
  backlinks: BacklinksResult;
  /** Local display-name lookup, e.g. package-index-backed; returns `undefined` when unknown. */
  names?: (id: string) => string | undefined;
}

export interface BuildGraphOptions {
  /**
   * Caps the total node count (including the center). When exceeded, the nodes closest to the
   * center (smallest `distance`, tie-broken by id) are kept and the rest — along with any edge
   * touching a dropped node — are discarded. `undefined` (the default) means no cap.
   */
  maxNodes?: number;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** `{package}/{id}` -> the full address a dependency node is addressed by, per DESIGN.md
 *  "JSON shapes" (`resolve`/`refs`/`backlinks` carry a bare `id` plus a separate `package`). */
function fullAddress(entry: { id: string; package?: string }): string {
  return entry.package ? `@${entry.package}/${entry.id}` : entry.id;
}

function mergeRefType(existing: string, incoming: string): string {
  if (existing === 'inline' || incoming === 'inline') return 'inline';
  return existing;
}

class NodeBuilder {
  private readonly byId = new Map<string, GraphNode>();

  constructor(center: GraphCenter, private readonly names?: (id: string) => string | undefined) {
    this.byId.set(center.id, {
      id: center.id,
      type: center.type,
      name: center.name,
      distance: 0,
      isCenter: true,
      fromRefs: false,
      fromBacklinks: false,
    });
  }

  touch(entry: { id: string; type: string; package?: string }, distance: number, via: 'refs' | 'backlinks'): void {
    const id = fullAddress(entry);
    const existing = this.byId.get(id);
    if (existing) {
      existing.distance = Math.min(existing.distance, distance);
      if (via === 'refs') existing.fromRefs = true;
      else existing.fromBacklinks = true;
      return;
    }
    this.byId.set(id, {
      id,
      type: entry.type,
      name: this.names?.(id) ?? id,
      pkg: entry.package,
      distance,
      isCenter: false,
      fromRefs: via === 'refs',
      fromBacklinks: via === 'backlinks',
    });
  }

  get(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  all(): GraphNode[] {
    return [...this.byId.values()];
  }
}

class EdgeBuilder {
  private readonly byKey = new Map<string, GraphEdge>();

  add(source: string, target: string, refType: string, direction: 'out' | 'in'): void {
    const key = `${direction}|${source}|${target}`;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.refType = mergeRefType(existing.refType, refType);
      existing.frontmatter = existing.refType !== 'inline';
      return;
    }
    this.byKey.set(key, { source, target, refType, frontmatter: refType !== 'inline', direction });
  }

  all(): GraphEdge[] {
    return [...this.byKey.values()];
  }
}

/**
 * Builds the deduped node/edge set for the local-graph view from one `refs` result and one
 * `backlinks` result. Self-references (an entry whose address equals the center's) are
 * dropped — they would otherwise draw a loop directly onto the center node.
 */
export function buildGraph(input: BuildGraphInput, opts: BuildGraphOptions = {}): GraphModel {
  const { center, refs, backlinks, names } = input;
  const nodes = new NodeBuilder(center, names);
  const edges = new EdgeBuilder();

  for (const entry of refs.refs) {
    const id = fullAddress(entry);
    if (id === center.id) continue;
    nodes.touch(entry, entry.distance, 'refs');
    edges.add(center.id, id, entry.ref_type, 'out');
  }

  for (const entry of backlinks.backlinks) {
    const id = fullAddress(entry);
    if (id === center.id) continue;
    nodes.touch(entry, 1, 'backlinks');
    edges.add(id, center.id, entry.ref_type, 'in');
  }

  let nodeList = nodes.all();
  let edgeList = edges.all();

  if (opts.maxNodes != null && nodeList.length > opts.maxNodes) {
    const sorted = [...nodeList].sort((a, b) => {
      if (a.isCenter !== b.isCenter) return a.isCenter ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.id.localeCompare(b.id);
    });
    const kept = new Set(sorted.slice(0, opts.maxNodes).map((n) => n.id));
    nodeList = nodeList.filter((n) => kept.has(n.id));
    edgeList = edgeList.filter((e) => kept.has(e.source) && kept.has(e.target));
  }

  return { nodes: nodeList, edges: edgeList };
}
