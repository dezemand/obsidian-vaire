// The one place a Vairë reference becomes a DOM element. Used by the reading-mode post
// processor, the node header, the node panel, the package view and the external view, so
// every reference looks and behaves the same everywhere. See DESIGN.md "Rendering
// conventions" and the "Phase 2 ownership" shared-contract note.
//
// Resolution order (per DESIGN.md "Local index" + "Rendering conventions"):
//   1. No `@pkg` and `opts.repo` is a vault package -> LocalIndex.get(ref.local).
//   2. `@pkg` and that package is itself a vault package -> LocalIndex.get on *its* index
//      (opened directly, not treated as "external" — it lives in this vault).
//   3. Otherwise -> `plugin.resolveViaCli(opts.repo, ref.full)`, resolved asynchronously;
//      the element is returned synchronously in a "pending" state and patched in place.
//
// Exactly one of the state classes `vaire-link-external` / `vaire-link-unlinked` /
// `vaire-link-missing` / `vaire-link-pending` is ever applied at a time (a fully resolved
// local/CLI hit gets none of them, just `vaire-link vaire-type-<type>`).

import { VaireError, resolveMemoKey } from '../cli';
import type { IdRef, LooseRef, VaireRef } from '../ids';
import { resolveLocalRef, type LocalNode } from '../packages';
import { openRef } from '../navigate';
import type { ResolveResult } from '../types';
import type VairePlugin from '../main';
import { applyTypeColor } from '../theme/index';
import {
  externalTooltip,
  localTooltip,
  looseTooltip,
  missingTooltip,
  nameFromResolveResult,
  unlinkedTooltip,
} from './pure';

export interface RefElementOptions {
  /** Absolute root of the package the reference is written in (resolution context). */
  repo: string;
  /** Author-supplied display text (`[[id|Display]]`); otherwise the node's name is used. */
  display?: string;
  /** Element to reuse (e.g. an existing `a.internal-link`); a new `a`/`span` is created otherwise. */
  reuse?: HTMLElement;
  /** Open in a new leaf on click. */
  newLeaf?: boolean;
  /**
   * The scope (`ctype:cid`) of the node this reference is *written in*, i.e.
   * `pkg.index.byFile(originFile)?.scope` — enables scope-first resolution of a bare
   * `[[type:local]]` against `<originScope>/type:local` before falling back to the global
   * `type:local` (see `resolveLocalRef`, src/packages.ts, and DESIGN.md "Reference grammar").
   * Omit when the origin node is unscoped or unknown.
   */
  originScope?: string;
}

const STATE_CLASSES = ['vaire-link-external', 'vaire-link-unlinked', 'vaire-link-missing', 'vaire-link-pending'];

/**
 * Returns an element that renders `ref` per DESIGN.md "Rendering conventions": resolved
 * display name, type badge, tooltip, state classes and a click handler that routes through
 * `openRef`. Resolution may be async: the element is returned immediately with the
 * best-known text and updated in place when the lookup finishes.
 */
export function createRefElement(plugin: VairePlugin, ref: VaireRef, opts: RefElementOptions): HTMLElement {
  if (ref.kind === 'loose') return renderLoose(plugin, ref, opts);

  const el = ensureAnchor(opts.reuse);
  const local = resolveLocalSync(plugin, ref, opts.repo, opts.originScope);
  if (local) {
    renderLocal(plugin, el, ref, opts, local);
    return el;
  }

  renderPending(plugin, el, ref, opts);
  registerForRevalidation(opts.repo, ref, opts, el);
  void settleAsync(plugin, el, ref, opts);
  return el;
}

// ---- element setup -------------------------------------------------------------------

