// Scope breadcrumbs (feat/tab-titles): for a scoped node, `package › container › … › this
// node`, built by walking `scope` up through `LocalIndex.get` (`scopeChain`, src/nav/pure.ts
// — stops at 8 levels or on a cycle; an unresolvable container renders as a missing ref).
// Two placements, switched by `settings.breadcrumbs`:
//   - `'header'`: `insertBreadcrumbTrail` is called once from `src/render/header.ts` and
//     inserts the trail as the first child of `div.vaire-node-header`.
//   - `'view'`: `registerViewBreadcrumbs` (this file) inserts the trail into the view header
//     bar, next to the title, following the same leaf-iteration + debounce + idempotence-key
//     shape as `src/nav/titles.ts` (also covers live preview, since the view header exists
//     regardless of edit mode).
//
// Every crumb but the last is a `createRefElement` (see src/render/ref-el.ts) except the
// package crumb, which isn't a node reference at all — clicking it opens the package index via
// `app.commands.executeCommandById('vaire:vaire-open-package-index')` (the command
// `src/views/package-node.ts` registers), guarded since `App.commands` isn't in the `obsidian`
// typings.

import { MarkdownView, type View } from 'obsidian';
import { parseRef } from '../ids';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { scopeChain, type BreadcrumbPlacement, type ScopeChainCrumb } from './pure';

const DEBOUNCE_MS = 100;
const VIEW_TRAIL_CLASS = 'vaire-view-breadcrumbs';
const TITLE_WRAP_CLASS = 'vaire-title-wrap'; // owned by titles.ts — read-only here, to anchor after it

interface ViewWithTitleEl {
  titleEl?: HTMLElement;
}

/** Opens the package index via its command id, guarded — `App.commands` is runtime-only. */
function openPackageIndexCommand(plugin: VairePlugin): void {
  const commands = (plugin.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
  if (typeof commands?.executeCommandById === 'function') {
    commands.executeCommandById('vaire:vaire-open-package-index');
  }
}

function buildSeparator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'vaire-breadcrumb-sep';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = '›';
  return span;
}

function buildPackageCrumb(plugin: VairePlugin, pkg: PackageInfo): HTMLElement {
  const el = document.createElement('span');
  el.className = 'vaire-breadcrumb-pkg';
  el.textContent = pkg.name;
  el.title = `Open ${pkg.name} package index`;
  el.tabIndex = 0;
  el.addEventListener('click', () => openPackageIndexCommand(plugin));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      openPackageIndexCommand(plugin);
    }
  });
  return el;
}

function buildContainerCrumb(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, crumb: ScopeChainCrumb): HTMLElement {
  if (crumb.name === null) {
    const span = document.createElement('span');
    span.className = 'vaire-link-missing vaire-breadcrumb-missing';
    span.textContent = crumb.id;
    span.title = `not found in this package: ${crumb.id}`;
    return span;
  }
  const ref = parseRef(crumb.id);
  if (ref && ref.kind === 'id') {
    return createRefElement(plugin, ref, { repo: pkg.absRoot, originScope: node.scope });
  }
  // Not expected in practice (a container's own full id always parses), but keep the crumb
  // visible rather than dropping it silently.
  const span = document.createElement('span');
  span.textContent = crumb.id;
  return span;
}

/** Builds the full trail `div.vaire-breadcrumbs`, or `null` when `node` isn't scoped at all. */
export function buildBreadcrumbTrail(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement | null {
  if (!node.scope) return null;

  const result = scopeChain(node, (id) => {
    const found = pkg.index.get(id);
    return found ? { name: found.name, scope: found.scope } : null;
  }, 8);

  const trail = document.createElement('div');
  trail.className = 'vaire-breadcrumbs';
  if (result.cycle) trail.title = 'Scope chain contains a cycle — truncated';

  trail.appendChild(buildPackageCrumb(plugin, pkg));
  for (const crumb of result.chain) {
    trail.appendChild(buildSeparator());
    trail.appendChild(buildContainerCrumb(plugin, pkg, node, crumb));
  }
  trail.appendChild(buildSeparator());

  const current = document.createElement('span');
  current.className = 'vaire-breadcrumb-current';
  current.textContent = node.name;
  trail.appendChild(current);

  return trail;
}

/** Called from `src/render/header.ts`'s `buildHeader`; a no-op unless `breadcrumbs: 'header'`. */
export function insertBreadcrumbTrail(plugin: VairePlugin, header: HTMLElement, pkg: PackageInfo, node: LocalNode): void {
  if (plugin.settings.breadcrumbs !== 'header') return;
  const trail = buildBreadcrumbTrail(plugin, pkg, node);
  if (!trail) return;
  header.insertBefore(trail, header.firstChild);
}

// ---- 'view' placement: view header bar, next to the title ---------------------------------

export function registerViewBreadcrumbs(plugin: VairePlugin): void {
  let timer: number | null = null;
  const schedule = (): void => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      decorateAllViews(plugin);
    }, DEBOUNCE_MS);
  };

  plugin.registerEvent(plugin.app.workspace.on('layout-change', schedule));
  plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', schedule));
  plugin.registerEvent(plugin.app.workspace.on('file-open', schedule));
  plugin.registerEvent(plugin.app.metadataCache.on('changed', schedule));
  plugin.registerEvent(plugin.events.on('local-index-rebuilt', schedule));
  plugin.registerEvent(plugin.events.on('settings-changed', schedule));

  plugin.app.workspace.onLayoutReady(() => decorateAllViews(plugin));

  plugin.register(() => {
    if (timer != null) window.clearTimeout(timer);
    clearAllViews(plugin);
  });
}

function decorateAllViews(plugin: VairePlugin): void {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    decorateViewLeaf(plugin, leaf.view, plugin.settings.breadcrumbs);
  }
}

function clearAllViews(plugin: VairePlugin): void {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    decorateViewLeaf(plugin, leaf.view, 'off');
  }
}

function anchorFor(viewHost: HTMLElement): HTMLElement {
  const next = viewHost.nextElementSibling;
  if (next instanceof HTMLElement && next.classList.contains(TITLE_WRAP_CLASS)) return next;
  return viewHost;
}

function decorateViewLeaf(plugin: VairePlugin, view: View, placement: BreadcrumbPlacement): void {
  const viewHost = (view as unknown as ViewWithTitleEl).titleEl;
  if (!viewHost || !viewHost.isConnected) return;
  const parent = viewHost.parentElement;
  if (!parent) return;

  const existing = parent.querySelector<HTMLElement>(`:scope > .${VIEW_TRAIL_CLASS}`);

  const file = view instanceof MarkdownView ? view.file : null;
  const pkg = file ? plugin.packages.packageFor(file) : null;
  const node = file && pkg ? pkg.index.byFile(file) : null;

  if (placement !== 'view' || !pkg || !node || !node.scope) {
    existing?.remove();
    return;
  }

  const key = `${node.full}|${node.scope}`;
  if (existing && existing.dataset.vaireBreadcrumbs === key) return;

  const trail = buildBreadcrumbTrail(plugin, pkg, node);
  if (!trail) {
    existing?.remove();
    return;
  }
  trail.classList.add(VIEW_TRAIL_CLASS);
  trail.dataset.vaireBreadcrumbs = key;

  if (existing) existing.replaceWith(trail);
  else anchorFor(viewHost).insertAdjacentElement('afterend', trail);
}
