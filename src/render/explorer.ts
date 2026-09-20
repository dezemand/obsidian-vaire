// File explorer decoration (feat/explorer-badges). Obsidian's file explorer has no
// post-processor hook the way the note body does, so — like properties.ts — this observes the
// DOM directly and overlays small badges onto it; the underlying file/frontmatter is never
// touched, and the original `.nav-file-title-content` text node is always kept intact (its
// text is what Obsidian's own rename/edit flow reads and writes).
//
// DOM shape relied on (given in the task brief for this branch; there is no dedicated
// DESIGN.md section for it yet):
//   .nav-files-container
//     .nav-file
//       .nav-file-title[data-path]
//         .nav-file-title-content                 (file basename text node, kept intact)
//     .nav-folder
//       .nav-folder-title[data-path]
//         .nav-folder-title-content                (folder name text node, kept intact)
//
// Every markdown file that resolves to a Vairë node (via `plugin.packages.packageFor(path)
// ?.index.byFile(file)`) gets:
//   - `span.vaire-nav-badge.vaire-type-<t>` showing the type slug, inserted after a sibling
//     `span.vaire-nav-name` (see below) — both siblings of `.nav-file-title-content`, never
//     inside it.
//   - `span.vaire-nav-name` showing the node's `name`, always created once the row is a node
//     (regardless of the current display-name setting) so the setting can be flipped purely by
//     toggling the `.vaire-nav-names-node` class on the row — see styles/20-render.css.
//   - `.vaire-nav-gone` on the row when the node is superseded (struck through, faded).
// A `.nav-folder-title[data-path]` that matches a package root (`PackageInfo.dir`) gets
// `span.vaire-nav-badge.vaire-nav-pkg-badge` reading "pkg" with a `name@version` tooltip.
//
// Idempotence: a decorated file row stores `navDecorationKey(node)` (`type|name|gone`, see
// pure.ts) in `data-vaire-nav`; a re-decoration pass skips the row when the key is unchanged,
// unless explicitly forced (settings changed, so the badge-shown / names-node effects — which
// are not part of the key — need reapplying even when the node itself didn't).

import { TFile } from 'obsidian';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { navDecorationKey, navDisplayText, shouldDecorateRow } from './pure';

const DEBOUNCE_MS = 100;
const ROW_SELECTOR = '.nav-file-title, .nav-folder-title';

export function registerExplorerBadges(plugin: VairePlugin): void {
  let pending = new Set<HTMLElement>();
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    const rows = pending;
    pending = new Set();
    for (const el of rows) decorateRow(plugin, el);
  };

  const schedule = (el: HTMLElement): void => {
    pending.add(el);
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, DEBOUNCE_MS);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(ROW_SELECTOR)) {
          schedule(node);
          return;
        }
        node.querySelectorAll?.(ROW_SELECTOR).forEach((el) => schedule(el as HTMLElement));
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  plugin.register(() => {
    observer.disconnect();
    if (timer != null) window.clearTimeout(timer);
    pending.clear();
  });

  // Cold start: the metadata cache (and therefore every package's LocalIndex) may still be
  // filling when the workspace layout first settles, so this pass is best-effort — most of the
  // real work happens once 'local-index-rebuilt' fires below (packages.ts triggers it from
  // `metadataCache.on('resolved')`, which is the reliable "indexes are now complete" signal).
  plugin.app.workspace.onLayoutReady(() => decorateAll(plugin));

  plugin.registerEvent(plugin.events.on('local-index-rebuilt', () => decorateAll(plugin)));
  plugin.registerEvent(plugin.events.on('settings-changed', () => decorateAll(plugin, { force: true })));

  plugin.registerEvent(
    plugin.app.metadataCache.on('changed', (file) => {
      // Our own 'changed' listener may run before (or after) PackageRegistry's — registration
      // order between the two isn't guaranteed — so rebuild this one file's LocalIndex entry
      // ourselves first rather than trust it's already fresh.
      plugin.packages.packageFor(file)?.index.rebuildFile(file);
      const selector = `.nav-file-title[data-path="${CSS.escape(file.path)}"]`;
      document.querySelectorAll<HTMLElement>(selector).forEach((el) => decorateRow(plugin, el));
    }),
  );
}

function decorateAll(plugin: VairePlugin, opts: { force?: boolean } = {}): void {
  document.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((el) => decorateRow(plugin, el, opts));
}

function decorateRow(plugin: VairePlugin, titleEl: HTMLElement, opts: { force?: boolean } = {}): void {
  if (!titleEl.isConnected) return;
  if (titleEl.classList.contains('nav-folder-title')) {
    decorateFolderRow(plugin, titleEl);
  } else if (titleEl.classList.contains('nav-file-title')) {
    decorateFileRow(plugin, titleEl, opts);
  }
}

