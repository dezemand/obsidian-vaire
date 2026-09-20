// Barnes–Hut quadtree approximation for the many-body (repulsion) pass of `ForceLayout`
// (src/graph/layout.ts). No `obsidian` import — pure, unit-tested in tests/quadtree.test.ts.
// See BRANCHES.md wave 7 (`feat/package-graph`): the whole-package "force" layout can run
// 150-300+ nodes, where the existing O(n^2) all-pairs repulsion (layout.ts's module doc
// explains why that was fine for a depth-2 local-graph neighborhood) starts to cost real
// milliseconds per tick. This module gives `layout.ts` an O(n log n) alternative for large
// graphs while leaving the exact O(n^2) path in place for small ones (see `BARNES_HUT_THRESHOLD`
// there) — same physics, same seeded determinism, just an approximation of the sum.
//
// Standard Barnes–Hut: recursively split the plane into quadrants until each leaf holds at
// most one distinct position; each internal node caches the center of mass and point count
// ("mass") of its subtree. To find the net repulsive force on a point, walk the tree: a
// subtree whose bounding box is small relative to its distance from the query point
// (width / distance < theta) is treated as a single mass at its center of mass — that's the
// approximation, and the only source of error. theta = 0 degenerates to the exact sum (every
// leaf is visited individually); larger theta trades accuracy for speed. theta = 0.9 (chosen by
// the caller) is a common default that keeps error well under the 10% tested in
// tests/quadtree.test.ts for the force magnitudes this module actually computes.

export interface QPoint {
  id: string;
  x: number;
  y: number;
}

export interface Force {
  fx: number;
  fy: number;
}

interface LeafNode {
  kind: 'leaf';
  points: QPoint[];
}

interface InternalNode {
  kind: 'internal';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Center of mass of every point in this subtree. */
  cx: number;
  cy: number;
  /** Point count in this subtree — each point contributes mass 1, mirroring the O(n^2) path's
   *  uniform `charge` per node (see layout.ts's repulsion loop). */
  mass: number;
  children: [QuadNode, QuadNode, QuadNode, QuadNode];
}

export type QuadNode = LeafNode | InternalNode;

/** Below this box width, further subdivision can't meaningfully separate two positions (and
 *  would otherwise recurse without making progress for near-duplicate coordinates). */
const MIN_BOX_WIDTH = 1e-6;
/** Safety net against pathological inputs; standard Barnes-Hut trees for realistic graphs never
 *  get remotely this deep (log4 of even 100k evenly spread points is ~8). */
const MAX_DEPTH = 32;

function quadrantOf(p: QPoint, mx: number, my: number): 0 | 1 | 2 | 3 {
  const right = p.x >= mx ? 1 : 0;
  const bottom = p.y >= my ? 1 : 0;
  return (bottom * 2 + right) as 0 | 1 | 2 | 3;
}

