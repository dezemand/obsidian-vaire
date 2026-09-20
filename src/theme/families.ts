// Type → colour assignment. Pure functions, no `obsidian` import, so this stays unit
// testable in plain `bun test` (see tests/families.test.ts). See BRANCHES.md `feat/type-colors`
// and renderer-conventions.md §4 for the trade-off and the reference implementation this
// ports: `vaire-renderer/src/frontend/mod.rs` (`BUILTIN_FAMILIES`, `BUILTIN_TYPES`,
// `FamilyMap::family_of`) and `vaire-renderer/src/config.rs` (`FamilyColor::validate`).
//
// Two independent colouring strategies, both implemented here and switched by
// `settings.typeColorSource` (src/theme/index.ts owns the switch + CSS injection):
//   - 'renderer': `familyOf` + `colorFor` with a package's parsed `vaire-renderer.toml`
//     (`parseRendererToml`) layered over the renderer's own built-in family table/colours,
//     so an unlisted type falls back to the renderer's deterministic FNV-hash family
//     assignment (`familyOfHash` below) — ported byte-for-byte from `FamilyMap::family_of`.
//   - 'hash': `hashHue`, a small standalone hue hash needing no config at all.

import { parse as parseToml } from 'smol-toml';

// ---- Renderer's built-in design (ported verbatim from vaire-renderer/src/frontend/mod.rs) ----

/** A family's colour in each theme. Mirrors the renderer's `Family`/`FamilyColor`. */
export interface FamilyColor {
  light: string;
  dark: string;
}

/**
 * The renderer's six built-in families ("who/what/how/when/why/where"), in the exact
 * declaration order of `BUILTIN_FAMILIES` (mod.rs) — order matters because the FNV-hash
 * fallback (`familyOfHash`) indexes into this same array by `hash % 6`.
 */
export const FAMILY_ORDER = ['who', 'what', 'how', 'when', 'why', 'where'] as const;
export type BuiltinFamily = (typeof FAMILY_ORDER)[number];

/** `BUILTIN_FAMILIES` colours (mod.rs:90-97), copied verbatim. */
export const BUILTIN_FAMILY_COLORS: Record<BuiltinFamily, FamilyColor> = {
  who: { light: '#2c5fb3', dark: '#86abe6' },
  what: { light: '#1f7a8c', dark: '#52b4c2' },
  how: { light: '#6d4fb0', dark: '#b69ae8' },
  when: { light: '#5b626b', dark: '#98a0aa' },
  why: { light: '#b0394a', dark: '#e89aa0' },
  where: { light: '#b5722a', dark: '#e0a86a' },
};

/**
 * `BUILTIN_TYPES` (mod.rs:102-121), flattened from "family → space-separated types" into
 * "type → family" for direct lookup. Copied verbatim, including the exact type list per
 * family.
 */
export const BUILTIN_TYPE_FAMILIES: Record<string, BuiltinFamily> = {};
{
  const table: Record<BuiltinFamily, string> = {
    who: 'person department team vendor role org forum contact group',
    what:
      'system service dataset application tool component cluster server vm network ' +
      'network-device ot-asset dns-record certificate service-account aws-account ' +
      'aws-resource',
    how:
      'method standard policy process principle guide pattern capability ' +
      'firewall-policy term type',
    when: 'record incident release event meeting',
    why: 'decision goal risk requirement proposal',
    where: 'project environment site location program',
  };
  for (const family of FAMILY_ORDER) {
    for (const type of table[family].split(/\s+/)) {
      BUILTIN_TYPE_FAMILIES[type] = family;
    }
  }
}

// ---- `vaire-renderer.toml` parsing (`[families]` + `[family_colors]`) -------------------

/** What a package's `vaire-renderer.toml` contributes to type colouring; both tolerant of
 *  a missing/partial/malformed file — an absent section just means "nothing configured". */
