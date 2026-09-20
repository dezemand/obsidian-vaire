import { describe, expect, test } from 'bun:test';
import { buildGraph } from '../src/graph/model';
import { ForceLayout } from '../src/graph/layout';
import type { BacklinksResult, RefsResult } from '../src/types';

// ---- buildGraph ---------------------------------------------------------------------------

function refs(entries: RefsResult['refs'], depth = 2): RefsResult {
  return { id: 'concept:center', depth, refs: entries };
}

function backlinks(entries: BacklinksResult['backlinks']): BacklinksResult {
  return { id: 'concept:center', backlinks: entries };
}

const center = { id: 'concept:center', type: 'concept', name: 'Center' };

describe('buildGraph — nodes', () => {
  test('always includes the center node, marked isCenter with distance 0', () => {
    const { nodes } = buildGraph({ center, refs: refs([]), backlinks: backlinks([]) });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: 'concept:center', isCenter: true, distance: 0 });
  });

  test('dedupes a node id that appears more than once in refs (e.g. two occurrences at the same distance)', () => {
    const { nodes, edges } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'related', line: 3, distance: 1 },
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'inline', line: 9, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    const a = nodes.filter((n) => n.id === 'concept:a');
    expect(a).toHaveLength(1);
    expect(a[0].fromRefs).toBe(true);
    // Two raw entries for the same (source, target) merge into one edge.
    expect(edges).toHaveLength(1);
  });

  test('a node reached via both refs (distance 2) and backlinks (distance 1) is one node with both flags set, distance = 1', () => {
    const { nodes, edges } = buildGraph({
      center,
      refs: refs([{ id: 'concept:both', type: 'concept', path: 'b.md', ref_type: 'inline', line: 5, distance: 2 }]),
      backlinks: backlinks([
        { id: 'concept:both', type: 'concept', path: 'b.md', ref_type: 'sees', line: 11 },
      ]),
    });
    const both = nodes.find((n) => n.id === 'concept:both')!;
    expect(both).toBeDefined();
    expect(both.fromRefs).toBe(true);
    expect(both.fromBacklinks).toBe(true);
    expect(both.distance).toBe(1); // closer of the two known hop counts

    // Distinct edges in each direction: center -> both (out) and both -> center (in).
    expect(edges).toHaveLength(2);
    const out = edges.find((e) => e.direction === 'out')!;
    const inb = edges.find((e) => e.direction === 'in')!;
    expect(out).toMatchObject({ source: 'concept:center', target: 'concept:both', refType: 'inline', frontmatter: false });
    expect(inb).toMatchObject({ source: 'concept:both', target: 'concept:center', refType: 'sees', frontmatter: true });
  });

  test('resolves names via the provided lookup, falling back to the bare id', () => {
    const { nodes } = buildGraph({
      center,
      refs: refs([{ id: 'concept:named', type: 'concept', path: 'n.md', ref_type: 'inline', line: 1, distance: 1 }]),
      backlinks: backlinks([]),
      names: (id) => (id === 'concept:named' ? 'Named Thing' : undefined),
    });
    const named = nodes.find((n) => n.id === 'concept:named')!;
    expect(named.name).toBe('Named Thing');

    const { nodes: unnamedNodes } = buildGraph({
      center,
      refs: refs([{ id: 'concept:unnamed', type: 'concept', path: 'u.md', ref_type: 'inline', line: 1, distance: 1 }]),
      backlinks: backlinks([]),
    });
    expect(unnamedNodes.find((n) => n.id === 'concept:unnamed')!.name).toBe('concept:unnamed');
  });

  test('cross-package entries (with a `package` field) get an @pkg/-prefixed node id', () => {
    const { nodes } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:external', type: 'concept', path: 'e.md', package: 'other-pkg', ref_type: 'inline', line: 1, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    const ext = nodes.find((n) => n.pkg === 'other-pkg')!;
    expect(ext.id).toBe('@other-pkg/concept:external');
  });

  test('drops a self-reference instead of drawing a loop onto the center', () => {
    const { nodes, edges } = buildGraph({
      center,
      refs: refs([{ id: 'concept:center', type: 'concept', path: 'c.md', ref_type: 'inline', line: 1, distance: 1 }]),
      backlinks: backlinks([{ id: 'concept:center', type: 'concept', path: 'c.md', ref_type: 'inline', line: 2 }]),
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});

describe('buildGraph — edges: direction, frontmatter vs. prose, merging', () => {
  test('refs become "out" edges from the center; backlinks become "in" edges into the center', () => {
    const { edges } = buildGraph({
      center,
      refs: refs([{ id: 'concept:x', type: 'concept', path: 'x.md', ref_type: 'inline', line: 1, distance: 1 }]),
      backlinks: backlinks([{ id: 'concept:y', type: 'concept', path: 'y.md', ref_type: 'inline', line: 1 }]),
    });
    const out = edges.find((e) => e.target === 'concept:x')!;
    expect(out).toMatchObject({ source: 'concept:center', target: 'concept:x', direction: 'out' });
    const inb = edges.find((e) => e.source === 'concept:y')!;
    expect(inb).toMatchObject({ source: 'concept:y', target: 'concept:center', direction: 'in' });
  });

  test('ref_type "inline" is prose (frontmatter: false); anything else is a frontmatter key (frontmatter: true)', () => {
    const { edges } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:prose', type: 'concept', path: 'p.md', ref_type: 'inline', line: 1, distance: 1 },
        { id: 'concept:fm', type: 'concept', path: 'f.md', ref_type: 'related_systems', line: 1, distance: 1 },
        { id: 'concept:diagram', type: 'concept', path: 'd.md', ref_type: 'diagram', line: 1, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    expect(edges.find((e) => e.target === 'concept:prose')).toMatchObject({ frontmatter: false, refType: 'inline' });
    expect(edges.find((e) => e.target === 'concept:fm')).toMatchObject({ frontmatter: true, refType: 'related_systems' });
    expect(edges.find((e) => e.target === 'concept:diagram')).toMatchObject({ frontmatter: true, refType: 'diagram' });
  });

  test('merging prefers "inline" when any duplicate occurrence is prose', () => {
    const { edges } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'sees', line: 1, distance: 1 },
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'inline', line: 2, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ refType: 'inline', frontmatter: false });
  });

  test('merging keeps the frontmatter key when no occurrence is inline', () => {
    const { edges } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'sees', line: 1, distance: 1 },
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'sees', line: 2, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ refType: 'sees', frontmatter: true });
  });
});