function lookupNode(plugin: VairePlugin, dataPath: string): LocalNode | null {
  const abstractFile = plugin.app.vault.getAbstractFileByPath(dataPath);
  if (!(abstractFile instanceof TFile)) return null;
  return plugin.packages.packageFor(dataPath)?.index.byFile(abstractFile) ?? null;
}

function decorateFileRow(plugin: VairePlugin, titleEl: HTMLElement, opts: { force?: boolean }): void {
  const dataPath = titleEl.getAttribute('data-path');
  if (dataPath == null) return;

  const contentEl = titleEl.querySelector<HTMLElement>(':scope > .nav-file-title-content');
  if (!contentEl) return;

  const node = lookupNode(plugin, dataPath);
  if (!node) {
    clearFileDecoration(titleEl);
    return;
  }

  const gone = !!node.supersededBy;
  const mode = plugin.settings.explorerNames;
  const shown = navDisplayText(node, mode);
  // The key covers the shown text and the badge setting, so switching modes re-decorates.
  const key = `${navDecorationKey({ type: node.type, name: shown ?? node.name, gone })}|${mode}|${plugin.settings.explorerBadges ? 1 : 0}`;
  if (!opts.force && titleEl.dataset.vaireNav === key) return;
  titleEl.dataset.vaireNav = key;

  titleEl.classList.toggle('vaire-nav-gone', gone);
  titleEl.classList.toggle('vaire-nav-names-node', shown !== null);

  let nameEl = titleEl.querySelector<HTMLElement>(':scope > .vaire-nav-name');
  if (!nameEl) {
    nameEl = document.createElement('span');
    nameEl.className = 'vaire-nav-name';
    contentEl.insertAdjacentElement('afterend', nameEl);
  }
  const text = shown ?? node.name;
  if (nameEl.textContent !== text) nameEl.textContent = text;
  // Keep the file name discoverable when it's hidden.
  const fileName = contentEl.textContent ?? '';
  if (shown !== null) titleEl.setAttribute('title', fileName);
  else if (titleEl.getAttribute('title') === fileName) titleEl.removeAttribute('title');

  let badge = titleEl.querySelector<HTMLElement>(':scope > .vaire-nav-badge');
  if (plugin.settings.explorerBadges && mode !== 'id') {
    if (!badge) {
      badge = document.createElement('span');
      nameEl.insertAdjacentElement('afterend', badge);
    }
    const cls = `vaire-nav-badge vaire-type-${node.type}`;
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== node.type) badge.textContent = node.type;
  } else {
    badge?.remove();
  }
}

function clearFileDecoration(titleEl: HTMLElement): void {
  if (titleEl.dataset.vaireNav === undefined) return; // never decorated, nothing to undo
  delete titleEl.dataset.vaireNav;
  titleEl.classList.remove('vaire-nav-gone', 'vaire-nav-names-node');
  titleEl.removeAttribute('title');
  titleEl.querySelector(':scope > .vaire-nav-badge')?.remove();
  titleEl.querySelector(':scope > .vaire-nav-name')?.remove();
}

function findPackageRoot(plugin: VairePlugin, dataPath: string): PackageInfo | null {
  const pkgs = plugin.packages.all();
  if (!shouldDecorateRow(dataPath, pkgs.map((p) => p.dir))) return null;
  return pkgs.find((p) => p.dir === dataPath) ?? null;
}

function decorateFolderRow(plugin: VairePlugin, folderEl: HTMLElement): void {
  const dataPath = folderEl.getAttribute('data-path');
  if (dataPath == null) return;

  const contentEl = folderEl.querySelector<HTMLElement>(':scope > .nav-folder-title-content');
  if (!contentEl) return;

  const pkg = plugin.settings.explorerBadges ? findPackageRoot(plugin, dataPath) : null;
  let badge = folderEl.querySelector<HTMLElement>(':scope > .vaire-nav-pkg-badge');

  if (!pkg) {
    if (folderEl.dataset.vaireNavPkg === undefined && !badge) return; // nothing to undo
    delete folderEl.dataset.vaireNavPkg;
    badge?.remove();
    return;
  }

  const tooltip = `${pkg.name}@${pkg.version}`;
  if (folderEl.dataset.vaireNavPkg === tooltip && badge) return; // unchanged, skip
  folderEl.dataset.vaireNavPkg = tooltip;

  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'vaire-nav-badge vaire-nav-pkg-badge';
    badge.textContent = 'pkg';
    contentEl.insertAdjacentElement('afterend', badge);
  }
  badge.setAttribute('aria-label', tooltip);
  badge.title = tooltip;
}
