// Reading-mode relations footer: appended below the document for every vault node file,
// mirroring the published site's "trailing sections" (renderer-conventions.md §1) —
// References →, Backlinks ←, Supersedes, Loose ends. See DESIGN.md "Rendering conventions"
// (Relations) and BRANCHES.md (`feat/relations-footer`). Data-shaping (dedupe/order/wide
// threshold/last-section heuristic) lives in relations-data.ts, shared with node-view.ts's
// own Relations sections so both surfaces agree.
//
// A `MarkdownPostProcessor` is invoked once per section and has no way to know up front which
// section is the document's last, so every call re-evaluates `isLastSection` against
// `ctx.getSectionInfo(el)`. Whichever section is (or later turns out to be) last gets the
// footer appended as a sibling right after it, inside `div.vaire-relations`; a
// duplicate-removal guard in `insertFooter` covers both a stale earlier guess and Obsidian
// re-rendering the last section on its own (each of those re-invokes this post processor for
// that one section, which removes and rebuilds the footer from scratch).

import { ButtonComponent, TFile } from 'obsidian';
import { VaireError } from '../cli';
import { parseRef, type IdRef, type VaireRef } from '../ids';
import type { BacklinkEntry } from '../types';
import type { LocalNode, PackageInfo } from '../packages';
import { vaultPathFor } from '../views/pure-pkg';
import { openFileAtLine } from '../navigate';
import { createRefElement } from './ref-el';
import { isLastSection, isWideRelations, looseEndsOf, outgoingRefs, sortBacklinksById } from './relations-data';
import type VairePlugin from '../main';

/**
 * Footer element -> "re-run the backlinks fetch" closure. A `WeakMap` (rather than a plain
 * list this module owns) means a footer removed from the DOM by a later re-render is simply
 * never found again by `document.querySelectorAll` below and its entry is free to be
 * collected — no separate cleanup path needed.
 */
const backlinkRefills = new WeakMap<HTMLElement, () => void>();

export function registerRelationsFooter(plugin: VairePlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    if (!plugin.settings.relationsFooter) return;
    if (el.closest('.internal-embed')) return; // embeds render a node's body, not "the document"
    if (ctx.sourcePath.startsWith('__vaire_external__/')) return; // the external view builds its own page

    const info = ctx.getSectionInfo(el);
    if (!info) return; // no section info available (embeds and some synthetic renders) -> skip

    const pkg = plugin.packages.packageFor(ctx.sourcePath);
    if (!pkg) return; // not a vault package

    const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return;

    const node = pkg.index.byFile(file);
    if (!node) return; // this file isn't itself a Vairë node

    if (!isLastSection(info.text, info.lineEnd)) return;

    insertFooter(plugin, el, pkg, node, file);
  });

  // Registered once here (not per post-processor call): on a rebuilt index, refresh every
  // currently-mounted footer belonging to that package by re-running its backlinks fetch.
  plugin.registerEvent(
    plugin.events.on('index-rebuilt', (root) => {
      document.querySelectorAll<HTMLElement>('.vaire-relations[data-vaire-relations-for]').forEach((footer) => {
        const filePath = footer.getAttribute('data-vaire-relations-for');
        const owner = filePath ? plugin.packages.packageFor(filePath) : null;
        if (owner && owner.absRoot === root) backlinkRefills.get(footer)?.();
      });
    }),
  );
}

function insertFooter(plugin: VairePlugin, el: HTMLElement, pkg: PackageInfo, node: LocalNode, file: TFile): void {
  const parent = el.parentElement;
  if (!parent) return;

  // Guard against duplicates: an earlier call may have (wrongly, or since superseded by a
  // re-render) attached a footer already.
  parent.querySelectorAll(':scope > .vaire-relations').forEach((stale) => stale.remove());

  const footer = document.createElement('div');
  footer.className = 'vaire-relations';
  footer.setAttribute('data-vaire-relations-for', file.path);

  const grid = document.createElement('div');
  grid.className = 'vaire-rel-grid';
  footer.appendChild(grid);

  const proseLinkTargets = (plugin.app.metadataCache.getFileCache(file)?.links ?? []).map((l) => l.link);
  const refs = outgoingRefs(node.frontmatter, proseLinkTargets);
  grid.appendChild(buildReferencesSection(plugin, pkg, refs));

  // Backlinks resolve asynchronously; the grid's wide/narrow state is re-evaluated once the
  // real count is known (References is already exact at this point).
  const counts = { references: refs.length, backlinks: 0 };
  const applyWide = (): void => {
    grid.classList.toggle('wide', isWideRelations(counts.references, counts.backlinks));
  };
  applyWide();

  const backlinks = buildBacklinksSection(plugin, pkg, node, (count) => {
    counts.backlinks = count;
    applyWide();
  });
  grid.appendChild(backlinks.el);
  backlinkRefills.set(footer, backlinks.refresh);

  const supersedes = buildSupersedesSection(plugin, pkg, node);
  if (supersedes) footer.appendChild(supersedes);

  const looseEnds = buildLooseEndsSection(plugin, pkg, node, proseLinkTargets);
  if (looseEnds) footer.appendChild(looseEnds);

  parent.appendChild(footer);
}

// ---- small DOM builders ------------------------------------------------------------------

function sectionEl(cls: string, heading: string): HTMLElement {
  const section = document.createElement('div');
  section.className = `vaire-rel-section ${cls}`;
  const h3 = document.createElement('h3');
  h3.textContent = heading;
  section.appendChild(h3);
  return section;
}

