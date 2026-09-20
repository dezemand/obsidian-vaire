// Pure helpers for the graph view's canvas rendering and pan/zoom math — no `obsidian` import,
// mirrors the `pure.ts` convention used by the other feature passes (src/render/pure.ts,
// src/views/pure-pkg.ts, src/suggest/pure.ts).

/** Deterministic djb2-ish string hash, folded into [0, 360) — used for the type-color hue so
 *  the same type slug always gets the same color across reloads and sessions. */
export function hashHue(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return Math.abs(hash) % 360;
}

/** `hsl(...)` fill for a type slug's node color. Fixed saturation/lightness read reasonably
 *  on both light and dark themes without needing per-theme tuning. */
export function typeColor(type: string): string {
  return `hsl(${hashHue(type)}, 62%, 52%)`;
}

export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

/** World (layout) coordinates -> screen (canvas CSS pixel) coordinates. */
export function worldToScreen(x: number, y: number, vp: Viewport): { x: number; y: number } {
  return { x: x * vp.zoom + vp.panX, y: y * vp.zoom + vp.panY };
}

/** Inverse of `worldToScreen`. */
export function screenToWorld(x: number, y: number, vp: Viewport): { x: number; y: number } {
  return { x: (x - vp.panX) / vp.zoom, y: (y - vp.panY) / vp.zoom };
}

/** Recomputes {panX, panY} so the world point under `(screenX, screenY)` stays put while the
 *  zoom level changes from `vp.zoom` to `nextZoom` — the standard "zoom toward the cursor" feel. */
export function zoomAt(screenX: number, screenY: number, nextZoom: number, vp: Viewport): Viewport {
  const world = screenToWorld(screenX, screenY, vp);
  return {
    zoom: nextZoom,
    panX: screenX - world.x * nextZoom,
    panY: screenY - world.y * nextZoom,
  };
}

/** Clamps a proposed zoom factor multiplication to the usable range. */
export function clampZoom(zoom: number, min = 0.2, max = 3): number {
  return Math.min(max, Math.max(min, zoom));
}

/** Euclidean distance from `(px, py)` to `(x, y)`, for node hit-testing. */
export function distance(px: number, py: number, x: number, y: number): number {
  return Math.hypot(px - x, py - y);
}

/** Radius (in world/CSS px) a node circle is drawn at: the center node is largest, otherwise
 *  shrinking gently with hop distance, floored so far nodes stay clickable. */
export function nodeRadius(isCenter: boolean, distance: number): number {
  if (isCenter) return 14;
  return Math.max(6, 10 - (distance - 1) * 1.5);
}

/** Folds a string into a positive 32-bit seed for `ForceLayout`'s deterministic PRNG, so the
 *  same center node always starts from the same initial layout — both in the interactive graph
 *  view and in a canvas export (see graph-view.ts and export.ts). */
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}