describe('buildGraph — distance', () => {
  test('carries the refs distance through onto the node', () => {
    const { nodes } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:near', type: 'concept', path: 'n.md', ref_type: 'inline', line: 1, distance: 1 },
        { id: 'concept:far', type: 'concept', path: 'f.md', ref_type: 'inline', line: 1, distance: 2 },
      ]),
      backlinks: backlinks([]),
    });
    expect(nodes.find((n) => n.id === 'concept:near')!.distance).toBe(1);
    expect(nodes.find((n) => n.id === 'concept:far')!.distance).toBe(2);
  });

  test('a backlink-only node gets distance 1', () => {
    const { nodes } = buildGraph({
      center,
      refs: refs([]),
      backlinks: backlinks([{ id: 'concept:back', type: 'concept', path: 'b.md', ref_type: 'inline', line: 1 }]),
    });
    expect(nodes.find((n) => n.id === 'concept:back')!.distance).toBe(1);
  });

  test('takes the minimum distance when the same node shows up twice in refs at different distances', () => {
    const { nodes } = buildGraph({
      center,
      refs: refs([
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'inline', line: 1, distance: 2 },
        { id: 'concept:a', type: 'concept', path: 'a.md', ref_type: 'inline', line: 5, distance: 1 },
      ]),
      backlinks: backlinks([]),
    });
    expect(nodes.find((n) => n.id === 'concept:a')!.distance).toBe(1);
  });
});

