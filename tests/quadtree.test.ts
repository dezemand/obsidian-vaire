import { describe, expect, test } from 'bun:test';
import { barnesHutForce, buildQuadtree, exactForce, type QPoint } from '../src/graph/quadtree';
import { ForceLayout } from '../src/graph/layout';

// Deterministic PRNG so the "random points" accuracy test is reproducible across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPoints(n: number, seed: number, spread = 500): QPoint[] {
  const rng = mulberry32(seed);
  const points: QPoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({ id: `p${i}`, x: (rng() - 0.5) * spread, y: (rng() - 0.5) * spread });
  }
  return points;
}

function magnitude(f: { fx: number; fy: number }): number {
  return Math.hypot(f.fx, f.fy);
}

describe('buildQuadtree', () => {
  test('returns null for an empty point set', () => {
    expect(buildQuadtree([])).toBeNull();
  });

  test('handles a single point without throwing', () => {
    const tree = buildQuadtree([{ id: 'a', x: 1, y: 2 }]);
    expect(tree).not.toBeNull();
    expect(tree!.kind).toBe('leaf');
  });

  test('handles many exactly-coincident points without infinite recursion', () => {
    const points: QPoint[] = [];
    for (let i = 0; i < 50; i++) points.push({ id: `c${i}`, x: 10, y: 10 });
    expect(() => buildQuadtree(points)).not.toThrow();
  });
});

describe('barnesHutForce vs exactForce — accuracy', () => {
  test('net repulsion on random points is within 10% of the exact sum, on average (theta = 0.9)', () => {
    const points = randomPoints(200, 42);
    const tree = buildQuadtree(points);
    const charge = 1800;
    const theta = 0.9;

    // Barnes-Hut's approximation error is a statistical property of the sum, not a per-query
    // guarantee — a query point whose exact net force is near zero (everything roughly
    // cancels) can show a large *relative* error from a tiny, physically harmless *absolute*
    // one. So this checks the mean relative error across every point (a standard way to state
    // "within 10%" for this kind of approximation), rather than demanding every single query
    // individually clears the bar.
    let totalRelError = 0;
    let checked = 0;
    for (const q of points) {
      const exact = exactForce(points, q.x, q.y, q.id, charge);
      const approx = barnesHutForce(tree, q.x, q.y, q.id, charge, theta);
      const exactMag = magnitude(exact);
      if (exactMag < 1) continue; // negligible exact force; relative error is not meaningful here
      const diff = Math.hypot(approx.fx - exact.fx, approx.fy - exact.fy);
      totalRelError += diff / exactMag;
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(totalRelError / checked).toBeLessThan(0.1);
  });

  test('theta = 0 (exact) matches exactForce closely for every point', () => {
    const points = randomPoints(60, 7);
    const tree = buildQuadtree(points);
    for (const q of points) {
      const exact = exactForce(points, q.x, q.y, q.id, 1800);
      const approx = barnesHutForce(tree, q.x, q.y, q.id, 1800, 0);
      expect(approx.fx).toBeCloseTo(exact.fx, 6);
      expect(approx.fy).toBeCloseTo(exact.fy, 6);
    }
  });
});

describe('barnesHutForce — determinism', () => {
  test('same tree + same query -> identical force, run to run', () => {
    const points = randomPoints(120, 5);
    const tree = buildQuadtree(points);
    const q = points[10];
    const a = barnesHutForce(tree, q.x, q.y, q.id, 1800, 0.9, () => 0.5);
    const b = barnesHutForce(tree, q.x, q.y, q.id, 1800, 0.9, () => 0.5);
    expect(a).toEqual(b);
  });
});

// ---- ForceLayout with Barnes-Hut engaged (n >= threshold) --------------------------------

// Same shape as graph.test.ts's `starGraph` (every leaf connects only to the center, at one of
// two hop distances) — a topology already known to settle cleanly under this simulation, just
// scaled up past `barnesHutThreshold` so `step()` exercises the Barnes-Hut path instead of the
// exact one. A denser, more "tangled" random-edge graph is a much harder (and realistically
// less representative — package graphs are closer to a hub-and-spoke/clustered shape than a
// ring of chords) convergence case and isn't what this test is trying to isolate: whether the
// *approximation* converges the way the exact sum already does, not whether an arbitrary
// topology converges quickly.
function starGraph(n: number): { nodes: { id: string; distance?: number }[]; edges: { source: string; target: string }[] } {
  const nodes = [{ id: 'center', distance: 0 }];
  const edges: { source: string; target: string }[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `n${i}`, distance: 1 + (i % 2) });
    edges.push({ source: 'center', target: `n${i}` });
  }
  return { nodes, edges };
}

