import { describe, expect, test } from 'bun:test';
import { FAMILY_ORDER } from '../src/theme/families';
import {
  buildPackageGraph,
  degrees,
  laneLayout,
  type PackageGraphNodeInput,
} from '../src/package-graph/pure';

// ---- A 50-node synthetic fixture ------------------------------------------------------------
//
// Spread across six builtin-family types (person/who, system/what, guide/how, record/when,
// decision/why, project/where — see src/theme/families.ts's BUILTIN_TYPE_FAMILIES), plus:
//  - a scoped container (`project:atlas`) with three scoped `record` nodes under it
//  - three superseded nodes (`supersededBy` set, target still present)
//  - four true orphans (no frontmatter/prose edges to or from anything)
//  - cross-package (`@other-pkg/…`) references from a couple of decisions
//  - a self-reference and a dangling local reference, to check both are silently dropped
//  - one duplicate reference (same target, two different frontmatter keys) to check dedupe

function node(full: string, type: string, name: string, frontmatter: Record<string, unknown> = {}): PackageGraphNodeInput {
  return { full, type, name, frontmatter };
}

function buildFixture(): { nodes: PackageGraphNodeInput[]; linksByFile: Map<string, string[]> } {
  const nodes: PackageGraphNodeInput[] = [];
  const linksByFile = new Map<string, string[]>();

  // 8 people, referenced by decisions/records below.
  for (let i = 0; i < 8; i++) nodes.push(node(`person:p${i}`, 'person', `Person ${i}`));

  // 8 systems.
  for (let i = 0; i < 8; i++) nodes.push(node(`system:s${i}`, 'system', `System ${i}`));

  // 8 guides, each referencing one system via frontmatter.
  for (let i = 0; i < 8; i++) {
    nodes.push(node(`guide:g${i}`, 'guide', `Guide ${i}`, { covers: `system:s${i}` }));
  }

  // 8 decisions: owner (frontmatter) + a prose reference to a system + two cross-package refs
  // on the first couple, to exercise "Show dependencies".
  for (let i = 0; i < 8; i++) {
    const fm: Record<string, unknown> = { owner: `person:p${i}`, affects: `system:s${i}` };
    if (i < 2) fm.depends_on = `@other-pkg/system:ext-${i}`;
    nodes.push(node(`decision:d${i}`, 'decision', `Decision ${i}`, fm));
    const prose = [`system:s${i}`]; // duplicate of the frontmatter `affects` edge -> should dedupe
    if (i === 0) prose.push('@other-pkg/person:jane'); // second cross-package ref, different type
    linksByFile.set(`decision:d${i}`, prose);
  }

  // 8 records, each referencing the decision it documents.
  for (let i = 0; i < 8; i++) {
    nodes.push(node(`record:r${i}`, 'record', `Record ${i}`, { decision: `decision:d${i}` }));
  }

  // Scoped container + 3 scoped records under it, referencing each other and the container.
  nodes.push(node('project:atlas', 'project', 'Atlas'));
  nodes.push(node('project:atlas/record:standup-1', 'record', 'Standup 1', { about: 'project:atlas' }));
  nodes.push(node('project:atlas/record:standup-2', 'record', 'Standup 2', { about: 'project:atlas', follows: 'project:atlas/record:standup-1' }));
  nodes.push(node('project:atlas/record:standup-3', 'record', 'Standup 3', { about: 'project:atlas' }));

  // 3 superseded nodes: two decisions and a person, all still referenced by something so the
  // "does hideSuperseded also drop edges touching it" behavior is actually exercised.
  nodes.push({ ...node('decision:d-old-1', 'decision', 'Old decision 1', { owner: 'person:p0' }), supersededBy: 'decision:d0' });
  nodes.push({ ...node('decision:d-old-2', 'decision', 'Old decision 2'), supersededBy: 'decision:d1' });
  nodes.push({ ...node('person:p-old', 'person', 'Old person'), supersededBy: 'person:p0' });
  nodes.push(node('record:r-cites-old', 'record', 'Cites an old decision', { decision: 'decision:d-old-1' }));

  // 4 true orphans: no edges in or out at all.
  nodes.push(node('person:orphan-1', 'person', 'Orphan person 1'));
  nodes.push(node('system:orphan-2', 'system', 'Orphan system 2'));
  nodes.push(node('guide:orphan-3', 'guide', 'Orphan guide 3'));
  nodes.push(node('project:orphan-4', 'project', 'Orphan project 4'));

  // Self-reference (must be dropped) and a dangling local reference (target doesn't exist,
  // must not fabricate a node or edge).
  nodes.push(node('system:self-ref', 'system', 'Self-referential system', { related: 'system:self-ref' }));
  nodes.push(node('guide:dangling', 'guide', 'Dangling guide', { covers: 'system:does-not-exist' }));

  return { nodes, linksByFile };
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// ---- buildPackageGraph — dedupe ---------------------------------------------------------

describe('buildPackageGraph — dedupe', () => {
  test('a duplicate reference (frontmatter + identical prose target) collapses into one edge', () => {
    const { nodes, linksByFile } = buildFixture();
    const { edges } = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const d0ToS0 = edges.filter((e) => e.source === 'decision:d0' && e.target === 'system:s0');
    expect(d0ToS0).toHaveLength(1);
  });

  test('a self-reference is dropped, not drawn as a loop', () => {
    const { nodes, linksByFile } = buildFixture();
    const { edges } = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    expect(edges.some((e) => e.source === 'system:self-ref' && e.target === 'system:self-ref')).toBe(false);
  });

  test('a dangling local reference produces neither a fabricated node nor an edge', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    expect(outNodes.some((n) => n.id === 'system:does-not-exist')).toBe(false);
    expect(edges.some((e) => e.source === 'guide:dangling')).toBe(false);
  });
});