export interface RendererFamilyConfig {
  /** Family name → the entity types assigned to it (`[families]`), e.g. `why: ["decision"]`. */
  families: Record<string, string[]>;
  /** Family name → its light/dark colour (`[family_colors]`), overriding or defining a family. */
  familyColors: Record<string, FamilyColor>;
}

const EMPTY_RENDERER_CONFIG: RendererFamilyConfig = { families: {}, familyColors: {} };

/** `#rgb` or `#rrggbb`, matching `FamilyColor::validate` (config.rs:87-101). */
function isHexColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const hex = value.startsWith('#') ? value.slice(1) : null;
  return !!hex && (hex.length === 3 || hex.length === 6) && /^[0-9a-fA-F]+$/.test(hex);
}

/**
 * Parses a `vaire-renderer.toml`'s `[families]` and `[family_colors]` tables. Tolerant of
 * empty text, a missing/malformed table, or a table with the wrong shape — those just
 * contribute nothing, they never throw. An invalid `smol-toml` parse also degrades to
 * "nothing configured" rather than throwing, since a broken renderer config shouldn't
 * crash type colouring in the editor.
 */
export function parseRendererToml(text: string): RendererFamilyConfig {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text);
  } catch {
    return EMPTY_RENDERER_CONFIG;
  }
  if (!data || typeof data !== 'object') return EMPTY_RENDERER_CONFIG;

  const families: Record<string, string[]> = {};
  const familiesRaw = data.families;
  if (familiesRaw && typeof familiesRaw === 'object') {
    for (const [family, types] of Object.entries(familiesRaw as Record<string, unknown>)) {
      if (!Array.isArray(types)) continue;
      const list = types.filter((t): t is string => typeof t === 'string');
      if (list.length) families[family] = list;
    }
  }

  const familyColors: Record<string, FamilyColor> = {};
  const colorsRaw = data.family_colors;
  if (colorsRaw && typeof colorsRaw === 'object') {
    for (const [family, value] of Object.entries(colorsRaw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const light = (value as Record<string, unknown>).light;
      const dark = (value as Record<string, unknown>).dark;
      if (isHexColor(light) && isHexColor(dark)) familyColors[family] = { light, dark };
    }
  }

  return { families, familyColors };
}

// ---- Family assignment: configured → built-in → deterministic FNV-hash fallback --------

/**
 * FNV-1a, 32-bit (offset basis `2166136261` / `0x811c9dc5`, prime `16777619`), over the
 * type slug's UTF-8 bytes — ported byte-for-byte from `FamilyMap::family_of` (mod.rs:
 * 206-216):
 * ```rust
 * let mut h: u32 = 2166136261;
 * for b in node_type.bytes() {
 *     h ^= b as u32;
 *     h = h.wrapping_mul(16777619);
 * }
 * &self.families[(h as usize) % BUILTIN_FAMILIES.len()]
 * ```
 * `Math.imul` gives the same wrapping 32-bit multiply as Rust's `wrapping_mul` on `u32`;
 * the final `>>> 0` turns the possibly-negative `Math.imul` result back into the unsigned
 * 32-bit value the modulo needs (JS `%` on a negative number keeps the sign, Rust's `u32`
 * modulo never goes negative).
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5; // 2166136261
  const bytes = new TextEncoder().encode(input); // UTF-8, matching Rust's `str::bytes()`
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The deterministic hash fallback alone (`FamilyMap::family_of`'s tail, when `node_type`
 * isn't in `assigned`): stable across runs, arbitrary but consistent — ports the exact
 * hash and the exact `% 6` indexing into `FAMILY_ORDER`.
 */
export function familyOfHash(type: string): BuiltinFamily {
  return FAMILY_ORDER[fnv1a32(type) % FAMILY_ORDER.length];
}

