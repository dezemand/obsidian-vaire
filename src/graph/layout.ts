// A small, dependency-free force-directed layout, originally written for the local-graph view
// (a node's depth-2 neighborhood — realistically dozens to a couple hundred nodes, see the CLI
// samples in DESIGN.md's worked example) where all-pairs O(n^2) repulsion per tick is cheap and
// the caller is expected to stop ticking after ~300 iterations (DESIGN.md). No `obsidian`
// import — see DESIGN.md "Local graph" / "Implementation guidance".
//
// `feat/package-graph` (BRANCHES.md wave 7) reuses this same class for the whole-package
// "force" layout, which can run 150-300+ nodes (`packages/vaire` ~160, `acme-platform`
// ~250) — large enough that O(n^2) repulsion starts to cost real milliseconds per tick. Below
// `BARNES_HUT_THRESHOLD` nodes, `step()` still runs the original exact all-pairs loop
// unchanged (byte-identical behavior, so every existing test here keeps passing); at or above
// it, repulsion is computed via the Barnes–Hut quadtree approximation (src/graph/quadtree.ts,
// θ = `barnesHutTheta`, default 0.9) instead — same seeded PRNG, same jitter-on-coincidence
// fallback, so the simulation stays just as deterministic, just a different (approximate) sum
// once the exact one would be too slow to want.

import { barnesHutForce, buildQuadtree, type QPoint } from './quadtree';

export interface LayoutNodeInput {
  id: string;
  /** Hop distance from the center; biases initial placement radius. 0 = center. */
  distance?: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  distance: number;
}

export interface ForceLayoutOptions {
  width?: number;
  height?: number;
  /** Seeds the deterministic PRNG used for initial placement (and repulsion jitter at r≈0). */
  seed?: number;
  /** Rest length of an edge spring. */
  linkDistance?: number;
  /** Coulomb-like all-pairs repulsion strength. */
  charge?: number;
  /** Pull-to-center strength (keeps the graph from drifting off canvas). */
  centerStrength?: number;
  /** Spring stiffness toward `linkDistance`. */
  linkStrength?: number;
  /** Per-tick velocity damping, in (0, 1). */
  damping?: number;
  /** Node count at or above which repulsion switches from the exact O(n^2) sum to the
   *  Barnes–Hut approximation (src/graph/quadtree.ts). Default 800: measured in this JS
   *  runtime, quadtree build overhead makes Barnes–Hut *slower* than the exact sum at n=250
   *  (~0.25 vs ~0.15 ms/step) and it only wins from roughly n=700–1000 (n=1000: ~1.1 vs ~1.7 ms;
   *  n=2000: ~2.5 vs ~5.7 ms). Exposed so tests can force one path or the other at a given n. */
  barnesHutThreshold?: number;
  /** Barnes–Hut accuracy/speed knob (see quadtree.ts's module doc comment): 0 is exact
   *  (equivalent to the O(n^2) path, just slower), larger trades accuracy for speed. Default
   *  0.9, only consulted once `barnesHutThreshold` is reached. */
  barnesHutTheta?: number;
  /**
   * Per-tick velocity cap (world units/tick), applied after every force is summed but before
   * damping/integration. A defensive numerical-stability clamp: this plain Euler integrator has
   * no adaptive time-stepping, so a dense initial placement (many nodes landing close together —
   * increasingly likely as node count grows, since `linkDistance`-based placement radius doesn't
   * scale with node count) can otherwise produce a repulsion spike whose velocity compounds
   * every tick (damping < 1 slows it down, it doesn't undo an already-huge step) into
   * `Infinity`/`NaN` positions within a few dozen ticks — reproducible by running a few hundred
   * nodes' worth of the local-graph's own default charge with this clamp disabled. Default 420
   * (6x the default `linkDistance`), generous enough that it is essentially never reached by the
   * small, already-well-behaved graphs this class was originally tuned for (dozens of nodes —
   * see the module doc comment), only kicking in for the large whole-package "force" layout
   * (`feat/package-graph`) it's now also used for.
   */
  maxSpeed?: number;
}

type ResolvedOptions = Required<ForceLayoutOptions>;

const DEFAULTS: ResolvedOptions = {
  width: 600,
  height: 400,
  seed: 1,
  linkDistance: 70,
  charge: 1800,
  centerStrength: 0.02,
  linkStrength: 0.05,
  damping: 0.82,
  barnesHutThreshold: 800,
  barnesHutTheta: 0.9,
  maxSpeed: 420,
};

/** Deterministic 32-bit PRNG (mulberry32) — same seed always produces the same sequence,
 *  which is what makes initial placement (and therefore the whole simulation) reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A cheap iterative force simulation over a fixed node/edge set. Construct once per graph;
 * call `step()` repeatedly (the view drives this via `requestAnimationFrame`, stopping once
 * the returned energy is low or a tick budget is spent — see DESIGN.md). `pin`/`unpin` and
 * `setPosition` support node dragging without fighting the simulation.
 */
