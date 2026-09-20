// Node panel (right sidebar). See DESIGN.md "§6 Package view and node panel" and
// "Rendering conventions" (Relations).

import { ButtonComponent, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { addAliasToNode, addEdgeToNode } from '../authoring/actions';
import { startRename } from '../authoring/rename-modal';
import { startSupersede } from '../authoring/supersede-modal';
import { VaireError } from '../cli';
import { extractFrontmatterEdges, parseRef, statusDot, type IdRef, type LooseRef } from '../ids';
import { renderHistorySection } from '../history/section';
import { openFileAtLine, openRef } from '../navigate';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { outgoingRefs } from '../render/relations-data';
import { loadBacklinkContexts, type BacklinkContext } from './backlinks-data';
import { openBacklinkContext, refForContext, renderBacklinkSnippet } from './backlinks-render';
import { describeFinding, packageRelativePath, type FindingLike } from './pure-pkg';
import type VairePlugin from '../main';

export const VIEW_TYPE_NODE = 'vaire-node';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

export class NodeView extends ItemView {
  private readonly plugin: VairePlugin;
  private currentFile: TFile | null = null;
  private metaDebounce: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_NODE;
  }

  getIcon(): string {
    return 'git-branch';
  }

  getDisplayText(): string {
    return 'Vairë node';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-node-view');

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.followFile(file)));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.followFile(this.app.workspace.getActiveFile())),
    );
    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        const pkg = this.currentFile ? this.plugin.packages.packageFor(this.currentFile) : null;
        if (pkg && pkg.absRoot === root) this.render();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (this.currentFile && file.path === this.currentFile.path) this.scheduleMetaRefresh();
      }),
    );

    this.followFile(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.contentEl.empty();
  }

  private followFile(file: TFile | null): void {
    this.currentFile = file;
    this.render();
  }

  private scheduleMetaRefresh(): void {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.metaDebounce = window.setTimeout(() => {
      this.metaDebounce = null;
      this.render();
    }, 500);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const file = this.currentFile;
    if (!file) {
      contentEl.createDiv({ cls: 'vaire-empty', text: 'No file open.' });
      return;
    }
    const pkg = this.plugin.packages.packageFor(file);
    if (!pkg) {
      contentEl.createDiv({ cls: 'vaire-empty', text: 'Not a Vairë node.' });
      return;
    }
    const node = pkg.index.byFile(file);
    if (!node) {
      contentEl.createDiv({ cls: 'vaire-empty', text: 'Not a Vairë node.' });
      return;
    }

    this.renderIdentity(contentEl, pkg, node);
    this.renderEdges(contentEl, pkg, node);
    this.renderReferences(contentEl, pkg, node, file);
    this.renderBacklinks(contentEl, pkg, node);
    renderHistorySection(this.plugin, pkg, node, contentEl); // feat/node-history: below Backlinks
    this.renderSupersedes(contentEl, pkg, node);
    this.renderLooseEnds(contentEl, pkg, node, file);
    this.renderFindings(contentEl, pkg, node, file);
  }

  private renderCliError(container: HTMLElement, pkg: PackageInfo, err: unknown, prefix: string): void {
    const div = container.createDiv({ cls: 'vaire-error' });
    div.createSpan({ text: `${prefix} — ${errMessage(err)}` });
    if (isIndexNotBuilt(err)) {
      div.createEl('br');
      new ButtonComponent(div).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  // ---- Identity -------------------------------------------------------------------------

  private renderIdentity(root: HTMLElement, pkg: PackageInfo, node: LocalNode): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-identity' });

    const header = section.createDiv({ cls: 'vaire-section-header-row' });
    header.createEl('h2', { text: 'Identity' });
    const addAliasBtn = new ButtonComponent(header)
      .setIcon('plus')
      .setTooltip('Add alias')
      .onClick(() => void addAliasToNode(this.plugin, node));
    addAliasBtn.buttonEl.addClass('vaire-icon-btn');

    const crumb = section.createDiv({ cls: 'vaire-crumb' });
    // `vaire-type-<t>` (feat/type-colors) lets src/theme/index.ts colour this badge the same
    // way as the reading-mode type badge, via `--vaire-type-color`.
    crumb.createSpan({ cls: `vaire-badge vaire-type-${node.type}`, text: node.type });
    const idEl = crumb.createEl('code', { cls: 'vaire-nid vaire-copyable', text: node.full });
    idEl.setAttr('title', 'Click to copy');
    idEl.addEventListener('click', () => {
      navigator.clipboard.writeText(node.full).then(
        () => new Notice(`Copied ${node.full}`),
        () => new Notice('Vairë: could not copy to the clipboard'),
      );
    });
    const dot = statusDot(node.frontmatter.status);
    if (dot) crumb.createSpan({ cls: `vaire-status-dot dot-${dot}` });

    section.createEl('h2', { cls: 'vaire-identity-name', text: node.name });

    if (node.aliases.length > 0) {
      const chips = section.createDiv({ cls: 'vaire-aliases' });
      for (const alias of node.aliases) chips.createSpan({ cls: 'vaire-alias-chip', text: alias });
    }

    const meta = section.createDiv({ cls: 'vaire-identity-meta' });
    const updated = node.frontmatter.updated;
    const since = node.frontmatter.since;
    if (typeof updated === 'string') meta.createSpan({ cls: 'vaire-muted', text: `updated: ${updated}` });
    if (typeof since === 'string') meta.createSpan({ cls: 'vaire-muted', text: `since: ${since}` });

    const actions = section.createDiv({ cls: 'vaire-identity-actions' });
    if (node.supersededBy) {
      const targetRef = parseRef(node.supersededBy);
      new ButtonComponent(actions).setButtonText('Follow redirect').onClick(() => {
        if (targetRef && targetRef.kind === 'id') {
          void openRef(this.plugin, targetRef, pkg.absRoot);
        } else {
          new Notice(`Vairë: could not parse redirect target "${node.supersededBy}"`);
        }
      });

      const banner = section.createDiv({ cls: 'vaire-superseded-banner' });
      banner.createSpan({ text: 'This node is a tombstone — references redirect to ' });
      if (targetRef && targetRef.kind === 'id') {
        banner.appendChild(createRefElement(this.plugin, targetRef, { repo: pkg.absRoot }));
      } else {
        banner.createSpan({ text: node.supersededBy });
      }
    } else {
      new ButtonComponent(actions)
        .setButtonText('Supersede…')
        .onClick(() => startSupersede(this.plugin, pkg, node));
      new ButtonComponent(actions)
        .setButtonText('Rename id…')
        .onClick(() => startRename(this.plugin, pkg, node));
    }
  }

  // ---- Edges ----------------------------------------------------------------------------

  private renderEdges(root: HTMLElement, pkg: PackageInfo, node: LocalNode): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-edges' });
    const header = section.createDiv({ cls: 'vaire-section-header-row' });
    header.createEl('h2', { text: 'Edges' });
    const actions = header.createDiv({ cls: 'vaire-actions-inline' });
    const addEdgeBtn = new ButtonComponent(actions)
      .setIcon('plus')
      .setTooltip('Add edge')
      .onClick(() => addEdgeToNode(this.plugin, pkg, node));
    addEdgeBtn.buttonEl.addClass('vaire-icon-btn');
    const removalHint = actions.createSpan({ cls: 'vaire-muted vaire-edge-remove-hint', text: 'ⓘ' });
    removalHint.setAttr(
      'title',
      'No remove button here on purpose — Vairë contributors only add edges, never rewrite or delete one. ' +
        'Edit the frontmatter directly if an edge truly needs to go.',
    );

    const edges = extractFrontmatterEdges(node.frontmatter);
    if (edges.length === 0) {
      section.createDiv({ cls: 'vaire-empty', text: 'No frontmatter edges.' });
      return;
    }
    for (const edge of edges) {
      const row = section.createDiv({ cls: 'vaire-edge-row' });
      row.createSpan({ cls: 'vaire-edge-key', text: edge.key });
      const valuesEl = row.createDiv({ cls: 'vaire-edge-values' });
      for (const value of edge.values) {
        if (value.kind === 'text') {
          valuesEl.createSpan({ cls: 'vaire-edge-text', text: value.text });
        } else {
          valuesEl.appendChild(createRefElement(this.plugin, value, { repo: pkg.absRoot }));
        }
      }
    }
  }

  // ---- References -> ---------------------------------------------------------------------

  private renderReferences(root: HTMLElement, pkg: PackageInfo, node: LocalNode, file: TFile): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-refs-out' });
    section.createEl('h2', { text: 'References →' });

    // Shared with the reading-mode relations footer (src/render/relations.ts) so both
    // surfaces agree: frontmatter edges first, then prose links in appearance order, deduped
    // by full id. Loose ends are excluded here — they have their own section below.
    const cache = this.app.metadataCache.getFileCache(file);
    const proseLinkTargets = (cache?.links ?? []).map((link) => link.link);
    const refs = outgoingRefs(node.frontmatter, proseLinkTargets);

    if (refs.length === 0) {
      section.createDiv({ cls: 'vaire-empty', text: 'Points at nothing yet.' });
      return;
    }
    const list = section.createDiv({ cls: 'vaire-ref-list' });
    for (const ref of refs) {
      const row = list.createDiv({ cls: 'vaire-ref-row' });
      row.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
    }
  }

  // ---- Backlinks <- -----------------------------------------------------------------------

  private renderBacklinks(root: HTMLElement, pkg: PackageInfo, node: LocalNode): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-backlinks' });
    section.createEl('h2', { text: 'Backlinks ←' });
    const body = section.createDiv();
    body.setText('Loading…');

    loadBacklinkContexts(this.plugin, pkg, node)
      .then((contexts) => {
        body.empty();
        if (contexts.length === 0) {
          body.createDiv({ cls: 'vaire-empty', text: 'No backlinks.' });
          return;
        }
        const sorted = [...contexts].sort((a, b) => a.id.localeCompare(b.id));
        const byType = new Map<string, typeof sorted>();
        for (const ctx of sorted) {
          const list = byType.get(ctx.type);
          if (list) list.push(ctx);
          else byType.set(ctx.type, [ctx]);
        }
        for (const [type, items] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const group = body.createDiv({ cls: 'vaire-backlink-group' });
          group.createEl('h3', { text: `${type} (${items.length})` });
          for (const ctx of items) this.renderBacklinkContextRow(group, pkg, ctx);
        }
      })
      .catch((err: unknown) => {
        body.empty();
        this.renderCliError(body, pkg, err, 'Could not load backlinks');
      });
  }

  private renderBacklinkContextRow(container: HTMLElement, pkg: PackageInfo, ctx: BacklinkContext): void {
    const item = container.createDiv({ cls: 'vaire-backlink-item' });

    const row = item.createDiv({ cls: 'vaire-backlink-row' });
    const ref = refForContext(ctx);
    if (ref) row.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
    else row.createSpan({ text: ctx.id });
    row.createSpan({ cls: 'vaire-badge vaire-reftype-badge', text: ctx.ref_type });
    row.createSpan({ cls: 'vaire-muted', text: `line ${ctx.line}` });

    const snippetEl = item.createDiv({ cls: 'vaire-backlink-snippet', attr: { role: 'button', tabindex: '0' } });
    renderBacklinkSnippet(snippetEl, ctx.snippet);
    const open = (evt: MouseEvent): void =>
      openBacklinkContext(this.plugin, pkg, ctx, { newLeaf: evt.metaKey || evt.ctrlKey });
    snippetEl.addEventListener('click', open);
    snippetEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        open(evt as unknown as MouseEvent);
      }
    });
  }

  // ---- Supersedes -------------------------------------------------------------------------

  private renderSupersedes(root: HTMLElement, pkg: PackageInfo, node: LocalNode): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-supersedes' });
    section.createEl('h2', { text: 'Supersedes' });
    const items = pkg.index.supersededBy(node.full);
    if (items.length === 0) {
      section.createDiv({ cls: 'vaire-empty', text: 'Nothing.' });
      return;
    }
    for (const n of items) {
      const row = section.createDiv({ cls: 'vaire-supersedes-row' });
      const ref: IdRef = { kind: 'id', type: n.type, id: n.id, scope: n.scope, full: n.full, local: n.full };
      row.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
    }
  }

  // ---- Loose ends ---------------------------------------------------------------------------

  private renderLooseEnds(root: HTMLElement, pkg: PackageInfo, node: LocalNode, file: TFile): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-loose-ends' });
    section.createEl('h2', { text: 'Loose ends' });
    const body = section.createDiv();
    body.setText('Loading…');

    const relPath = packageRelativePath(file.path, pkg.dir);
    this.plugin.cli
      .unresolved(pkg.absRoot)
      .then((result) => {
        body.empty();
        const items = result.unresolved.filter((u) => u.path === relPath);
        if (items.length === 0) {
          body.createDiv({ cls: 'vaire-empty', text: 'None.' });
          return;
        }
        for (const item of items) {
          const row = body.createDiv({ cls: 'vaire-loose-end-row' });
          const ref: LooseRef = {
            kind: 'loose',
            typeHint: item.type_guess ?? undefined,
            descriptor: item.descriptor,
            raw: `?${item.type_guess ?? ''}: ${item.descriptor}`,
          };
          row.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
          const lineLink = row.createEl('a', { cls: 'vaire-path-link', text: `line ${item.line}`, href: '#' });
          lineLink.addEventListener('click', (evt) => {
            evt.preventDefault();
            void openFileAtLine(this.app, file, item.line - 1, evt.metaKey || evt.ctrlKey);
          });
        }
      })
      .catch((err: unknown) => {
        body.empty();
        this.renderCliError(body, pkg, err, 'Could not load loose ends');
      });
  }

  // ---- Findings for this file ----------------------------------------------------------------

  private renderFindings(root: HTMLElement, pkg: PackageInfo, node: LocalNode, file: TFile): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-node-findings' });
    section.createEl('h2', { text: 'Findings for this file' });

    const result = this.plugin.lastCheck.get(pkg.absRoot);
    if (!result) {
      section.createDiv({ cls: 'vaire-empty', text: 'Run Check from the package index to see findings.' });
      return;
    }
    const relPath = packageRelativePath(file.path, pkg.dir);
    const all = [...result.violations, ...result.warnings] as unknown as FindingLike[];
    const matches = all.filter((f) => f.path === relPath);
    if (matches.length === 0) {
      section.createDiv({ cls: 'vaire-empty', text: 'None.' });
      return;
    }
    for (const f of matches) {
      const described = describeFinding(f);
      const row = section.createDiv({ cls: 'vaire-finding-row' });
      row.createSpan({ cls: 'vaire-finding-kind', text: described.title });
      if (described.detail) row.createSpan({ cls: 'vaire-finding-detail', text: described.detail });
      if (described.line != null) {
        const link = row.createEl('a', { cls: 'vaire-path-link', text: `line ${described.line}`, href: '#' });
        link.addEventListener('click', (evt) => {
          evt.preventDefault();
          void openFileAtLine(this.app, file, described.line! - 1, evt.metaKey || evt.ctrlKey);
        });
      }
    }
  }
}
