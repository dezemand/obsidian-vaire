// Pure conversion from a `GraphModel` (see model.ts) + laid-out positions into a JSON Canvas
// 1.0 document (https://jsoncanvas.org/spec/1.0/). No `obsidian` import — mirrors model.ts and
// layout.ts staying obsidian-free and unit-testable (see DESIGN.md "Export local graph to
// canvas" and the "Implementation guidance" note). The impure glue (settings, CLI calls,
// writing/opening the vault file) lives in export.ts, which is what graph-view.ts's "To canvas"
// button and the `vaire-export-canvas` command both call.

import type { GraphEdge, GraphModel, GraphNode } from './model';

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

/** The two node types this exporter ever produces (local vault nodes vs. everything else). The
 *  JSON Canvas spec also defines `link` and `group`, unused here. */
export type CanvasNode = CanvasFileNode | CanvasTextNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  toEnd?: 'none' | 'arrow';
  label?: string;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface Position {
  x: number;
  y: number;
}

export interface GraphToCanvasOptions {
  /**
   * Full node id -> vault-relative path for a *local* node (see `GraphNode`, `LocalIndex.get`).
   * Called only for nodes without a `pkg` (a dependency node is always a text card, regardless
   * of what this returns). Returning `undefined` for a local id that can't be resolved to a
   * file also falls back to a text card — defensive, should not happen in practice.
   */
  vaultPathFor: (id: string) => string | undefined;
  nodeWidth?: number;
  nodeHeight?: number;
  centerWidth?: number;
  centerHeight?: number;
  /** `canvasColor` (hex or `"1"`.."6"` preset) for the center node's card. Default `"4"`. */
  centerColor?: string;
  /** `canvasColor` for a dependency (or unresolved-local) text card. Default a muted gray hex —
   *  JSON Canvas's numbered presets don't include a neutral/gray option. */
  dependencyColor?: string;
}

const DEFAULTS = {
  nodeWidth: 260,
  nodeHeight: 100,
  centerWidth: 340,
  centerHeight: 140,
  centerColor: '4',
  dependencyColor: '#888888',
};

/** FNV-1a 32-bit, folded to 8 lowercase hex chars — deterministic, so re-exporting the same
 *  graph produces byte-identical node/edge ids (a stable diff when the `.canvas` file is
 *  committed to a vault under version control). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Canvas node id for a full Vairë address. Namespaced with `n-` so it can never collide with
 *  an edge id (`e-...`) in the same document, even though JSON Canvas doesn't require that. */
export function canvasNodeId(fullId: string): string {
  return `n-${fnv1a(fullId)}`;
}

/** Canvas edge id for one `GraphEdge`: hashes source + target + ref type. `buildGraph` already
 *  merges same-direction same-endpoint edges into one, so in practice this is just a stable hash
 *  of `source|target`, but the ref type is folded in too in case a caller passes edges that
 *  didn't go through `buildGraph`'s dedupe. */
export function canvasEdgeId(edge: Pick<GraphEdge, 'source' | 'target' | 'refType'>): string {
  return `e-${fnv1a(`${edge.source}->${edge.target}:${edge.refType}`)}`;
}

/**
 * `<full id with ':' and '/' replaced by '-'>.canvas`, e.g. `cli:vaire/command:index` ->
 * `cli-vaire-command-index.canvas`. See DESIGN.md's "Export local graph to canvas".
 */
export function canvasFileName(fullId: string): string {
  return `${fullId.replace(/[:/]/g, '-')}.canvas`;
}

/**
 * Rescales a set of layout positions (arbitrary units — e.g. `ForceLayout`'s world coordinates)
 * so their average nearest-neighbor spacing equals `spacing` canvas pixels. Pure function of the
 * positions themselves; no knowledge of the layout's own units is needed. Zero or one position
 * can't define a spacing, so that case collapses everything to the origin.
 */
