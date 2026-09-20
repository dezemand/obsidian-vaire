// The loose-end workbench: the human UI for the entity-creation pass (see the
// `vaire-entity-creation` skill). Lists every `[[?...]]` in the active package, grouped by one
// of two clustering strategies (src/workbench/pure.ts), and offers group-level actions —
// resolve every occurrence to an existing node, create a new node and resolve to it, accept a
// CLI suggestion, or skip for this session. See DESIGN.md's "Rendering conventions" /
// "§6 Package view and node panel" for the visual language this reuses (sections, chips,
// path-link rows, CLI-error handling with a Rebuild-index hint).

import { ButtonComponent, ItemView, TFile, TextComponent, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { VaireError } from '../cli';
import { openFileAtLine } from '../navigate';
import type { PackageInfo } from '../packages';
import { NewNodeModal } from '../authoring/new-node-modal';
import { VaireResolveModal } from '../suggest/resolve-modal';
import type { Candidate } from '../suggest/pure';
import { confirm } from '../ui/prompt-modal';
import type { LooseEndItem, Suggestion } from '../types';
import { vaultPathFor } from '../views/pure-pkg';
import { resolveGroup } from './apply';
import { DEFAULT_FUZZY_THRESHOLD, filterGroups, groupExact, groupFuzzy, type LooseEndGroup } from './pure';
import type VairePlugin from '../main';

export const VIEW_TYPE_WORKBENCH = 'vaire-unresolved';

interface WorkbenchViewState {
  packageDir: string;
}

type SuggestState = 'loading' | 'error' | Suggestion[];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

function suggestionToCandidate(s: Suggestion): Candidate {
  return { id: s.id, name: s.name, type: s.type, pkg: s.package, source: 'cli', score: s.score };
}

export class WorkbenchView extends ItemView {
  private readonly plugin: VairePlugin;
  private packageDir = '';
  private grouping: 'exact' | 'fuzzy';
  private textFilter = '';
  private typeFilter: string | null = null;
  /** Group keys hidden for this session only (never persisted — a fresh open shows everything
   *  the CLI still reports as unresolved). */
  private readonly skipped = new Set<string>();
  private resolvedThisSession = 0;
  private items: LooseEndItem[] | null = null;
  private loading = false;
  private loadError: unknown = null;
  private readonly suggestionsByKey = new Map<string, SuggestState>();
  private metaDebounce: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.grouping = plugin.settings.workbenchGrouping;
  }

  getViewType(): string {
    return VIEW_TYPE_WORKBENCH;
  }

  getIcon(): string {
    return 'help-circle';
  }

  getDisplayText(): string {
    const pkg = this.currentPkg();
    return pkg ? `${pkg.name} · Loose ends` : 'Loose-end workbench';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), packageDir: this.packageDir };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<WorkbenchViewState> | undefined;
    if (s && typeof s.packageDir === 'string') this.packageDir = s.packageDir;
    await super.setState(state, result);
    await this.reload();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-workbench-view');

    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        const pkg = this.currentPkg();
        if (pkg && pkg.absRoot === root) void this.reload();
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

    await this.reload();
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
      void this.reload();
    }, 500);
  }

  /** Re-fetches `cli.unresolved` and re-renders. Called after `onOpen`/`setState`, on
   *  `index-rebuilt` for this package, on file changes, and by the Refresh button — i.e. after
   *  every rewrite, per the "rebuildIndex then reload" sequence (rebuildIndex itself happens
   *  inside `resolveGroup`/`NewNodeModal`; this is the "reload" half). */
  private async reload(): Promise<void> {
    const pkg = this.currentPkg();
    if (!pkg) {
      this.items = null;
      this.render();
      return;
    }
    this.loading = true;
    this.loadError = null;
    this.render();
    try {
      const result = await this.plugin.cli.unresolved(pkg.absRoot);
      this.items = result.unresolved;
    } catch (err) {
      this.loadError = err;
      this.items = null;
    }
    this.loading = false;
    this.render();
  }

  // ---- Rendering --------------------------------------------------------------------------

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const pkg = this.currentPkg();
    if (!pkg) {
      contentEl.createDiv({ cls: 'vaire-error', text: 'This package is no longer in the vault.' });
      return;
    }

    contentEl.createEl('h1', { text: 'Loose-end workbench' });

    if (this.loading && this.items === null) {
      contentEl.createDiv({ cls: 'vaire-muted', text: 'Loading…' });
      return;
    }
    if (this.loadError) {
      const div = contentEl.createDiv({ cls: 'vaire-error' });
      div.createSpan({ text: `Could not load unresolved references — ${errMessage(this.loadError)}` });
      if (isIndexNotBuilt(this.loadError)) {
        div.createEl('br');
        new ButtonComponent(div).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
      }
      return;
    }

    const items = this.items ?? [];
    const allGroups = this.grouping === 'fuzzy' ? groupFuzzy(items, DEFAULT_FUZZY_THRESHOLD) : groupExact(items);
    const visibleGroups = filterGroups(allGroups, {
      text: this.textFilter,
      type: this.typeFilter ?? undefined,
    }).filter((g) => !this.skipped.has(g.key));

    this.renderHeader(contentEl, pkg, items, visibleGroups);

    const groupsEl = contentEl.createDiv({ cls: 'vaire-workbench-groups' });
    if (visibleGroups.length === 0) {
      groupsEl.createDiv({
        cls: 'vaire-empty',
        text: items.length === 0 ? 'No loose ends in this package.' : 'No groups match the current filters.',
      });
      return;
    }
    for (const group of visibleGroups) this.renderGroup(groupsEl, pkg, group);
  }

  private renderHeader(
    root: HTMLElement,
    pkg: PackageInfo,
    items: LooseEndItem[],
    visibleGroups: LooseEndGroup[],
  ): void {
    const header = root.createDiv({ cls: 'vaire-section vaire-workbench-header' });

    const totalOccurrences = visibleGroups.reduce((sum, g) => sum + g.count, 0);
    const totals = header.createDiv({ cls: 'vaire-status-line' });
    totals.createSpan({ cls: 'vaire-status-item', text: `${visibleGroups.length} group(s)` });
    totals.createSpan({ cls: 'vaire-status-item', text: `${totalOccurrences} occurrence(s)` });
    totals.createSpan({ cls: 'vaire-status-item', text: `${this.resolvedThisSession} resolved this session` });

    const controls = header.createDiv({ cls: 'vaire-contents-controls' });

    // Grouping-strategy toggle.
    const groupingRow = controls.createDiv({ cls: 'vaire-chips' });
    for (const mode of ['exact', 'fuzzy'] as const) {
      const chip = groupingRow.createEl('button', { cls: 'vaire-chip', text: mode === 'exact' ? 'Exact' : 'Fuzzy' });
      if (this.grouping === mode) chip.addClass('is-active');
      chip.addEventListener('click', () => {
        if (this.grouping === mode) return;
        this.grouping = mode;
        this.plugin.settings.workbenchGrouping = mode;
        void this.plugin.saveSettings();
        this.render();
      });
    }

    // Type filter.
    const typeHints = [...new Set(items.map((i) => i.type_guess).filter((t): t is string => !!t))].sort((a, b) =>
      a.localeCompare(b),
    );
    if (typeHints.length > 0) {
      const typeRow = controls.createDiv({ cls: 'vaire-chips' });
      const allChip = typeRow.createEl('button', { cls: 'vaire-chip', text: 'All types' });
      if (!this.typeFilter) allChip.addClass('is-active');
      allChip.addEventListener('click', () => {
        this.typeFilter = null;
        this.render();
      });
      for (const hint of typeHints) {
        const chip = typeRow.createEl('button', { cls: 'vaire-chip', text: hint });
        if (this.typeFilter === hint) chip.addClass('is-active');
        chip.addEventListener('click', () => {
          this.typeFilter = hint;
          this.render();
        });
      }
    }

    // Text filter + Refresh.
    const filterRow = controls.createDiv({ cls: 'vaire-actions' });
    const filterText = new TextComponent(filterRow);
    filterText.setPlaceholder('Filter by descriptor, record, path…').setValue(this.textFilter);
    filterText.inputEl.addClass('vaire-text-filter');
    filterText.onChange((value) => {
      this.textFilter = value;
      this.render();
    });
    new ButtonComponent(filterRow).setButtonText('Refresh').onClick(() => void this.reload());
  }

  private renderGroup(root: HTMLElement, pkg: PackageInfo, group: LooseEndGroup): void {
    const gEl = root.createDiv({ cls: 'vaire-section vaire-workbench-group' });

    const headerRow = gEl.createDiv({ cls: 'vaire-workbench-group-header' });
    for (const hint of group.typeHints) {
      headerRow.createSpan({ cls: 'vaire-badge', text: hint ?? '?' });
    }
    headerRow.createEl('strong', { cls: 'vaire-workbench-label', text: group.label });
    headerRow.createSpan({ cls: 'vaire-muted', text: `(${group.count})` });

    if (group.descriptors.length > 1) {
      const variants = gEl.createDiv({ cls: 'vaire-workbench-descriptors' });
      for (const d of group.descriptors) {
        variants.createSpan({ cls: 'vaire-alias-chip', text: d });
      }
    }

    const occList = gEl.createDiv({ cls: 'vaire-workbench-occurrences' });
    for (const occ of group.occurrences) {
      const row = occList.createDiv({ cls: 'vaire-unresolved-row' });
      row.createEl('code', { cls: 'vaire-nid', text: occ.record });
      row.createSpan({ cls: 'vaire-muted', text: occ.descriptor });
      const pathLink = row.createEl('a', { cls: 'vaire-path-link', text: `${occ.path}:${occ.line}`, href: '#' });
      pathLink.addEventListener('click', (evt) => {
        evt.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, occ.path));
        if (file instanceof TFile) void openFileAtLine(this.app, file, occ.line - 1, evt.metaKey || evt.ctrlKey);
      });
    }

    const actions = gEl.createDiv({ cls: 'vaire-actions' });
    new ButtonComponent(actions).setButtonText('Resolve to existing…').onClick(() => this.openResolveModal(pkg, group));
    new ButtonComponent(actions).setButtonText('Create entity…').onClick(() => this.openCreateModal(pkg, group));
    new ButtonComponent(actions).setButtonText('Skip').onClick(() => {
      this.skipped.add(group.key);
      this.render();
    });

    this.renderSuggestions(gEl, pkg, group);
  }

  private firstTypeHint(group: LooseEndGroup): string | undefined {
    return group.typeHints.find((h): h is string => h !== null);
  }

  private openResolveModal(pkg: PackageInfo, group: LooseEndGroup): void {
    new VaireResolveModal(this.plugin, pkg, group.label, this.firstTypeHint(group), (candidate) => {
      void this.applyAndReload(pkg, group, candidate);
    }).open();
  }

  private openCreateModal(pkg: PackageInfo, group: LooseEndGroup): void {
    new NewNodeModal(this.plugin, pkg, {
      defaultType: this.firstTypeHint(group),
      defaultName: group.label,
      onCreated: (result) => {
        void this.applyAndReload(pkg, group, {
          id: result.fullId,
          name: result.name,
          type: result.type,
          source: 'local',
        });
      },
    }).open();
  }

  private async applyAndReload(pkg: PackageInfo, group: LooseEndGroup, candidate: Candidate): Promise<void> {
    const result = await resolveGroup(this.plugin, pkg, group, candidate);
    this.resolvedThisSession += result.succeeded;
    await this.reload();
  }

  // ---- Inline suggestions -------------------------------------------------------------------

  private renderSuggestions(root: HTMLElement, pkg: PackageInfo, group: LooseEndGroup): void {
    const section = root.createDiv({ cls: 'vaire-workbench-suggestions' });
    const state = this.suggestionsByKey.get(group.key);

    if (state === undefined) {
      section.createDiv({ cls: 'vaire-muted', text: 'Loading suggestions…' });
      this.suggestionsByKey.set(group.key, 'loading');
      void this.fetchSuggestions(pkg, group);
      return;
    }
    if (state === 'loading') {
      section.createDiv({ cls: 'vaire-muted', text: 'Loading suggestions…' });
      return;
    }
    if (state === 'error') {
      section.createDiv({ cls: 'vaire-muted', text: 'Could not load suggestions.' });
      return;
    }
    if (state.length === 0) {
      section.createDiv({ cls: 'vaire-muted', text: 'No suggestions.' });
      return;
    }
    for (const suggestion of state) {
      const item = section.createEl('button', { cls: 'vaire-chip vaire-workbench-suggestion' });
      const label = suggestion.package ? `${suggestion.name} · @${suggestion.package}` : suggestion.name;
      item.setText(`${label} — ${suggestion.type}:${suggestion.id.replace(/^@[^/]+\//, '')} (${suggestion.score.toFixed(2)})`);
      item.addEventListener('click', () => void this.chooseSuggestion(pkg, group, suggestion));
    }
  }

  private async fetchSuggestions(pkg: PackageInfo, group: LooseEndGroup): Promise<void> {
    const typeHint = this.firstTypeHint(group);
    try {
      let result = await this.plugin.cli.suggest(pkg.absRoot, group.label, {
        type: typeHint,
        limit: 3,
        all: this.plugin.settings.suggestAll,
      });
      if (typeHint && result.suggestions.length === 0) {
        result = await this.plugin.cli.suggest(pkg.absRoot, group.label, { limit: 3, all: this.plugin.settings.suggestAll });
      }
      this.suggestionsByKey.set(group.key, result.suggestions);
    } catch (err) {
      console.debug('vaire: workbench cli.suggest failed', err);
      this.suggestionsByKey.set(group.key, 'error');
    }
    this.render();
  }

  private async chooseSuggestion(pkg: PackageInfo, group: LooseEndGroup, suggestion: Suggestion): Promise<void> {
    const ok = await confirm(this.app, {
      title: 'Resolve group',
      message: `Resolve ${group.count} occurrence(s) of "${group.label}" to ${suggestion.name} (${suggestion.type}:${suggestion.id})?`,
      okLabel: 'Resolve',
    });
    if (!ok) return;
    await this.applyAndReload(pkg, group, suggestionToCandidate(suggestion));
  }
}