export class ForceLayout {
  private readonly opts: ResolvedOptions;
  private readonly nodes = new Map<string, LayoutNode>();
  private readonly edges: LayoutEdgeInput[];
  private readonly rng: () => number;

  constructor(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], options: ForceLayoutOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.rng = mulberry32(this.opts.seed);

    const cx = this.opts.width / 2;
    const cy = this.opts.height / 2;
    for (const n of nodes) {
      const distance = n.distance ?? 1;
      const angle = this.rng() * Math.PI * 2;
      const radius = distance <= 0 ? 0 : 20 + distance * 55 + this.rng() * 30;
      this.nodes.set(n.id, {
        id: n.id,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        pinned: false,
        distance,
      });
    }
    // Edges touching an id that wasn't in `nodes` are silently dropped — keeps the layout
    // robust against a caller passing a superset/mismatched edge list.
    this.edges = edges.filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
  }

  get(id: string): LayoutNode | undefined {
    return this.nodes.get(id);
  }

  all(): LayoutNode[] {
    return [...this.nodes.values()];
  }

  /** Fixes a node at its current (or given) position; the simulation will not move it. */
  pin(id: string, x?: number, y?: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.pinned = true;
    if (x != null) n.x = x;
    if (y != null) n.y = y;
    n.vx = 0;
    n.vy = 0;
  }

  unpin(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.pinned = false;
  }

  /** Moves a node directly (e.g. while dragging), zeroing its velocity either way. */
  setPosition(id: string, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.x = x;
    n.y = y;
    n.vx = 0;
    n.vy = 0;
  }

  /** Updates the canvas size used by the centering force (call on resize). */
  resize(width: number, height: number): void {
    this.opts.width = width;
    this.opts.height = height;
  }

  /**
   * Advances the simulation by one tick and returns the resulting total kinetic energy
   * (sum of squared velocities) — the caller's convergence signal: low and falling means the
   * layout has settled.
   */
  step(): number {
    const list = this.all();
    const {
      charge,
      linkDistance,
      linkStrength,
      centerStrength,
      damping,
      width,
      height,
      barnesHutThreshold,
      barnesHutTheta,
      maxSpeed,
    } = this.opts;
    const cx = width / 2;
    const cy = height / 2;

    if (list.length < barnesHutThreshold) {
      // Exact O(n^2) all-pairs repulsion — unchanged from before Barnes–Hut existed, and still
      // what runs for every graph small enough that the exact sum is cheap (see the module doc
      // comment: local-graph neighborhoods, and small package graphs).
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 0.01) {
            dx = (this.rng() - 0.5) * 0.1;
            dy = (this.rng() - 0.5) * 0.1;
            distSq = 0.01;
          }
          const dist = Math.sqrt(distSq);
          const force = charge / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!a.pinned) {
            a.vx += fx;
            a.vy += fy;
          }
          if (!b.pinned) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }
    } else {
      // Barnes–Hut approximation — see src/graph/quadtree.ts. Rebuilding the tree from scratch
      // every tick is deliberate: positions move every tick anyway, so there is no cheaper
      // "incremental update" to do instead.
      const points: QPoint[] = list.map((n) => ({ id: n.id, x: n.x, y: n.y }));
      const tree = buildQuadtree(points);
      for (const n of list) {
        if (n.pinned) continue;
        const { fx, fy } = barnesHutForce(tree, n.x, n.y, n.id, charge, barnesHutTheta, this.rng);
        n.vx += fx;
        n.vy += fy;
      }
    }

    for (const e of this.edges) {
      const a = this.nodes.get(e.source)!;
      const b = this.nodes.get(e.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = dist - linkDistance;
      const fx = (dx / dist) * diff * linkStrength;
      const fy = (dy / dist) * diff * linkStrength;
      if (!a.pinned) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.pinned) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const n of list) {
      if (n.pinned) continue;
      n.vx += (cx - n.x) * centerStrength;
      n.vy += (cy - n.y) * centerStrength;
    }

    let energy = 0;
    const maxSpeedSq = maxSpeed * maxSpeed;
    for (const n of list) {
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      // Clamp before damping so a would-be-explosive tick is capped at a bounded speed rather
      // than merely slowed down (see `maxSpeed`'s doc comment) — damping alone can't recover
      // from a single tick whose force sum was already huge.
      const speedSq = n.vx * n.vx + n.vy * n.vy;
      if (speedSq > maxSpeedSq) {
        const scale = maxSpeed / Math.sqrt(speedSq);
        n.vx *= scale;
        n.vy *= scale;
      }
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      energy += n.vx * n.vx + n.vy * n.vy;
    }
    return energy;
  }
}
