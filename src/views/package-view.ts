// Package index view. See DESIGN.md "§6 Package view and node panel" and "Rendering
// conventions" (package index).

import { ButtonComponent, ItemView, MarkdownRenderer, Notice, TFile, TextComponent, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { VaireError } from '../cli';
import { DepsModel, type DepRow } from '../deps';
import { renderHealthStrip } from '../health/index';
import { allFixesFor, applyFix } from '../diagnostics/fixes';
import type { LooseRef } from '../ids';
import { openFileAtLine } from '../navigate';
import type { PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { renderReleaseSection } from '../release/section';
import type { CheckResult, StatusResult } from '../types';
import { renderUpdatesSection } from '../updates/section';
import { linkFolder, linkFromCatalog, pullAll, pullDependency } from './deps-actions';
import { openDependencyView } from '../depgraph/index';
import { describeFinding, dropLeadingH1, groupNodes, shortCommit, vaultPathFor, type FindingLike } from './pure-pkg';
import { openUnresolvedWorkbench } from '../workbench/index';
import { openPackageGraph } from '../package-graph/index';
import type VairePlugin from '../main';

export const VIEW_TYPE_PACKAGE = 'vaire-package';

interface PackageViewState {
  packageDir: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

function shortRoot(absRoot: string): string {
  const parts = absRoot.split('/').filter(Boolean);
  return parts.length <= 2 ? absRoot : `…/${parts.slice(-2).join('/')}`;
}

export class PackageView extends ItemView {
  private readonly plugin: VairePlugin;
  private packageDir = '';
  private typeFilter: string | null = null;
  private textFilter = '';
  private metaDebounce: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PACKAGE;
  }

  getIcon(): string {
    return 'package';
  }

  getDisplayText(): string {
    const pkg = this.currentPkg();
    return pkg ? `${pkg.name} · Vairë` : 'Vairë package';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), packageDir: this.packageDir };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<PackageViewState> | undefined;
    if (s && typeof s.packageDir === 'string') this.packageDir = s.packageDir;
    await super.setState(state, result);
    this.render();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-package-view');

    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        const pkg = this.currentPkg();
        if (pkg && pkg.absRoot === root) this.render();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const pkg = this.currentPkg();
        if (!pkg) return;
        if (pkg.dir !== '' && !file.path.startsWith(`${pkg.dir}/`)) return;
        this.scheduleMetaRefresh();
      }),
    );

    this.render();
  }

  async onClose(): Promise<void> {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.contentEl.empty();
  }

  private currentPkg(): PackageInfo | null {
    return this.plugin.packages.all().find((p) => p.dir === this.packageDir) ?? null;
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

    const pkg = this.currentPkg();
    if (!pkg) {
      contentEl.createDiv({ cls: 'vaire-error', text: 'This package is no longer in the vault.' });
      return;
    }

    renderHealthStrip(this.plugin, pkg, contentEl.createDiv());
    this.renderHeader(contentEl, pkg);
    this.renderStatus(contentEl, pkg);
    renderReleaseSection(this.plugin, pkg, contentEl);
    void this.renderReadme(contentEl, pkg);
    this.renderContents(contentEl, pkg);
    this.renderDependencies(contentEl, pkg);
    renderUpdatesSection(this.plugin, pkg, contentEl);
    this.renderUnresolved(contentEl, pkg);
    this.renderFindings(contentEl, pkg);
  }

  // ---- Header -------------------------------------------------------------------------

  private renderHeader(root: HTMLElement, pkg: PackageInfo): void {
    const header = root.createDiv({ cls: 'vaire-section vaire-package-header' });
    const titleRow = header.createDiv({ cls: 'vaire-package-title-row' });
    titleRow.createEl('h1', { text: pkg.name });
    titleRow.createSpan({ cls: 'vaire-badge', text: `v${pkg.version}` });
    if (pkg.description) header.createEl('p', { cls: 'vaire-package-desc', text: pkg.description });

    const actions = header.createDiv({ cls: 'vaire-actions' });
    new ButtonComponent(actions).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    new ButtonComponent(actions).setButtonText('Check').onClick(() => void this.runCheck(pkg));
    new ButtonComponent(actions).setButtonText('Graph').onClick(() => void openPackageGraph(this.plugin, pkg.dir));
    new ButtonComponent(actions).setButtonText('Refresh').onClick(() => this.render());
  }

  private async runCheck(pkg: PackageInfo): Promise<void> {
    try {
      await this.plugin.runCheck(pkg, this.plugin.settings.checkStrict);
      this.render();
    } catch (err) {
      new Notice(`Vairë: check failed — ${errMessage(err)}`);
    }
  }

  // ---- Status ---------------------------------------------------------------------------

  private renderStatus(root: HTMLElement, pkg: PackageInfo): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-status' });
    section.createEl('h2', { text: 'Status' });
    const body = section.createDiv({ cls: 'vaire-status-body' });
    body.setText('Loading…');

    this.plugin.cli
      .status(pkg.absRoot)
      .then((status) => {
        body.empty();
        this.renderStatusBody(body, pkg, status);
      })
      .catch((err: unknown) => {
        body.empty();
        this.renderCliError(body, pkg, err, 'Could not read status');
      });
  }

  private renderStatusBody(body: HTMLElement, pkg: PackageInfo, status: StatusResult): void {
    const line = body.createDiv({ cls: 'vaire-status-line' });
    line.createSpan({ cls: 'vaire-status-item', text: `source: ${status.source ?? 'not built'}` });
    line.createSpan({ cls: 'vaire-status-item', text: `nodes: ${status.nodes.total}` });
    line.createSpan({ cls: 'vaire-status-item', text: `edges: ${status.edges}` });
    if (status.last_indexed_commit) {
      line.createSpan({ cls: 'vaire-status-item', text: `commit: ${shortCommit(status.last_indexed_commit)}` });
    }
    if (status.pending_release) {
      const pr = status.pending_release;
      line.createSpan({
        cls: 'vaire-status-item',
        text: `pending: ${pr.would_be} (+${pr.added} ~${pr.changed} -${pr.retired} ×${pr.removed})`,
      });
    }
    if (!status.source) {
      const hint = body.createDiv({ cls: 'vaire-hint' });
      hint.createSpan({ text: 'Index not built yet. ' });
      new ButtonComponent(hint).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  private renderCliError(container: HTMLElement, pkg: PackageInfo, err: unknown, prefix: string): void {
    const div = container.createDiv({ cls: 'vaire-error' });
    div.createSpan({ text: `${prefix} — ${errMessage(err)}` });
    if (isIndexNotBuilt(err)) {
      div.createEl('br');
      new ButtonComponent(div).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  // ---- README ---------------------------------------------------------------------------

  private async renderReadme(root: HTMLElement, pkg: PackageInfo): Promise<void> {
    const readmePath = vaultPathFor(pkg.dir, 'README.md');
    const file = this.app.vault.getAbstractFileByPath(readmePath);
    if (!(file instanceof TFile)) return;

    const section = root.createDiv({ cls: 'vaire-section vaire-readme-section' });
    section.createEl('h2', { text: 'README' });
    const container = section.createDiv({ cls: 'vaire-readme' });

    try {
      const raw = await this.app.vault.cachedRead(file);
      const text = dropLeadingH1(raw);
      await MarkdownRenderer.render(this.app, text, container, readmePath, this);
    } catch (err) {
      container.empty();
      container.createDiv({ cls: 'vaire-error', text: `Could not render README — ${errMessage(err)}` });
    }
  }

  // ---- Contents -------------------------------------------------------------------------

  private renderContents(root: HTMLElement, pkg: PackageInfo): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-contents' });
    section.createEl('h2', { text: 'Contents' });

    const controls = section.createDiv({ cls: 'vaire-contents-controls' });
    const chipsEl = controls.createDiv({ cls: 'vaire-chips' });
    const filterText = new TextComponent(controls);
    filterText.setPlaceholder('Filter by id, name, alias…').setValue(this.textFilter);
    filterText.inputEl.addClass('vaire-text-filter');

    const groupsContainer = section.createDiv({ cls: 'vaire-node-groups' });

    const allNodes = pkg.index.all();
    const byTypeCounts = new Map<string, number>();
    for (const n of allNodes) byTypeCounts.set(n.type, (byTypeCounts.get(n.type) ?? 0) + 1);
    const types = [...new Set([...pkg.types, ...byTypeCounts.keys()])].sort((a, b) => a.localeCompare(b));

    const renderGroups = (): void => {
      groupsContainer.empty();
      const groups = groupNodes(allNodes, { type: this.typeFilter ?? undefined, text: this.textFilter });
      if (groups.length === 0) {
        groupsContainer.createDiv({ cls: 'vaire-empty', text: 'No nodes match.' });
        return;
      }
      for (const group of groups) {
        const gEl = groupsContainer.createDiv({ cls: 'vaire-node-group' });
        gEl.createEl('h3', { text: `${group.type} (${group.count})` });
        const list = gEl.createDiv({ cls: 'vaire-node-list' });
        for (const node of group.nodes) {
          const row = list.createDiv({ cls: 'vaire-node-row' + (node.gone ? ' vaire-gone' : '') });
          const link = row.createEl('a', { cls: 'vaire-node-link', text: node.name, href: '#' });
          link.addEventListener('click', (evt) => {
            evt.preventDefault();
            void openFileAtLine(this.app, node.file, undefined, evt.metaKey || evt.ctrlKey);
          });
          row.createEl('code', { cls: 'vaire-nid', text: node.full });
        }
      }
    };

    const renderChips = (): void => {
      chipsEl.empty();
      const allChip = chipsEl.createEl('button', { cls: 'vaire-chip', text: `All (${allNodes.length})` });
      if (!this.typeFilter) allChip.addClass('is-active');
      allChip.addEventListener('click', () => {
        this.typeFilter = null;
        renderChips();
        renderGroups();
      });
      for (const type of types) {
        const count = byTypeCounts.get(type) ?? 0;
        const chip = chipsEl.createEl('button', { cls: 'vaire-chip', text: `${type} (${count})` });
        if (this.typeFilter === type) chip.addClass('is-active');
        chip.addEventListener('click', () => {
          this.typeFilter = type;
          renderChips();
          renderGroups();
        });
      }
    };

    filterText.onChange((value) => {
      this.textFilter = value;
      renderGroups();
    });

    renderChips();
    renderGroups();
  }

  // ---- Dependencies ---------------------------------------------------------------------

  private renderDependencies(root: HTMLElement, pkg: PackageInfo): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-deps' });
    const headerRow = section.createDiv({ cls: 'vaire-section-header-row' });
    headerRow.createEl('h2', { text: 'Dependencies' });
    new ButtonComponent(headerRow)
      .setButtonText('Open graph')
      .onClick(() => void openDependencyView(this.plugin, pkg.dir));
    new ButtonComponent(headerRow)
      .setButtonText('Pull all')
      .onClick(() => void pullAll(this.plugin, pkg).then((changed) => changed && this.render()));

    const body = section.createDiv();
    body.setText('Loading…');
    void this.loadDeps(pkg, body);
  }

  private async loadDeps(pkg: PackageInfo, body: HTMLElement): Promise<void> {
    let model: DepsModel;
    try {
      model = await DepsModel.load(this.plugin.cli, pkg);
    } catch (err) {
      body.empty();
      this.renderCliError(body, pkg, err, 'Could not load dependencies');
      return;
    }

    body.empty();
    if (model.rows.length === 0) {
      body.createDiv({ cls: 'vaire-empty', text: 'No dependencies declared.' });
      return;
    }

    const table = body.createEl('table', { cls: 'vaire-deps-table' });
    const headRow = table.createEl('thead').createEl('tr');
    for (const h of ['Name', 'Constraint', 'Version', 'State', 'Root', 'Note', '']) headRow.createEl('th', { text: h });
    const tbody = table.createEl('tbody');

    for (const row of model.rows) {
      const tr = tbody.createEl('tr');
      const nameCell = tr.createEl('td', { cls: 'vaire-dep-name-cell' });
      const nameSpan = nameCell.createSpan({ cls: 'vaire-dep-name', text: row.name });
      nameSpan.style.setProperty('--vaire-indent', String(row.depth - 1));
      tr.createEl('td', { text: row.constraint });
      tr.createEl('td', { text: row.version ?? '—' });
      const state = model.state(row);
      tr.createEl('td').createSpan({ cls: `vaire-state-badge vaire-state-${state}`, text: state });
      tr.createEl('td', { cls: 'vaire-dep-root', text: row.absRoot ? shortRoot(row.absRoot) : '—' });
      const noteCell = tr.createEl('td', { cls: 'vaire-dep-note' });
      if (row.note) noteCell.setText(row.note);
      const actionsCell = tr.createEl('td', { cls: 'vaire-dep-actions' });
      this.renderDepActions(actionsCell, pkg, row, state);
    }
  }

  private renderDepActions(cell: HTMLElement, pkg: PackageInfo, row: DepRow, state: string): void {
    if (row.depth !== 1 || state === 'ok') return; // only this package's own declared deps are actionable here
    const wrap = cell.createDiv({ cls: 'vaire-actions vaire-actions-inline' });
    new ButtonComponent(wrap)
      .setButtonText('Link from catalog…')
      .onClick(() => void linkFromCatalog(this.plugin, pkg, row.name).then((changed) => changed && this.render()));
    new ButtonComponent(wrap)
      .setButtonText('Link folder…')
      .onClick(() => void linkFolder(this.plugin, pkg, row.name).then((changed) => changed && this.render()));
    new ButtonComponent(wrap)
      .setButtonText('Pull')
      .onClick(() => void pullDependency(this.plugin, pkg, row.name).then((changed) => changed && this.render()));
  }

  // ---- Unresolved -----------------------------------------------------------------------

  private renderUnresolved(root: HTMLElement, pkg: PackageInfo): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-unresolved' });
    const headerRow = section.createDiv({ cls: 'vaire-section-header-row' });
    headerRow.createEl('h2', { text: 'Unresolved' });
    new ButtonComponent(headerRow)
      .setButtonText('Open workbench')
      .onClick(() => void openUnresolvedWorkbench(this.plugin, pkg.dir));
    const body = section.createDiv();
    body.setText('Loading…');

    this.plugin.cli
      .unresolved(pkg.absRoot)
      .then((result) => {
        body.empty();
        if (result.unresolved.length === 0) {
          body.createDiv({ cls: 'vaire-empty', text: 'No loose ends.' });
          return;
        }
        const list = body.createDiv({ cls: 'vaire-unresolved-list' });
        for (const item of result.unresolved) {
          const row = list.createDiv({ cls: 'vaire-unresolved-row' });
          const ref: LooseRef = {
            kind: 'loose',
            typeHint: item.type_guess ?? undefined,
            descriptor: item.descriptor,
            raw: `?${item.type_guess ?? ''}: ${item.descriptor}`,
          };
          row.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
          row.createEl('code', { cls: 'vaire-nid', text: item.record });
          const pathLink = row.createEl('a', {
            cls: 'vaire-path-link',
            text: `${item.path}:${item.line}`,
            href: '#',
          });
          pathLink.addEventListener('click', (evt) => {
            evt.preventDefault();
            const file = this.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, item.path));
            if (file instanceof TFile) void openFileAtLine(this.app, file, item.line - 1, evt.metaKey || evt.ctrlKey);
          });
        }
      })
      .catch((err: unknown) => {
        body.empty();
        this.renderCliError(body, pkg, err, 'Could not load unresolved list');
      });
  }

  // ---- Findings -------------------------------------------------------------------------

  private renderFindings(root: HTMLElement, pkg: PackageInfo): void {
    const section = root.createDiv({ cls: 'vaire-section vaire-findings' });
    section.createEl('h2', { text: 'Findings' });

    const result: CheckResult | undefined = this.plugin.lastCheck.get(pkg.absRoot);
    if (!result) {
      section.createDiv({ cls: 'vaire-empty', text: 'Run Check to see findings.' });
      return;
    }
    this.renderFindingList(section, pkg, 'Violations', result.violations as unknown as FindingLike[]);
    this.renderFindingList(section, pkg, 'Warnings', result.warnings as unknown as FindingLike[]);
  }

  private renderFindingList(root: HTMLElement, pkg: PackageInfo, title: string, findings: FindingLike[]): void {
    const wrap = root.createDiv({ cls: 'vaire-finding-list' });
    wrap.createEl('h3', { text: `${title} (${findings.length})` });
    if (findings.length === 0) {
      wrap.createDiv({ cls: 'vaire-empty', text: 'None.' });
      return;
    }
    for (const f of findings) {
      const described = describeFinding(f);
      const row = wrap.createDiv({ cls: 'vaire-finding-row' });
      row.createSpan({ cls: 'vaire-finding-kind', text: described.title });
      if (described.detail) row.createSpan({ cls: 'vaire-finding-detail', text: described.detail });
      if (described.path) {
        const label = described.line != null ? `${described.path}:${described.line}` : described.path;
        const link = row.createEl('a', { cls: 'vaire-path-link', text: label, href: '#' });
        link.addEventListener('click', (evt) => {
          evt.preventDefault();
          const file = this.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, described.path!));
          if (file instanceof TFile) {
            void openFileAtLine(
              this.app,
              file,
              described.line != null ? described.line - 1 : undefined,
              evt.metaKey || evt.ctrlKey,
            );
          }
        });
      }

      const fixes = allFixesFor(this.plugin, f);
      if (fixes.length > 0) {
        const actions = row.createDiv({ cls: 'vaire-actions-inline vaire-finding-actions' });
        for (const fix of fixes) {
          new ButtonComponent(actions).setButtonText(fix.label).onClick(() => {
            void applyFix(this.plugin, pkg, f, fix.id);
          });
        }
      }
    }
  }
}