function ensureAnchor(reuse?: HTMLElement): HTMLAnchorElement {
  if (reuse instanceof HTMLAnchorElement) return reuse;
  if (reuse) {
    const a = createEl('a');
    reuse.replaceWith(a);
    return a;
  }
  return createEl('a');
}

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Resets classes/attributes/text shared by every id-ref state; called at the top of each render. */
function resetBase(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions): void {
  el.classList.remove('is-unresolved', ...STATE_CLASSES);
  el.classList.add('vaire-link', `vaire-type-${ref.type}`);
  applyTypeColor(plugin, el, ref.type);
  el.dataset.vaireRef = ref.full;
  el.dataset.vaireType = ref.type;
  // The resolution root this element was rendered against — read back by the hover-preview
  // feature (src/render/preview-data.ts) so it can look the reference up again without having
  // to re-derive the context (vault package vs. external-view dependency root) from the DOM.
  el.dataset.vaireRepo = opts.repo;
  if (ref.pkg) el.dataset.vairePkg = ref.pkg;
  else delete el.dataset.vairePkg;
  // Drop whatever href/data-href the reused anchor came in with (Obsidian's raw, unresolved
  // ref text, not a real vault path) — only a genuine local hit sets these back below, so
  // Obsidian's own hover-preview/drag-drop never tries to resolve a `type:id`-shaped "path".
  el.removeAttribute('href');
  delete el.dataset.href;
  clearChildren(el);
}

function setTooltip(el: HTMLElement, text: string): void {
  el.title = text;
  el.setAttribute('aria-label', text);
}

// ---- local (synchronous) resolution ---------------------------------------------------

/**
 * Vault-local resolution for `ref` seen from resolution root `repo`, honoring `originScope`
 * for scope-first resolution of a bare `[[type:local]]` (per DESIGN.md's resolution order
 * above and `resolveLocalRef`'s doc comment). Exported so `src/render/preview-data.ts`
 * (hover-preview feature) can reuse the exact same local-vs-CLI split rather than
 * re-deriving it — the popover doesn't currently know the origin scope (only `repo` is
 * carried on `data-vaire-repo`), so it calls this with `originScope` omitted.
 */
export function resolveLocalSync(plugin: VairePlugin, ref: IdRef, repo: string, originScope?: string): LocalNode | null {
  if (!ref.pkg) {
    const originPkg = plugin.packages.all().find((p) => p.absRoot === repo);
    return originPkg ? resolveLocalRef(originPkg, ref, originScope) : null;
  }
  // A `@pkg/…` ref whose package happens to be indexed in this vault too (a linked dependency
  // that is itself a package root) resolves the same scope-first-then-global way — see
  // DESIGN.md "Reference grammar" and `resolveLocalRef`'s doc comment.
  const pkg = plugin.packages.byName(ref.pkg);
  return pkg ? resolveLocalRef(pkg, ref, originScope) : null;
}

function renderLocal(
  plugin: VairePlugin,
  el: HTMLAnchorElement,
  ref: IdRef,
  opts: RefElementOptions,
  node: LocalNode,
): void {
  resetBase(plugin, el, ref, opts);
  const text = opts.display ?? node.name;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, localTooltip(ref.full, node.name));

  const isReadingReuse = el === opts.reuse && el.classList.contains('internal-link');
  if (isReadingReuse) {
    // Let Obsidian's own click handling + hover-preview take over. If an earlier render of
    // this same element went through the CLI-pending path first (e.g. the local index hadn't
    // caught up yet on a previous postprocessor pass) and bound its own click handler, that
    // handler must be removed here — otherwise it fires alongside Obsidian's native handling.
    clearBoundClick(el);
    el.dataset.href = node.file.path;
    el.setAttribute('href', node.file.path);
  } else {
    bindClick(plugin, el, ref, opts);
  }
}

// ---- CLI-backed (asynchronous) resolution ----------------------------------------------

function renderPending(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions): void {
  resetBase(plugin, el, ref, opts);
  el.classList.add('vaire-link-pending');
  const text = opts.display ?? ref.full;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, ref.full);
  // Bound once, while pending; a local hit never reaches this path, so the handler is never
  // superseded by Obsidian's own href-based handling later.
  bindClick(plugin, el, ref, opts);
}

