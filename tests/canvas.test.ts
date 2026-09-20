import { describe, expect, test } from 'bun:test';
import {
  canvasEdgeId,
  canvasFileName,
  canvasNodeId,
  graphToCanvas,
  scalePositions,
  type CanvasFileNode,
  type CanvasTextNode,
  type Position,
} from '../src/graph/canvas';
import { buildGraph } from '../src/graph/model';
import type { BacklinksResult, RefsResult } from '../src/types';

// ---- fixtures -------------------------------------------------------------------------------

function refs(entries: RefsResult['refs'], depth = 2): RefsResult {
  return { id: 'concept:center', depth, refs: entries };
}

function backlinks(entries: BacklinksResult['backlinks']): BacklinksResult {
  return { id: 'concept:center', backlinks: entries };
}

const center = { id: 'concept:center', type: 'concept', name: 'Center' };

/** A graph with: the center, one local ref (a vault node), one dependency ref (`@other-pkg/…`),
 *  and one local backlink — enough to exercise every node/edge kind the exporter handles. */
function sampleGraph() {
  return buildGraph({
    center,
    refs: refs([
      { id: 'concept:local-ref', type: 'concept', path: 'local-ref.md', ref_type: 'inline', line: 1, distance: 1 },
      {
        id: 'concept:dep',
        type: 'concept',
        path: 'dep.md',
        package: 'other-pkg',
        ref_type: 'related_systems',
        line: 4,
        distance: 1,
      },
    ]),
    backlinks: backlinks([
      { id: 'concept:local-back', type: 'concept', path: 'local-back.md', ref_type: 'sees', line: 9 },
    ]),
  });
}

/** Arbitrary but distinct positions for every node in `sampleGraph()`, spread out enough that
 *  `scalePositions` won't collapse anything. */
function samplePositions(graph: ReturnType<typeof sampleGraph>): Map<string, Position> {
  const positions = new Map<string, Position>();
  graph.nodes.forEach((n, i) => positions.set(n.id, { x: i * 100, y: i * 37 }));
  return positions;
}

/** `LocalIndex`-backed lookup stand-in: only `concept:center`, `concept:local-ref` and
 *  `concept:local-back` are "vault files"; `@other-pkg/concept:dep` (a dependency, `pkg` set)
 *  never reaches this since `graphToCanvas` short-circuits on `node.pkg`. */
function vaultPathFor(id: string): string | undefined {
  const paths: Record<string, string> = {
    'concept:center': 'nodes/center.md',
    'concept:local-ref': 'nodes/local-ref.md',
    'concept:local-back': 'nodes/local-back.md',
  };
  return paths[id];
}

// ---- canvasNodeId / canvasEdgeId ------------------------------------------------------------

describe('canvasNodeId / canvasEdgeId', () => {
  test('are stable: the same input always produces the same id', () => {
    expect(canvasNodeId('concept:center')).toBe(canvasNodeId('concept:center'));
    expect(canvasEdgeId({ source: 'a', target: 'b', refType: 'inline' })).toBe(
      canvasEdgeId({ source: 'a', target: 'b', refType: 'inline' }),
    );
  });

  test('differ for different inputs', () => {
    expect(canvasNodeId('concept:center')).not.toBe(canvasNodeId('concept:other'));
    expect(canvasEdgeId({ source: 'a', target: 'b', refType: 'inline' })).not.toBe(
      canvasEdgeId({ source: 'a', target: 'b', refType: 'related' }),
    );
  });

  test('node and edge ids are namespaced apart (n- vs e-)', () => {
    expect(canvasNodeId('concept:center').startsWith('n-')).toBe(true);
    expect(canvasEdgeId({ source: 'a', target: 'b', refType: 'inline' }).startsWith('e-')).toBe(true);
  });
});

// ---- canvasFileName --------------------------------------------------------------------------

describe('canvasFileName', () => {
  test('replaces ":" and "/" with "-"', () => {
    expect(canvasFileName('concept:reference')).toBe('concept-reference.canvas');
  });

  test('sanitizes a scoped id', () => {
    expect(canvasFileName('cli:vaire/command:index')).toBe('cli-vaire-command-index.canvas');
  });

  test('sanitizes an @pkg-prefixed id', () => {
    expect(canvasFileName('@other-pkg/concept:dep')).toBe('@other-pkg-concept-dep.canvas');
  });
});

// ---- scalePositions --------------------------------------------------------------------------

describe('scalePositions', () => {
  test('rescales so the average nearest-neighbor distance matches the requested spacing', () => {
    const positions = new Map<string, Position>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 10, y: 0 }],
      ['c', { x: 0, y: 10 }],
    ]);
    const scaled = scalePositions(positions, 220);

    let total = 0;
    const entries = [...scaled.entries()];
    for (const [, p] of entries) {
      let nearest = Infinity;
      for (const [, q] of entries) {
        if (p === q) continue;
        nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      }
      total += nearest;
    }
    const avg = total / entries.length;
    expect(avg).toBeGreaterThan(200);
    expect(avg).toBeLessThan(240);
  });

  test('is a pure function of the positions: same input -> same output', () => {
    const positions = new Map<string, Position>([
      ['a', { x: 3, y: 5 }],
      ['b', { x: -7, y: 2 }],
    ]);
    const first = scalePositions(positions, 220);
    const second = scalePositions(positions, 220);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  test('collapses zero or one position to the origin instead of dividing by zero', () => {
    expect(scalePositions(new Map(), 220).size).toBe(0);
    const one = scalePositions(new Map([['a', { x: 42, y: -13 }]]), 220);
    expect(one.get('a')).toEqual({ x: 0, y: 0 });
  });
});

