// Type badge colouring (feat/type-colors). Resolves one colour per type slug seen across the
// vault's packages and applies it as an inline `--vaire-type-color` custom property on the
// element carrying the `vaire-type-<t>` class, so `.vaire-type-<t>` elements (id refs, the node
// header badge, the node panel badge — see styles/00-base.css and styles/20-render.css) pick up
// a colour without any of them having to know where it came from. See BRANCHES.md
// `feat/type-colors` and `src/theme/families.ts` for the two colouring strategies this switches
// between.
//
// Colours are applied at the point each element is built (`applyTypeColor`, called by every
// render site that adds a `vaire-type-<t>` class) and re-applied to every such element already
// on screen:
//  - on `'settings-changed'` (the source, or a package's `vaire-renderer.toml`-derived colours,
//    may have changed);
//  - on `'renderer-config-changed'` (src/packages.ts — a package's `vaire-renderer.toml` was
//    created or modified);
//  - on `'local-index-rebuilt'` (src/packages.ts — fired once after Obsidian's metadata cache
//    reports `'resolved'` on a cold start; closes the gap where the very first elements built
//    before `PackageRegistry.init()`'s async manifest reads have populated `plugin.packages`
//    would otherwise stay uncoloured).
//
// Unlike the CSS-injection approach this replaces, an inline custom property is set directly on
// each element rather than a generated `<style>` sheet in `document.head` — Obsidian's
// plugin-review guidelines disallow creating/attaching style elements at runtime. `source: 'off'`
// (or no colour resolving for a type) removes the inline property instead of setting a neutral
// one — `.vaire-type-<t>` elements then fall back to plain CSS (`var(--vaire-type-color,
// inherit)`), i.e. today's neutral badge.

import type { PackageInfo } from '../packages';
import type VairePlugin from '../main';
import { colorFor, type TypeColorConfig, type TypeColorSource } from './families';

const TYPE_COLOR_PROPERTY = '--vaire-type-color';

/** Every type slug actually seen in `pkg`: declared in `knowledge.toml`'s `types` and/or
 *  actually carried by an indexed node — the union, since either source alone can be
 *  incomplete (a stale/hand-written manifest; a type nobody has authored a node of yet). */
function typesOf(pkg: PackageInfo): string[] {
  const set = new Set<string>(pkg.types);
  for (const type of pkg.index.byType().keys()) set.add(type);
  return [...set];
}

/** Which theme (light/dark) is currently active, per Obsidian's own `body.theme-dark` class
 *  (see `app.js`'s `setTheme`) — mirrors the `body:not(.theme-dark)` / `body.theme-dark`
 *  selectors the generated stylesheet used before this module switched to inline colours. */
function activeScheme(): 'light' | 'dark' {
  return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}

/**
 * The colour for `type`, resolving `plugin.settings.typeColorSource` and the per-package
 * `vaire-renderer.toml` exactly as the generated stylesheet did: the first package (in
 * `plugin.packages.all()` order) whose declared/indexed types include `type` supplies the
 * `vaire-renderer.toml` config used to colour it — "first package wins" when a type appears in
 * more than one package. Returns `null` for `source: 'off'`, or when no package claims `type`.
 */
export function typeColorFor(plugin: VairePlugin, type: string): string | null {
  const source: TypeColorSource = plugin.settings.typeColorSource;
  if (source === 'off') return null;

  for (const pkg of plugin.packages.all()) {
    if (!typesOf(pkg).includes(type)) continue;
    const config: TypeColorConfig = { source, renderer: pkg.rendererConfig };
    return colorFor(type, config, activeScheme());
  }
  return null;
}

/**
 * Sets (or, when no colour resolves, removes) the inline `--vaire-type-color` custom property
 * on `el`. Call this wherever an element gets a `vaire-type-<t>` class, right after adding it.
 * Accepts `SVGElement` too (both interfaces expose `.style`) — a diagram's `<a>` is really an
 * `SVGAElement` (see src/render/diagrams.ts).
 */
export function applyTypeColor(plugin: VairePlugin, el: HTMLElement | SVGElement, type: string): void {
  const color = typeColorFor(plugin, type);
  if (color) el.style.setProperty(TYPE_COLOR_PROPERTY, color);
  else el.style.removeProperty(TYPE_COLOR_PROPERTY);
}

/** Every type-class the classList carries `vaire-type-<t>` under — normally exactly one, but
 *  tolerant of more (there is no rule against combining classes). */
function typesFromClassList(el: Element): string[] {
  const types: string[] = [];
  for (const cls of el.classList) {
    if (cls.startsWith('vaire-type-')) types.push(cls.slice('vaire-type-'.length));
  }
  return types;
}

/**
 * Re-applies colours to every `vaire-type-<t>` element currently in the DOM — used instead of
 * rebuilding a stylesheet when the source, a renderer config, or the index changes. Elements
 * created afterwards get their colour from the `applyTypeColor` call each render site already
 * makes; this only refreshes what's already on screen.
 */
function refreshVisibleTypeColors(plugin: VairePlugin): void {
  const els = document.querySelectorAll('[data-vaire-type], [class*="vaire-type-"]');
  for (const el of els) {
    if (!(el.instanceOf(HTMLElement) || el.instanceOf(SVGElement))) continue;
    const type = el.dataset.vaireType ?? typesFromClassList(el)[0];
    if (type) applyTypeColor(plugin, el, type);
  }
}

export function registerTypeColors(plugin: VairePlugin): void {
  const refresh = (): void => refreshVisibleTypeColors(plugin);

  plugin.app.workspace.onLayoutReady(refresh);
  plugin.registerEvent(plugin.events.on('settings-changed', refresh));
  plugin.registerEvent(plugin.events.on('renderer-config-changed', refresh));
  plugin.registerEvent(plugin.events.on('local-index-rebuilt', refresh));
}