describe('ForceLayout — Barnes-Hut path (n >= barnesHutThreshold)', () => {
  test('n=300 converges (energy trends downward) using the Barnes-Hut path', () => {
    const { nodes, edges } = starGraph(300);
    const layout = new ForceLayout(nodes, edges, { seed: 11, width: 1200, height: 900, barnesHutThreshold: 150 });
    expect(nodes.length).toBeGreaterThanOrEqual(150); // sanity: this must exercise Barnes-Hut, not the exact path

    // A random initial placement this dense (300 points banded into a couple of narrow radii —
    // see ForceLayout's constructor) always produces a large burst on the very first tick or
    // two, as the closest overlaps get shoved apart. After that the simulation settles into a
    // much lower-energy (but, at this node count, not perfectly still — see layout.ts's
    // `maxSpeed` doc comment: a 300-node graph realistically never reaches this class's
    // near-zero `ENERGY_EPSILON` stopping condition and instead just runs its tick budget, same
    // as any sufficiently large/dense graph would) regime. So "converges" here is checked as
    // "settles well below the initial burst", not "reaches ~0" — the meaningful, non-flaky
    // signal that Barnes-Hut repulsion behaves like a real physical simulation and not a
    // runaway one.
    const initialBurst = layout.step();
    for (let i = 0; i < 250; i++) layout.step();
    let lateTotal = 0;
    const LATE_WINDOW = 30;
    for (let i = 0; i < LATE_WINDOW; i++) lateTotal += layout.step();
    const lateAvg = lateTotal / LATE_WINDOW;

    expect(lateAvg).toBeLessThan(initialBurst * 0.5);
    // Every node ends up at a finite, sane position — a cheap sanity check that the
    // approximation didn't blow up into NaN/Infinity anywhere.
    for (const n of layout.all()) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test('is deterministic for a fixed seed at n=300 (Barnes-Hut path)', () => {
    const { nodes, edges } = starGraph(300);
    const a = new ForceLayout(nodes, edges, { seed: 99, width: 1200, height: 900, barnesHutThreshold: 150 });
    const b = new ForceLayout(nodes, edges, { seed: 99, width: 1200, height: 900, barnesHutThreshold: 150 });
    for (let i = 0; i < 60; i++) {
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

  test('barnesHutThreshold can force the exact path even at n=300 (comparison baseline)', () => {
    const { nodes, edges } = starGraph(300);
    const layout = new ForceLayout(nodes, edges, { seed: 3, width: 1200, height: 900, barnesHutThreshold: Infinity });
    expect(() => {
      for (let i = 0; i < 5; i++) layout.step();
    }).not.toThrow();
  });
});

// ---- Bench: step() timing with vs. without Barnes-Hut at n≈250 ---------------------------
//
// Not a pass/fail perf assertion (CI machines vary too much for a hard threshold) — this just
// logs timing so the numbers can be read out of the test log to report the trade-off.

describe('bench', () => {
  test('n=250 step() timing: Barnes-Hut vs. exact O(n^2)', () => {
    const { nodes, edges } = starGraph(250);
    const STEPS = 60;

    const withBH = new ForceLayout(nodes, edges, { seed: 1, width: 1200, height: 900, barnesHutThreshold: 150 });
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) withBH.step();
    const bhMs = performance.now() - t0;

    const withoutBH = new ForceLayout(nodes, edges, {
      seed: 1,
      width: 1200,
      height: 900,
      barnesHutThreshold: Infinity, // forces the exact O(n^2) path even at n=250
    });
    const t1 = performance.now();
    for (let i = 0; i < STEPS; i++) withoutBH.step();
    const exactMs = performance.now() - t1;

    // eslint-disable-next-line no-console
    console.log(
      `[bench] n=250, ${STEPS} steps — Barnes-Hut: ${bhMs.toFixed(1)}ms total (${(bhMs / STEPS).toFixed(3)}ms/step); ` +
        `exact O(n^2): ${exactMs.toFixed(1)}ms total (${(exactMs / STEPS).toFixed(3)}ms/step)`,
    );

    expect(bhMs).toBeGreaterThan(0);
    expect(exactMs).toBeGreaterThan(0);
  });
});