/**
 * The family a type belongs to: `config.families` (from a package's `vaire-renderer.toml`,
 * configured assignments win — mirrors "Configured assignments win over the built-ins",
 * mod.rs:183) → the renderer's built-in table → the deterministic FNV-hash fallback so an
 * unknown type always gets *a* family rather than none (mirrors `family_of`, mod.rs:204-216).
 */
export function familyOf(type: string, config?: Pick<RendererFamilyConfig, 'families'>): string {
  if (config?.families) {
    for (const [family, types] of Object.entries(config.families)) {
      if (types.includes(type)) return family;
    }
  }
  const builtin = BUILTIN_TYPE_FAMILIES[type];
  if (builtin) return builtin;
  return familyOfHash(type);
}

// ---- 'hash' strategy: a small standalone hue hash, no config at all ---------------------

/**
 * A simple, small hash over the type slug's char codes, reduced to a hue in `[0, 360)`.
 * Deliberately independent of `fnv1a32`/`familyOf` above — the 'hash' colour strategy exists
 * precisely so a type gets *some* stable colour with zero configuration (no package, no
 * `vaire-renderer.toml`, no built-in table to consult).
 */
export function hashHue(type: string): number {
  let h = 5381; // djb2-style seed; the exact constant doesn't matter, only that it's fixed
  for (let i = 0; i < type.length; i++) {
    h = (Math.imul(h, 33) + type.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Minimal HSL → `#rrggbb` conversion (no library needed for three components). */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** A stable colour for `type` from the hue hash alone — saturated and readable in either
 *  theme without needing the family table (lighter/less saturated for dark backgrounds,
 *  darker/more saturated for light ones, same shape as the renderer's own light/dark pairs). */
function hashColor(type: string, scheme: 'light' | 'dark'): string {
  const hue = hashHue(type);
  return scheme === 'dark' ? hslToHex(hue, 0.55, 0.72) : hslToHex(hue, 0.55, 0.38);
}

// ---- Public colour lookup, switched by strategy ------------------------------------------

export type TypeColorSource = 'renderer' | 'hash' | 'off';

export interface TypeColorConfig {
  source: TypeColorSource;
  /** The owning package's parsed `vaire-renderer.toml`, if any — only consulted when
   *  `source === 'renderer'`. */
  renderer?: RendererFamilyConfig;
}

/** A neutral grey, used only as `colorFor`'s answer when there's nothing better to say
 *  (source `'off'`, called directly rather than through `src/theme/index.ts`, which never
 *  injects a stylesheet at all for `'off'` — see that module's doc comment). */
const NEUTRAL_COLOR = '#888888';

/**
 * The colour for `type` in `scheme`, per `config.source`:
 *  - `'off'`: always the neutral grey (in normal operation `src/theme/index.ts` never calls
 *    this for `'off'` — no stylesheet is injected at all, so CSS's own neutral fallback
 *    (`color: var(--vaire-type-color, inherit)`) applies instead).
 *  - `'hash'`: `hashHue`-derived colour, no config needed.
 *  - `'renderer'`: `familyOf(type, config.renderer)`'s family, coloured by
 *    `config.renderer.familyColors` (a package's `[family_colors]`) if it defines that
 *    family, else the renderer's built-in colour for that family, else (a family that is
 *    neither built-in nor coloured by the config — configuration the real renderer would
 *    reject outright, cf. mod.rs:183-192) the hash colour, so this never fails to return a
 *    valid colour.
 */
export function colorFor(type: string, config: TypeColorConfig, scheme: 'light' | 'dark'): string {
  if (config.source === 'off') return NEUTRAL_COLOR;
  if (config.source === 'hash') return hashColor(type, scheme);

  const family = familyOf(type, config.renderer);
  const configured = config.renderer?.familyColors?.[family];
  if (configured) return configured[scheme];
  const builtin = BUILTIN_FAMILY_COLORS[family as BuiltinFamily];
  if (builtin) return builtin[scheme];
  return hashColor(type, scheme);
}