async function settleAsync(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions): Promise<void> {
  try {
    const result = await plugin.resolveViaCli(opts.repo, ref.full);
    if (result === null) {
      renderMissing(plugin, el, ref, opts);
      return;
    }
    renderResolved(plugin, el, ref, opts, result);
  } catch (err) {
    if (err instanceof VaireError && err.kind === 'dependency') {
      renderUnlinked(plugin, el, ref, opts);
    } else {
      renderMissing(plugin, el, ref, opts, errMessage(err));
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderResolved(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions, result: ResolveResult): void {
  resetBase(plugin, el, ref, opts);
  const name = nameFromResolveResult(result, ref.full);
  const external = !!ref.pkg; // by construction: only reached here when pkg is absent (same-package
  // fallback) or present-and-not-a-vault-package (a genuine dependency).
  if (external) el.classList.add('vaire-link-external');
  const text = opts.display ?? name;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, external ? externalTooltip(ref.full, name, ref.pkg as string) : localTooltip(ref.full, name));
}

function renderUnlinked(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions): void {
  resetBase(plugin, el, ref, opts);
  el.classList.add('vaire-link-unlinked');
  el.createEl('span', { cls: 'vaire-pkg-pill', text: `@${ref.pkg ?? ''}` });
  const text = opts.display ?? ref.local;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, unlinkedTooltip(ref.full, ref.pkg ?? ''));
}

function renderMissing(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions, message?: string): void {
  resetBase(plugin, el, ref, opts);
  el.classList.add('vaire-link-missing');
  const text = opts.display ?? ref.full;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, missingTooltip(ref.full, message));
}

// ---- click routing (id refs) -----------------------------------------------------------

// `bindClick` runs every time `createRefElement` renders an id ref onto an anchor, including
// re-renders that reuse the same still-`a.internal-link`-classed element (Obsidian can
// re-invoke a registered `MarkdownPostProcessor` over DOM it already processed, which is why
// `insertNodeHeader` below has its own "already inserted" guard). Without tracking and
// removing the previous listeners here, every re-render would add another pair on top of the
// last, so a single click ends up opening the ref once per accumulated pair.
const boundClickHandlers = new WeakMap<HTMLElement, { click: (ev: MouseEvent) => void; auxclick: (ev: MouseEvent) => void }>();

/** Removes a previously `bindClick`-bound listener pair from `el`, if any. */
function clearBoundClick(el: HTMLElement): void {
  const previous = boundClickHandlers.get(el);
  if (!previous) return;
  el.removeEventListener('click', previous.click);
  el.removeEventListener('auxclick', previous.auxclick);
  boundClickHandlers.delete(el);
}

function bindClick(plugin: VairePlugin, el: HTMLAnchorElement, ref: IdRef, opts: RefElementOptions): void {
  clearBoundClick(el);

  const onClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    const newLeaf = !!(opts.newLeaf || ev.metaKey || ev.ctrlKey || ev.button === 1);
    void openRef(plugin, ref, opts.repo, { newLeaf, originScope: opts.originScope });
  };
  const onAuxClick = (ev: MouseEvent): void => {
    if (ev.button !== 1) return;
    ev.preventDefault();
    ev.stopPropagation();
    void openRef(plugin, ref, opts.repo, { newLeaf: true, originScope: opts.originScope });
  };

  el.addEventListener('click', onClick);
  el.addEventListener('auxclick', onAuxClick);
  boundClickHandlers.set(el, { click: onClick, auxclick: onAuxClick });
}

// ---- loose ends --------------------------------------------------------------------------