// ---- buildPackageGraph — filters ---------------------------------------------------------

describe('buildPackageGraph — hideSuperseded (default true)', () => {
  test('default: superseded nodes and every edge touching one are dropped', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile);
    expect(outNodes.some((n) => n.id === 'decision:d-old-1')).toBe(false);
    expect(outNodes.some((n) => n.id === 'decision:d-old-2')).toBe(false);
    expect(outNodes.some((n) => n.id === 'person:p-old')).toBe(false);
    // record:r-cites-old -> decision:d-old-1 must be gone too, since its target was dropped.
    expect(edges.some((e) => e.source === 'record:r-cites-old' && e.target === 'decision:d-old-1')).toBe(false);
  });

  test('hideSuperseded: false keeps them (and their surviving edges)', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    expect(outNodes.some((n) => n.id === 'decision:d-old-1')).toBe(true);
    expect(edges.some((e) => e.source === 'record:r-cites-old' && e.target === 'decision:d-old-1')).toBe(true);
  });
});

describe('buildPackageGraph — includeDependencies (default false)', () => {
  test('default: cross-package references contribute neither a ghost node nor an edge', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    expect(outNodes.some((n) => n.isGhost)).toBe(false);
    expect(edges.some((e) => e.target.startsWith('@'))).toBe(false);
  });

  test('true: adds one ghost node per distinct external address, and edges to them', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, {
      hideSuperseded: false,
      includeDependencies: true,
    });
    const ghosts = outNodes.filter((n) => n.isGhost);
    // @other-pkg/system:ext-0, @other-pkg/system:ext-1, @other-pkg/person:jane
    expect(ghosts).toHaveLength(3);
    expect(ghosts.every((g) => g.id.startsWith('@other-pkg/'))).toBe(true);
    expect(edges.some((e) => e.source === 'decision:d0' && e.target === '@other-pkg/system:ext-0')).toBe(true);
    expect(edges.some((e) => e.source === 'decision:d0' && e.target === '@other-pkg/person:jane')).toBe(true);
  });

  test('a ghost node without a name resolver falls back to the reference\'s bare local id', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes } = buildPackageGraph(nodes, linksByFile, { includeDependencies: true });
    const ghost = outNodes.find((n) => n.id === '@other-pkg/system:ext-0')!;
    expect(ghost.name).toBe('ext-0');
  });

  test('resolveDependencyName supplies the ghost node name when it can', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes } = buildPackageGraph(nodes, linksByFile, {
      includeDependencies: true,
      resolveDependencyName: (id) => (id === '@other-pkg/person:jane' ? 'Jane' : undefined),
    });
    expect(outNodes.find((n) => n.id === '@other-pkg/person:jane')!.name).toBe('Jane');
    // Falls back to the bare id for anything the resolver doesn't know.
    expect(outNodes.find((n) => n.id === '@other-pkg/system:ext-1')!.name).toBe('ext-1');
  });
});

