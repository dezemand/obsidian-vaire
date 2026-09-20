// Node header: inserted before the body's leading `h1` for any vault file that is itself a
// Vairë node. See DESIGN.md "Rendering conventions" (crumb line, status dot, address,
// scope, tombstone banner, aliases, frontmatter edges) and renderer-conventions.md §1 for
// the reference implementation this mirrors. External-view pages build their own header
// (per DESIGN.md "Phase 2 ownership"), so this only ever fires for `ctx.sourcePath`s that
// resolve to a vault `PackageInfo`.

import { Notice, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { extractFrontmatterEdges, parseRef, statusDot } from '../ids';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from './ref-el';
import { humanizeKey } from './pure';
import { insertBreadcrumbTrail } from '../nav/breadcrumbs';
import type VairePlugin from '../main';
import { applyTypeColor } from '../theme/index';

/**
 * Inserts `div.vaire-node-header` before `el`'s leading `h1`, if any and if not already done.
 * Async: awaits `plugin.prefetchDocument` first (a no-op once reading.ts's own call for the
 * same file has already resolved — see DocumentPrefetcher's per-file cache) so the frontmatter
 * edges below resolve from the already-seeded `resolveMemo` instead of each spawning their own
 * `resolve` call.
 */
export async function insertNodeHeader(plugin: VairePlugin, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  if (el.closest('.internal-embed')) return; // embeds render a node's body, not "the document" (embeds.ts builds its own small title bar)
  const pkg = plugin.packages.packageFor(ctx.sourcePath);
  if (!pkg) return; // not a vault package — nothing to do (the external view builds its own header)
  if (el.querySelector('.vaire-node-header')) return; // already inserted for this section

  const h1 = el.querySelector('h1');
  if (!h1 || !h1.parentElement) return;

  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;

  const node = pkg.index.byFile(file);
  if (!node) return; // this file isn't itself a node (no id+type frontmatter)

  await plugin.prefetchDocument(pkg, node);

  const header = buildHeader(plugin, pkg, node);
  h1.parentElement.insertBefore(header, h1);
}

function textSpan(text: string, cls: string): HTMLSpanElement {
  return createEl('span', { cls, text });
}

function buildHeader(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement {
  const header = createEl('div', { cls: 'vaire-node-header' });

  header.appendChild(buildCrumb(plugin, node));
  header.appendChild(buildAddress(node));

  const scopeLine = buildScopeLine(plugin, pkg, node);
  if (scopeLine) header.appendChild(scopeLine);

  const banner = buildSupersededBanner(plugin, pkg, node);
  if (banner) header.appendChild(banner);

  const aliases = buildAliases(node);
  if (aliases) header.appendChild(aliases);

  const edges = buildEdges(plugin, pkg, node);
  if (edges) header.appendChild(edges);

  // feat/tab-titles: 'header'-placement scope breadcrumbs, inserted as the header's first
  // child; a no-op unless `settings.breadcrumbs === 'header'` and the node is scoped.
  insertBreadcrumbTrail(plugin, header, pkg, node);

  return header;
}

function buildCrumb(plugin: VairePlugin, node: LocalNode): HTMLElement {
  const crumb = createEl('div', { cls: 'vaire-crumb' });

  const addr = crumb.createEl('span', { cls: 'vaire-crumb-addr' });
  // Type gets its own span (feat/type-colors) so `.vaire-type-<t>` can colour just the type
  // portion of the crumb — `--vaire-type-color`, set by src/theme/index.ts, per DESIGN.md
  // "type badge, type:id" (renderer-conventions.md §1's crumb line).
  const typeBadge = addr.createEl('span', { cls: `vaire-badge vaire-crumb-type vaire-type-${node.type}`, text: node.type });
  applyTypeColor(plugin, typeBadge, node.type);
  addr.appendChild(document.createTextNode(` / ${node.id}`));

  const dot = statusDot(node.frontmatter.status);
  if (dot) {
    crumb.createEl('span', { cls: `vaire-status-dot dot-${dot}` });
  }

  const status = node.frontmatter.status;
  if (typeof status === 'string' && status.trim()) {
    crumb.appendChild(textSpan(status.trim(), 'vaire-crumb-status'));
  }
  const updated = node.frontmatter.updated;
  if (typeof updated === 'string' && updated.trim()) {
    crumb.appendChild(textSpan(`updated ${updated.trim()}`, 'vaire-crumb-meta'));
  }
  const since = node.frontmatter.since;
  if (typeof since === 'string' && since.trim()) {
    crumb.appendChild(textSpan(`since ${since.trim()}`, 'vaire-crumb-meta'));
  }

  return crumb;
}

function buildAddress(node: LocalNode): HTMLElement {
  const addr = createEl('code', { cls: 'vaire-addr', text: node.full, title: 'Click to copy' });
  addr.tabIndex = 0;
  addr.addEventListener('click', () => {
    navigator.clipboard.writeText(node.full).then(
      () => new Notice(`Copied ${node.full}`),
      () => new Notice('Vairë: could not copy to the clipboard'),
    );
  });
  return addr;
}

function buildScopeLine(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement | null {
  if (!node.scope) return null;
  const scopeRef = parseRef(node.scope);
  const line = createDiv({ cls: 'vaire-scope' });
  line.appendChild(document.createTextNode('in '));
  if (scopeRef && scopeRef.kind === 'id') {
    line.appendChild(createRefElement(plugin, scopeRef, { repo: pkg.absRoot }));
  } else {
    line.appendChild(document.createTextNode(node.scope));
  }
  return line;
}

function buildSupersededBanner(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement | null {
  if (!node.supersededBy) return null;
  const banner = createDiv({ cls: 'vaire-superseded-banner' });
  banner.appendChild(document.createTextNode('This node is a tombstone — references redirect to '));
  const ref = parseRef(node.supersededBy);
  if (ref && ref.kind === 'id') {
    banner.appendChild(createRefElement(plugin, ref, { repo: pkg.absRoot, originScope: node.scope }));
  } else {
    banner.appendChild(document.createTextNode(node.supersededBy));
  }
  return banner;
}

function buildAliases(node: LocalNode): HTMLElement | null {
  if (!node.aliases.length) return null;
  const wrap = createDiv({ cls: 'vaire-aliases' });
  for (const alias of node.aliases) {
    wrap.appendChild(textSpan(alias, 'vaire-alias-chip'));
  }
  return wrap;
}

function buildEdges(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): HTMLElement | null {
  const edges = extractFrontmatterEdges(node.frontmatter);
  if (!edges.length) return null;

  const container = createDiv({ cls: 'vaire-edges' });

  for (const edge of edges) {
    const row = container.createDiv({ cls: 'vaire-edge-row' });
    row.appendChild(textSpan(humanizeKey(edge.key), 'vaire-edge-key'));

    const values = row.createDiv({ cls: 'vaire-edge-values' });
    for (const value of edge.values) {
      const valueEl = values.createDiv({ cls: 'vaire-edge-value' });
      if (value.kind === 'text') {
        valueEl.textContent = value.text;
      } else {
        valueEl.appendChild(createRefElement(plugin, value, { repo: pkg.absRoot, originScope: node.scope }));
      }
    }
  }

  return container;
}