function emptyRow(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'vaire-empty';
  div.textContent = text;
  return div;
}

function refList(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'vaire-ref-list';
  return div;
}

function refRow(plugin: VairePlugin, repo: string, ref: VaireRef): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vaire-ref-row';
  row.appendChild(createRefElement(plugin, ref, { repo }));
  return row;
}

// ---- References -> ------------------------------------------------------------------------

function buildReferencesSection(plugin: VairePlugin, pkg: PackageInfo, refs: IdRef[]): HTMLElement {
  const section = sectionEl('vaire-rel-references', 'References →');
  if (refs.length === 0) {
    section.appendChild(emptyRow('Points at nothing yet.'));
    return section;
  }
  const list = refList();
  for (const ref of refs) list.appendChild(refRow(plugin, pkg.absRoot, ref));
  section.appendChild(list);
  return section;
}

// ---- Backlinks <- --------------------------------------------------------------------------

function buildBacklinksSection(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  onCount: (count: number) => void,
): { el: HTMLElement; refresh: () => void } {
  const section = sectionEl('vaire-rel-backlinks', 'Backlinks ←');
  const body = document.createElement('div');
  section.appendChild(body);

  const load = (): void => {
    body.textContent = '';
    body.appendChild(emptyRow('Loading…'));

    plugin.cli
      .backlinks(pkg.absRoot, node.full)
      .then((result) => {
        body.textContent = '';
        const sorted = sortBacklinksById(result.backlinks);
        onCount(sorted.length);
        if (sorted.length === 0) {
          body.appendChild(emptyRow('No backlinks yet.'));
          return;
        }
        const list = refList();
        for (const entry of sorted) list.appendChild(buildBacklinkRow(plugin, pkg, entry));
        body.appendChild(list);
      })
      .catch((err: unknown) => {
        body.textContent = '';
        onCount(0);
        renderBacklinksError(plugin, pkg, body, err);
      });
  };

  load();
  return { el: section, refresh: load };
}

function buildBacklinkRow(plugin: VairePlugin, pkg: PackageInfo, entry: BacklinkEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vaire-ref-row vaire-backlink-row';

  const ref = parseRef(entry.id);
  if (ref && ref.kind === 'id') {
    row.appendChild(createRefElement(plugin, ref, { repo: pkg.absRoot }));
  } else {
    const span = document.createElement('span');
    span.textContent = entry.id;
    row.appendChild(span);
  }

  const meta = document.createElement('span');
  meta.className = 'vaire-muted';
  meta.textContent = `${entry.ref_type} · `;
  row.appendChild(meta);

  const target = resolveBacklinkFile(plugin, pkg, entry);
  if (target) {
    const link = document.createElement('a');
    link.className = 'vaire-path-link';
    link.href = '#';
    link.textContent = `line ${entry.line}`;
    link.addEventListener('click', (evt) => {
      evt.preventDefault();
      void openFileAtLine(plugin.app, target, entry.line - 1, evt.metaKey || evt.ctrlKey);
    });
    row.appendChild(link);
  } else {
    // Not a file this vault can open (e.g. a dependency package that isn't itself in the
    // vault) — show the line number as plain text rather than a link that would go nowhere.
    const span = document.createElement('span');
    span.className = 'vaire-muted';
    span.textContent = `line ${entry.line}`;
    row.appendChild(span);
  }

  return row;
}

/** The vault `TFile` a backlink entry's `path` (relative to its owning package) points at, if any. */
function resolveBacklinkFile(plugin: VairePlugin, pkg: PackageInfo, entry: BacklinkEntry): TFile | null {
  const ownerPkg = entry.package ? plugin.packages.byName(entry.package) : pkg;
  if (!ownerPkg) return null;
  const file = plugin.app.vault.getAbstractFileByPath(vaultPathFor(ownerPkg.dir, entry.path));
  return file instanceof TFile ? file : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderBacklinksError(plugin: VairePlugin, pkg: PackageInfo, body: HTMLElement, err: unknown): void {
  const message = document.createElement('div');
  message.className = 'vaire-error';
  if (err instanceof VaireError && err.kind === 'index_not_built') {
    message.textContent = 'Index not built.';
    body.appendChild(message);
    const buttonHost = document.createElement('div');
    body.appendChild(buttonHost);
    new ButtonComponent(buttonHost).setButtonText('Rebuild index').onClick(() => void plugin.rebuildIndex(pkg));
    return;
  }
  message.textContent = `Could not load backlinks — ${errMessage(err)}`;
  body.appendChild(message);
}

// ---- Supersedes ----------------------------------------------------------------------------

function buildSupersedesSection(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement | null {
  const items = pkg.index.supersededBy(node.full);
  if (items.length === 0) return null;
  const section = sectionEl('vaire-rel-supersedes', 'Supersedes');
  const list = refList();
  for (const n of items) {
    const ref: IdRef = { kind: 'id', type: n.type, id: n.id, scope: n.scope, full: n.full, local: n.full };
    list.appendChild(refRow(plugin, pkg.absRoot, ref));
  }
  section.appendChild(list);
  return section;
}

// ---- Loose ends ------------------------------------------------------------------------------

function buildLooseEndsSection(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  proseLinkTargets: string[],
): HTMLElement | null {
  const items = looseEndsOf(node.frontmatter, proseLinkTargets);
  if (items.length === 0) return null;
  const section = sectionEl('vaire-rel-loose-ends', 'Loose ends');
  const list = refList();
  for (const ref of items) list.appendChild(refRow(plugin, pkg.absRoot, ref));
  section.appendChild(list);
  return section;
}