describe('buildPackageGraph — types filter', () => {
  test('keeps only the given types, and drops edges touching a filtered-out node', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, {
      hideSuperseded: false,
      types: new Set(['decision', 'person']),
    });
    expect(outNodes.every((n) => n.type === 'decision' || n.type === 'person')).toBe(true);
    // decision:d0 -> system:s0 must be gone, since system was filtered out.
    expect(edges.some((e) => e.target.startsWith('system:'))).toBe(false);
    // decision:d0 -> person:p0 (owner) survives, both endpoints kept.
    expect(edges.some((e) => e.source === 'decision:d0' && e.target === 'person:p0')).toBe(true);
  });

  test('an empty types set means "no filter", not "nothing"', () => {
    const { nodes, linksByFile } = buildFixture();
    const full = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const filtered = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false, types: new Set() });
    expect(filtered.nodes.length).toBe(full.nodes.length);
  });
});

describe('buildPackageGraph — hideOrphans (default false)', () => {
  test('default: true orphans stay in the node set', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes } = buildPackageGraph(nodes, linksByFile);
    expect(outNodes.some((n) => n.id === 'person:orphan-1')).toBe(true);
  });

  test('true: every zero-degree node (including ones only orphaned by another filter) is dropped', () => {
    const { nodes, linksByFile } = buildFixture();
    const { nodes: outNodes, edges } = buildPackageGraph(nodes, linksByFile, { hideOrphans: true });
    for (const n of outNodes) {
      const hasEdge = edges.some((e) => e.source === n.id || e.target === n.id);
      expect(hasEdge).toBe(true);
    }
    expect(outNodes.some((n) => n.id === 'person:orphan-1')).toBe(false);
    expect(outNodes.some((n) => n.id === 'system:orphan-2')).toBe(false);
    // guide:dangling has no *surviving* edge (its only ref was dangling) -> also an orphan.
    expect(outNodes.some((n) => n.id === 'guide:dangling')).toBe(false);
  });

  test('a type filter that isolates a node counts as an orphan too, once hideOrphans is on', () => {
    const { nodes, linksByFile } = buildFixture();
    // Keep only "system" — every system's only edges are to/from guides and decisions, which
    // are filtered out, so *every* system becomes an orphan under this filter.
    const { nodes: outNodes } = buildPackageGraph(nodes, linksByFile, {
      hideSuperseded: false,
      types: new Set(['system']),
      hideOrphans: true,
    });
    expect(outNodes).toHaveLength(0);
  });
});

// ---- degrees --------------------------------------------------------------------------------

describe('degrees', () => {
  test('counts in + out edges per node; zero-degree nodes still get an entry', () => {
    const { nodes, linksByFile } = buildFixture();
    const graph = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const deg = degrees(graph);
    // decision:d0 -> person:p0 (owner) and -> system:s0 (affects, dedup'd with prose): 2 out.
    // record:r0 -> decision:d0 ("decision" field): 1 in. Total degree 3.
    expect(deg.get('decision:d0')).toBe(3);
    // person:orphan-1 has no edges at all.
    expect(deg.get('person:orphan-1')).toBe(0);
    // person:p0 is referenced by decision:d0 (owner) and decision:d-old-1 (owner, superseded but
    // present here since hideSuperseded is false): in-degree 2.
    expect(deg.get('person:p0')).toBe(2);
  });
});

// ---- laneLayout -----------------------------------------------------------------------------