function renderLoose(plugin: VairePlugin, ref: LooseRef, opts: RefElementOptions): HTMLElement {
  let el: HTMLElement;
  if (opts.reuse instanceof HTMLAnchorElement) {
    el = createEl('span');
    opts.reuse.replaceWith(el);
  } else {
    el = opts.reuse ?? createEl('span');
  }
  el.className = 'vaire-loose-end';
  clearChildren(el);
  // 00-base.css renders the "? TYPE" label itself via `::before { content: '? '
  // attr(data-vaire-type-hint) }` (uppercased in CSS) — no separate label element needed.
  el.setAttribute('data-vaire-type-hint', ref.typeHint || '?');
  if (ref.descriptor) el.setAttribute('data-vaire-descriptor', ref.descriptor);
  else el.removeAttribute('data-vaire-descriptor');

  const text = opts.display ?? ref.descriptor;
  el.appendChild(document.createTextNode(text));
  setTooltip(el, looseTooltip());

  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void openRef(plugin, ref, opts.repo, { newLeaf: opts.newLeaf });
  });

  return el;
}

// ---- cache revalidation (perf/disk-cache) -----------------------------------------------
//
// Every id-ref element that took the CLI-backed path above (`renderPending` + `settleAsync`)
// is remembered here, keyed exactly like `plugin.resolveMemo` (`resolveMemoKey`, cli.ts) so a
// `'cache-revalidated'` event — triggered by `src/cache/query.ts` when a background
// revalidation under `persistentCache: 'stale-while-revalidate'` finds the value actually
// changed — finds every still-on-screen element showing that reference and redraws it in
// place. A vault-local hit (`resolveLocalSync` above) never reaches this registry: it's read
// straight from `LocalIndex`, which can't go stale this way.
//
// Deliberately not `WeakRef`/`FinalizationRegistry` (see DESIGN.md's guidance for this
// branch): a plain `Map<string, Set<...>>`, pruned of elements no longer attached to the
// document whenever we're about to touch that key (on registration and on the event itself),
// which is enough to keep it from growing without bound across a session's worth of reading-
// mode reflows without needing GC-timing-dependent cleanup.

interface RevalidationEntry {
  ref: IdRef;
  opts: RefElementOptions;
  el: HTMLElement;
}

const revalidationRegistry = new Map<string, Set<RevalidationEntry>>();

function pruneDisconnected(set: Set<RevalidationEntry>): void {
  for (const entry of set) {
    if (!entry.el.isConnected) set.delete(entry);
  }
}

function registerForRevalidation(repo: string, ref: IdRef, opts: RefElementOptions, el: HTMLElement): void {
  const key = resolveMemoKey(repo, ref.full);
  let set = revalidationRegistry.get(key);
  if (!set) {
    set = new Set();
    revalidationRegistry.set(key, set);
  }
  pruneDisconnected(set);
  // A revalidation redraw calls back into `createRefElement` with `reuse: entry.el`, which
  // re-enters this function for the *same* element — without this, every revalidation would
  // add another entry for it, and a later event would redraw it that many times over.
  for (const existing of set) {
    if (existing.el === el) set.delete(existing);
  }
  set.add({ ref, opts, el });
}

/**
 * Wires the `'cache-revalidated'` listener that redraws every registered, still-connected
 * element for a repo+id whose cached value just changed — re-running `createRefElement` with
 * the same `ref`/`opts` it was originally rendered with, `reuse`d onto the same element, so the
 * DOM node identity (and anything else holding a reference to it) survives. Registered once,
 * from `registerRendering` (render/index.ts).
 */
export function registerCacheRevalidation(plugin: VairePlugin): void {
  plugin.registerEvent(
    plugin.events.on('cache-revalidated', (absRoot, id) => {
      if (typeof absRoot !== 'string' || typeof id !== 'string') return;
      const key = resolveMemoKey(absRoot, id);
      const set = revalidationRegistry.get(key);
      if (!set) return;
      pruneDisconnected(set);
      for (const entry of set) {
        createRefElement(plugin, entry.ref, { ...entry.opts, reuse: entry.el });
      }
      if (set.size === 0) revalidationRegistry.delete(key);
    }),
  );
}