// ---- graphToCanvas ----------------------------------------------------------------------------

describe('graphToCanvas', () => {
  test('every edge references a node id that exists in the document', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });
    const nodeIds = new Set(doc.nodes.map((n) => n.id));
    expect(doc.edges.length).toBeGreaterThan(0);
    for (const edge of doc.edges) {
      expect(nodeIds.has(edge.fromNode)).toBe(true);
      expect(nodeIds.has(edge.toNode)).toBe(true);
    }
  });

  test('the center node is marked: larger card and the accent color', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });
    const centerCanvasId = canvasNodeId('concept:center');
    const centerCard = doc.nodes.find((n) => n.id === centerCanvasId)!;
    const other = doc.nodes.find((n) => n.id !== centerCanvasId)!;

    expect(centerCard.color).toBe('4');
    expect(centerCard.width).toBeGreaterThan(other.width);
    expect(centerCard.height).toBeGreaterThan(other.height);
  });

  test('a dependency node (has `pkg`) becomes a text card with the name and full address, never asking vaultPathFor', () => {
    const graph = sampleGraph();
    let askedForDep = false;
    const doc = graphToCanvas(graph, samplePositions(graph), {
      vaultPathFor: (id) => {
        if (id === '@other-pkg/concept:dep') askedForDep = true;
        return vaultPathFor(id);
      },
    });
    const depCanvasId = canvasNodeId('@other-pkg/concept:dep');
    const depCard = doc.nodes.find((n) => n.id === depCanvasId) as CanvasTextNode;

    expect(askedForDep).toBe(false);
    expect(depCard.type).toBe('text');
    expect(depCard.text).toContain('@other-pkg/concept:dep');
    // Name resolution had nothing to go on (no `names` lookup passed to buildGraph), so
    // buildGraph fell back to the bare id as the display name.
    expect(depCard.text).toContain('@other-pkg/concept:dep');
    expect(depCard.color).not.toBe('4'); // not mistaken for the center
  });

  test('a local node resolvable via vaultPathFor becomes a file card at that vault path', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });
    const localRefId = canvasNodeId('concept:local-ref');
    const card = doc.nodes.find((n) => n.id === localRefId) as CanvasFileNode;

    expect(card.type).toBe('file');
    expect(card.file).toBe('nodes/local-ref.md');
  });

  test('a local id that vaultPathFor cannot resolve falls back to a text card', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor: () => undefined });
    const localRefId = canvasNodeId('concept:local-ref');
    const card = doc.nodes.find((n) => n.id === localRefId)!;
    expect(card.type).toBe('text');
  });

  test('edges carry toEnd "arrow" and a label only when the ref type is not "inline"', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });

    const inlineEdge = doc.edges.find((e) => e.toNode === canvasNodeId('concept:local-ref'))!;
    expect(inlineEdge.toEnd).toBe('arrow');
    expect(inlineEdge.label).toBeUndefined();

    const fmEdge = doc.edges.find((e) => e.toNode === canvasNodeId('@other-pkg/concept:dep'))!;
    expect(fmEdge.toEnd).toBe('arrow');
    expect(fmEdge.label).toBe('related_systems');
  });

  test('edge direction follows edge.source/edge.target, so a backlink edge points from the referrer to the center', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });
    const backlinkEdge = doc.edges.find((e) => e.fromNode === canvasNodeId('concept:local-back'))!;
    expect(backlinkEdge.toNode).toBe(canvasNodeId('concept:center'));
  });

  test('the produced document round-trips through JSON.stringify/JSON.parse unchanged', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), { vaultPathFor });
    const roundTripped = JSON.parse(JSON.stringify(doc));
    expect(roundTripped).toEqual(doc);
  });

  test('respects custom width/height/color options', () => {
    const graph = sampleGraph();
    const doc = graphToCanvas(graph, samplePositions(graph), {
      vaultPathFor,
      nodeWidth: 300,
      nodeHeight: 120,
      centerWidth: 500,
      centerHeight: 200,
      centerColor: '#123456',
      dependencyColor: '#abcdef',
    });
    const centerCard = doc.nodes.find((n) => n.id === canvasNodeId('concept:center'))!;
    const depCard = doc.nodes.find((n) => n.id === canvasNodeId('@other-pkg/concept:dep'))!;
    const localRefCard = doc.nodes.find((n) => n.id === canvasNodeId('concept:local-ref'))!;

    expect(centerCard.width).toBe(500);
    expect(centerCard.height).toBe(200);
    expect(centerCard.color).toBe('#123456');
    expect(depCard.color).toBe('#abcdef');
    expect(localRefCard.width).toBe(300);
    expect(localRefCard.height).toBe(120);
  });

  test('is deterministic: the same graph/positions/options always produce identical ids', () => {
    const graph = sampleGraph();
    const positions = samplePositions(graph);
    const first = graphToCanvas(graph, positions, { vaultPathFor });
    const second = graphToCanvas(graph, positions, { vaultPathFor });
    expect(first).toEqual(second);
  });
});