describe('buildGraph — maxNodes cap', () => {
  test('keeps the center plus the closest nodes, dropping edges that touch a dropped node', () => {
    const entries: RefsResult['refs'] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({ id: `concept:n${i}`, type: 'concept', path: `${i}.md`, ref_type: 'inline', line: 1, distance: 1 });
    }
    const { nodes, edges } = buildGraph({ center, refs: refs(entries), backlinks: backlinks([]) }, { maxNodes: 4 });
    expect(nodes).toHaveLength(4);
    expect(nodes.some((n) => n.isCenter)).toBe(true);
    // Every surviving edge only touches surviving nodes.
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

// ---- ForceLayout ----------------------------------------------------------------------------

function starGraph(n: number): { nodes: { id: string; distance?: number }[]; edges: { source: string; target: string }[] } {
  const nodes = [{ id: 'center', distance: 0 }];
  const edges: { source: string; target: string }[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `n${i}`, distance: 1 + (i % 2) });
    edges.push({ source: 'center', target: `n${i}` });
  }
  return { nodes, edges };
}

describe('ForceLayout', () => {
  test('energy trends downward as the simulation settles', () => {
    const { nodes, edges } = starGraph(12);
    const layout = new ForceLayout(nodes, edges, { seed: 42, width: 500, height: 400 });

    let earlyTotal = 0;
    for (let i = 0; i < 10; i++) earlyTotal += layout.step();
    let lateTotal = 0;
    for (let i = 0; i < 10; i++) lateTotal += layout.step();
    for (let i = 0; i < 80; i++) layout.step();
    let finalTotal = 0;
    for (let i = 0; i < 10; i++) finalTotal += layout.step();

    expect(lateTotal).toBeLessThan(earlyTotal);
    expect(finalTotal).toBeLessThan(lateTotal);
  });

  test('is deterministic for a fixed seed: same inputs + same seed -> identical positions', () => {
    const { nodes, edges } = starGraph(8);
    const a = new ForceLayout(nodes, edges, { seed: 7, width: 400, height: 300 });
    const b = new ForceLayout(nodes, edges, { seed: 7, width: 400, height: 300 });

    for (let i = 0; i < 50; i++) {
      a.step();
      b.step();
    }

    for (const n of nodes) {
      const pa = a.get(n.id)!;
      const pb = b.get(n.id)!;
      expect(pa.x).toBe(pb.x);
      expect(pa.y).toBe(pb.y);
    }
  });

  test('a different seed produces a different layout', () => {
    const { nodes, edges } = starGraph(8);
    const a = new ForceLayout(nodes, edges, { seed: 1, width: 400, height: 300 });
    const b = new ForceLayout(nodes, edges, { seed: 2, width: 400, height: 300 });
    for (let i = 0; i < 10; i++) {
      a.step();
      b.step();
    }
    const positionsDiffer = nodes.some((n) => {
      const pa = a.get(n.id)!;
      const pb = b.get(n.id)!;
      return pa.x !== pb.x || pa.y !== pb.y;
    });
    expect(positionsDiffer).toBe(true);
  });

  test('pin() freezes a node in place across subsequent steps', () => {
    const { nodes, edges } = starGraph(6);
    const layout = new ForceLayout(nodes, edges, { seed: 3 });
    layout.pin('n0', 250, 250);
    for (let i = 0; i < 30; i++) layout.step();
    const n = layout.get('n0')!;
    expect(n.x).toBe(250);
    expect(n.y).toBe(250);
  });

  test('unpin() lets the simulation move the node again', () => {
    const { nodes, edges } = starGraph(6);
    const layout = new ForceLayout(nodes, edges, { seed: 3 });
    layout.pin('n0', 250, 250);
    layout.step();
    layout.unpin('n0');
    for (let i = 0; i < 30; i++) layout.step();
    const n = layout.get('n0')!;
    expect(n.x === 250 && n.y === 250).toBe(false);
  });

  test('edges referencing an id not in the node set are dropped without throwing', () => {
    const layout = new ForceLayout(
      [{ id: 'a', distance: 0 }, { id: 'b', distance: 1 }],
      [{ source: 'a', target: 'ghost' }, { source: 'a', target: 'b' }],
    );
    expect(() => layout.step()).not.toThrow();
  });
});