function bounds(points: readonly QPoint[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  // A zero-area box (one point, or every point coincident) still needs a non-degenerate
  // quadrant to split around; pad it a little.
  if (x1 - x0 < MIN_BOX_WIDTH) {
    x0 -= 1;
    x1 += 1;
  }
  if (y1 - y0 < MIN_BOX_WIDTH) {
    y0 -= 1;
    y1 += 1;
  }
  return { x0, y0, x1, y1 };
}

function centerOfMass(points: readonly QPoint[]): { cx: number; cy: number } {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { cx: sx / points.length, cy: sy / points.length };
}

function build(points: QPoint[], x0: number, y0: number, x1: number, y1: number, depth: number): QuadNode {
  if (points.length <= 1 || x1 - x0 < MIN_BOX_WIDTH || y1 - y0 < MIN_BOX_WIDTH || depth >= MAX_DEPTH) {
    return { kind: 'leaf', points };
  }

  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const buckets: [QPoint[], QPoint[], QPoint[], QPoint[]] = [[], [], [], []];
  for (const p of points) buckets[quadrantOf(p, mx, my)].push(p);

  // If every point landed in the same quadrant, subdividing again won't separate them (e.g.
  // exact duplicate coordinates) — stop here rather than recursing to `MAX_DEPTH` for nothing.
  if (buckets.filter((b) => b.length > 0).length <= 1) {
    return { kind: 'leaf', points };
  }

  const { cx, cy } = centerOfMass(points);
  const childBounds: Array<[number, number, number, number]> = [
    [x0, y0, mx, my],
    [mx, y0, x1, my],
    [x0, my, mx, y1],
    [mx, my, x1, y1],
  ];
  const children = buckets.map((bucket, i) => {
    const [cx0, cy0, cx1, cy1] = childBounds[i];
    return build(bucket, cx0, cy0, cx1, cy1, depth + 1);
  }) as [QuadNode, QuadNode, QuadNode, QuadNode];

  return { kind: 'internal', x0, y0, x1, y1, cx, cy, mass: points.length, children };
}

/** Builds a Barnes–Hut tree over `points`. `null` for an empty input. Rebuilt fresh from
 *  scratch each call — `ForceLayout.step()` calls this once per tick since positions move every
 *  tick anyway, so there is no incremental-update path to maintain. */
export function buildQuadtree(points: QPoint[]): QuadNode | null {
  if (points.length === 0) return null;
  const { x0, y0, x1, y1 } = bounds(points);
  return build(points, x0, y0, x1, y1, 0);
}

/** Exact (O(n) in the size of `points`) Coulomb-like repulsion on `(qx, qy)` from every point in
 *  `points` except `excludeId`, matching `ForceLayout`'s O(n^2) pairwise formula
 *  (`force = charge / distSq`) exactly — including its near-zero-distance jitter fallback, via
 *  `rng`, so a caller comparing this against `barnesHutForce` for the same query gets an
 *  apples-to-apples number. Exported mainly for tests/quadtree.test.ts's accuracy comparison,
 *  but also usable directly as the "theta = 0" reference implementation. */
export function exactForce(
  points: readonly QPoint[],
  qx: number,
  qy: number,
  excludeId: string,
  charge: number,
  rng: () => number = Math.random,
): Force {
  let fx = 0;
  let fy = 0;
  for (const p of points) {
    if (p.id === excludeId) continue;
    let dx = qx - p.x;
    let dy = qy - p.y;
    let distSq = dx * dx + dy * dy;
    if (distSq < 0.01) {
      dx = (rng() - 0.5) * 0.1;
      dy = (rng() - 0.5) * 0.1;
      distSq = 0.01;
    }
    const dist = Math.sqrt(distSq);
    const f = charge / distSq;
    fx += (dx / dist) * f;
    fy += (dy / dist) * f;
  }
  return { fx, fy };
}

function accumulate(
  node: QuadNode,
  qx: number,
  qy: number,
  excludeId: string,
  charge: number,
  theta: number,
  rng: () => number,
  out: Force,
): void {
  if (node.kind === 'leaf') {
    for (const p of node.points) {
      if (p.id === excludeId) continue;
      let dx = qx - p.x;
      let dy = qy - p.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        dx = (rng() - 0.5) * 0.1;
        dy = (rng() - 0.5) * 0.1;
        distSq = 0.01;
      }
      const dist = Math.sqrt(distSq);
      const f = charge / distSq;
      out.fx += (dx / dist) * f;
      out.fy += (dy / dist) * f;
    }
    return;
  }

  const dx = qx - node.cx;
  const dy = qy - node.cy;
  const distSq = dx * dx + dy * dy;
  const width = node.x1 - node.x0;

  // `width / dist < theta` without an eager sqrt: `width^2 < theta^2 * distSq`. When
  // `distSq === 0` (the query point sits exactly on this subtree's center of mass — only
  // possible while it still has siblings to recurse into, since a leaf containing itself is
  // handled above) the inequality is false for any positive width, so this correctly falls
  // through to recursing into the children instead of dividing by zero.
  if (distSq > 0 && width * width < theta * theta * distSq) {
    const dist = Math.sqrt(distSq);
    const f = (charge * node.mass) / distSq;
    out.fx += (dx / dist) * f;
    out.fy += (dy / dist) * f;
    return;
  }

  for (const child of node.children) accumulate(child, qx, qy, excludeId, charge, theta, rng, out);
}

/**
 * The Barnes–Hut-approximated net repulsion on `(qx, qy)` from every point in `tree` except
 * `excludeId` (so a point can query the force acting on itself without self-repulsion). `rng`
 * supplies the same near-zero-distance jitter `ForceLayout`'s exact path uses, so two distinct
 * points that end up exactly coincident don't produce a division by zero or an infinite force.
 * `tree === null` (an empty point set) returns zero force.
 */
export function barnesHutForce(
  tree: QuadNode | null,
  qx: number,
  qy: number,
  excludeId: string,
  charge: number,
  theta: number,
  rng: () => number = Math.random,
): Force {
  const out: Force = { fx: 0, fy: 0 };
  if (!tree) return out;
  accumulate(tree, qx, qy, excludeId, charge, theta, rng, out);
  return out;
}
