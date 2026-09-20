// Tab title / view title decoration (feat/tab-titles). Obsidian titles a markdown tab from
// the file basename — `.workspace-tab-header[data-type="markdown"]
// .workspace-tab-header-inner-title` — and the view header the same way
// (`.view-header-title`); this overlays the Vairë node's name (plus a small type badge) in
// their place when `settings.tabTitles` isn't `'file'`. Same DOM-decoration shape as
// explorer.ts: debounce + idempotence markers (`data-vaire-title`) + cleanup on unload.
//
// DOM elements relied on, neither of which is in the `obsidian` typings (both exist at
// runtime; accessed defensively via a narrow local cast rather than `any` sprinkled around):
//   - `WorkspaceLeaf.tabHeaderInnerTitleEl: HTMLElement` — the tab strip's title span.
//   - `(leaf.view as MarkdownView).titleEl: HTMLElement` — the view header's title element.
// Both are plain elements whose own text Obsidian may still read (rename-by-title, tooltips),
// so neither is ever mutated in place. Instead: the host gets a `vaire-title-original` class
// (hidden via CSS, styles/85-nav.css) and a `span.vaire-title-wrap` sibling is inserted right
// after it, holding the visible `span.vaire-title-badge`/`span.vaire-title-text`. Clearing a
// decoration removes that sibling and the class, restoring Obsidian's own rendering exactly.

import { MarkdownView, TFile, type WorkspaceLeaf } from 'obsidian';
import type VairePlugin from '../main';
import type { LocalNode } from '../packages';
import { titleKey, titleText, type TabTitleMode } from './pure';
import { applyTypeColor } from '../theme/index';

const DEBOUNCE_MS = 100;
const TITLE_ORIGINAL_CLASS = 'vaire-title-original';
const TITLE_WRAP_CLASS = 'vaire-title-wrap';
const TITLE_BADGE_CLASS = 'vaire-title-badge';
const TITLE_TEXT_CLASS = 'vaire-title-text';

/** Runtime-only fields `obsidian.d.ts` doesn't declare — see the header comment above. */
interface LeafWithTabHeader {
  tabHeaderInnerTitleEl?: HTMLElement;
}
interface ViewWithTitleEl {
  titleEl?: HTMLElement;
}

export function registerTabTitles(plugin: VairePlugin): void {
  let timer: number | null = null;
  const schedule = (): void => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      decorateAllTabs(plugin);
    }, DEBOUNCE_MS);
  };

  plugin.registerEvent(plugin.app.workspace.on('layout-change', schedule));
  plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', schedule));
  plugin.registerEvent(plugin.app.workspace.on('file-open', schedule));
  plugin.registerEvent(plugin.app.metadataCache.on('changed', schedule));
  plugin.registerEvent(plugin.events.on('local-index-rebuilt', schedule));
  plugin.registerEvent(plugin.events.on('settings-changed', schedule));

  plugin.app.workspace.onLayoutReady(() => decorateAllTabs(plugin));

  plugin.register(() => {
    if (timer != null) window.clearTimeout(timer);
    clearAllTabs(plugin);
  });
}

function decorateAllTabs(plugin: VairePlugin): void {
  const mode = plugin.settings.tabTitles;
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    decorateLeaf(plugin, leaf, mode);
  }
}

function clearAllTabs(plugin: VairePlugin): void {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    decorateLeaf(plugin, leaf, 'file');
  }
}

function nodeFor(plugin: VairePlugin, file: TFile): LocalNode | null {
  return plugin.packages.packageFor(file)?.index.byFile(file) ?? null;
}

function decorateLeaf(plugin: VairePlugin, leaf: WorkspaceLeaf, mode: TabTitleMode): void {
  const view = leaf.view;
  const file = view instanceof MarkdownView ? view.file : null;
  const node = file instanceof TFile ? nodeFor(plugin, file) : null;
  const basename = file?.basename ?? '';

  const tabHost = (leaf as unknown as LeafWithTabHeader).tabHeaderInnerTitleEl;
  if (tabHost) decorateHost(plugin, tabHost, node, mode, basename);

  const viewHost = (view as unknown as ViewWithTitleEl).titleEl;
  if (viewHost) decorateHost(plugin, viewHost, node, mode, basename);
}

function decorateHost(plugin: VairePlugin, hostEl: HTMLElement, node: LocalNode | null, mode: TabTitleMode, basename: string): void {
  if (!hostEl.isConnected) return;

  const key = titleKey(node, node?.type, basename, mode);
  if (key === null) {
    clearHost(hostEl);
    return;
  }
  if (hostEl.dataset.vaireTitle === key) return;
  hostEl.dataset.vaireTitle = key;
  hostEl.classList.add(TITLE_ORIGINAL_CLASS);

  const wrap = ensureWrap(hostEl);
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

  if (node) {
    // `.vaire-badge` (styles/00-base.css) gives the small uppercase pill look, including its
    // `--vaire-type-color` pickup for the `vaire-type-<t>` class (feat/type-colors).
    const badge = wrap.createEl('span', { cls: `${TITLE_BADGE_CLASS} vaire-badge vaire-type-${node.type}`, text: node.type });
    applyTypeColor(plugin, badge, node.type);
  }

  wrap.createEl('span', { cls: TITLE_TEXT_CLASS, text: titleText(node, basename, mode) });
}

function ensureWrap(hostEl: HTMLElement): HTMLElement {
  const next = hostEl.nextElementSibling;
  if (next?.instanceOf(HTMLElement) && next.classList.contains(TITLE_WRAP_CLASS)) return next;
  const wrap = createEl('span', { cls: TITLE_WRAP_CLASS });
  hostEl.insertAdjacentElement('afterend', wrap);
  return wrap;
}

function clearHost(hostEl: HTMLElement): void {
  if (hostEl.dataset.vaireTitle === undefined) return; // never decorated, nothing to undo
  delete hostEl.dataset.vaireTitle;
  hostEl.classList.remove(TITLE_ORIGINAL_CLASS);
  const next = hostEl.nextElementSibling;
  if (next?.instanceOf(HTMLElement) && next.classList.contains(TITLE_WRAP_CLASS)) next.remove();
}