describe('laneLayout — lane ordering', () => {
  test('lanes follow the family order (who/what/how/when/why/where), alphabetical within a family', () => {
    const { nodes, linksByFile } = buildFixture();
    // Add two "who"-family types (person, org) to check the alphabetical tie-break.
    const withOrg = [...nodes, node('org:acme', 'org', 'Acme')];
    const graph = buildPackageGraph(withOrg, linksByFile, { hideSuperseded: false });
    const positions = laneLayout(graph, FAMILY_ORDER, { width: 1200, height: 800 });

    const laneOf = (id: string): number => positions.get(id)!.lane;
    // who: org, person (alphabetical) < what: system < how: guide < when: record < why: decision
    // < where: project.
    expect(laneOf('org:acme')).toBeLessThan(laneOf('person:p0'));
    expect(laneOf('person:p0')).toBeLessThan(laneOf('system:s0'));
    expect(laneOf('system:s0')).toBeLessThan(laneOf('guide:g0'));
    expect(laneOf('guide:g0')).toBeLessThan(laneOf('record:r0'));
    expect(laneOf('record:r0')).toBeLessThan(laneOf('decision:d0'));
    expect(laneOf('decision:d0')).toBeLessThan(laneOf('project:atlas'));

    // Every node of the same type shares a lane.
    const laneCounts = countBy(graph.nodes, (n) => String(laneOf(n.id)));
    const typeCounts = countBy(graph.nodes, (n) => n.type);
    expect(laneCounts.size).toBe(typeCounts.size);
  });
});

describe('laneLayout — determinism and layout', () => {
  test('same graph + size -> identical positions across calls', () => {
    const { nodes, linksByFile } = buildFixture();
    const graph = buildPackageGraph(nodes, linksByFile);
    const a = laneLayout(graph, FAMILY_ORDER, { width: 1000, height: 700 });
    const b = laneLayout(graph, FAMILY_ORDER, { width: 1000, height: 700 });
    expect(a).toEqual(b);
  });

  test('no two nodes in the same lane share a y coordinate', () => {
    const { nodes, linksByFile } = buildFixture();
    const graph = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const positions = laneLayout(graph, FAMILY_ORDER, { width: 1200, height: 800 });

    const byLane = new Map<number, number[]>();
    for (const pos of positions.values()) {
      const ys = byLane.get(pos.lane) ?? [];
      ys.push(pos.y);
      byLane.set(pos.lane, ys);
    }
    for (const [, ys] of byLane) {
      expect(new Set(ys).size).toBe(ys.length);
    }
  });

  test('every position is finite and within the given size', () => {
    const { nodes, linksByFile } = buildFixture();
    const graph = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const size = { width: 900, height: 600 };
    const positions = laneLayout(graph, FAMILY_ORDER, size);
    for (const pos of positions.values()) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.x).toBeLessThanOrEqual(size.width);
      expect(pos.y).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeLessThanOrEqual(size.height);
    }
  });

  test('within a lane, nodes are ordered by degree descending, then name', () => {
    const { nodes, linksByFile } = buildFixture();
    const graph = buildPackageGraph(nodes, linksByFile, { hideSuperseded: false });
    const deg = degrees(graph);
    const positions = laneLayout(graph, FAMILY_ORDER, { width: 1200, height: 800 });

    // The "record" lane: record:r0..r7 (degree 1 each, referencing a decision) plus the three
    // scoped standup records (varying degree) and record:r-cites-old (degree 1, superseded
    // target dropped by default so its out-edge survives here since hideSuperseded is false).
    const recordNodes = graph.nodes.filter((n) => n.type === 'record');
    const sortedByLayout = [...recordNodes].sort((a, b) => positions.get(a.id)!.y - positions.get(b.id)!.y);
    for (let i = 1; i < sortedByLayout.length; i++) {
      const prevDeg = deg.get(sortedByLayout[i - 1].id) ?? 0;
      const curDeg = deg.get(sortedByLayout[i].id) ?? 0;
      expect(prevDeg).toBeGreaterThanOrEqual(curDeg);
    }
  });
});