export function scalePositions(positions: Map<string, Position>, spacing: number): Map<string, Position> {
  const entries = [...positions.entries()];
  if (entries.length <= 1) return new Map(entries.map(([id]) => [id, { x: 0, y: 0 }]));

  let total = 0;
  let counted = 0;
  for (const [, a] of entries) {
    let nearest = Infinity;
    for (const [, b] of entries) {
      if (a === b) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < nearest) nearest = d;
    }
    if (Number.isFinite(nearest)) {
      total += nearest;
      counted++;
    }
  }
  const avgNearest = counted > 0 ? total / counted : 0;
  const scale = avgNearest > 0 ? spacing / avgNearest : 1;
  return new Map(entries.map(([id, p]) => [id, { x: p.x * scale, y: p.y * scale }]));
}

/** `**name**\n\n\`full id\`` — the body of a dependency (or unresolved-local) text card. */
function nodeText(node: GraphNode): string {
  return `**${node.name}**\n\n\`${node.id}\``;
}

/** A dependency node (`pkg` set) is always a text card — never ask `vaultPathFor`, which only
 *  knows about the center's own vault package anyway. */
function vaultPathForNode(node: GraphNode, vaultPathFor: GraphToCanvasOptions['vaultPathFor']): string | undefined {
  if (node.pkg) return undefined;
  return vaultPathFor(node.id);
}

/**
 * Converts a `GraphModel` (see `buildGraph`) plus final positions (see `scalePositions`) into a
 * JSON Canvas 1.0 document: local vault nodes become `file` cards pointing at the vault path
 * (Obsidian renders them live); dependency nodes — and any local id `vaultPathFor` can't resolve
 * — become a `text` card with the name and full address. The center node is drawn larger with an
 * accent color. Edges carry `toEnd: 'arrow'` and a `label` of the ref type whenever it isn't a
 * plain prose (`inline`) reference; `fromNode`/`toNode` follow `edge.source`/`edge.target` as
 * `buildGraph` set them (so an inbound backlink edge still points from the referrer to the
 * center, matching how the local graph view draws its arrowheads).
 */
export function graphToCanvas(
  graph: GraphModel,
  positions: Map<string, Position>,
  opts: GraphToCanvasOptions,
): CanvasDocument {
  const nodeWidth = opts.nodeWidth ?? DEFAULTS.nodeWidth;
  const nodeHeight = opts.nodeHeight ?? DEFAULTS.nodeHeight;
  const centerWidth = opts.centerWidth ?? DEFAULTS.centerWidth;
  const centerHeight = opts.centerHeight ?? DEFAULTS.centerHeight;
  const centerColor = opts.centerColor ?? DEFAULTS.centerColor;
  const dependencyColor = opts.dependencyColor ?? DEFAULTS.dependencyColor;

  const nodes: CanvasNode[] = graph.nodes.map((node) => {
    const pos = positions.get(node.id) ?? { x: 0, y: 0 };
    const width = node.isCenter ? centerWidth : nodeWidth;
    const height = node.isCenter ? centerHeight : nodeHeight;
    const x = Math.round(pos.x - width / 2);
    const y = Math.round(pos.y - height / 2);
    const vaultPath = vaultPathForNode(node, opts.vaultPathFor);

    if (vaultPath) {
      const fileNode: CanvasFileNode = { id: canvasNodeId(node.id), type: 'file', x, y, width, height, file: vaultPath };
      if (node.isCenter) fileNode.color = centerColor;
      return fileNode;
    }

    const textNode: CanvasTextNode = {
      id: canvasNodeId(node.id),
      type: 'text',
      x,
      y,
      width,
      height,
      text: nodeText(node),
      color: node.isCenter ? centerColor : dependencyColor,
    };
    return textNode;
  });

  const edges: CanvasEdge[] = graph.edges.map((edge) => {
    const canvasEdge: CanvasEdge = {
      id: canvasEdgeId(edge),
      fromNode: canvasNodeId(edge.source),
      toNode: canvasNodeId(edge.target),
      toEnd: 'arrow',
    };
    if (edge.refType !== 'inline') canvasEdge.label = edge.refType;
    return canvasEdge;
  });

  return { nodes, edges };
}
