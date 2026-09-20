// Persistent Vairë search panel (right sidebar). Complements the one-shot "Search" command
// modal (src/suggest/search-modal.ts, which stays as-is) with a panel that keeps its query,
// filters and history around while you browse, and follows the active file's package. See
// the search-panel feature spec in DESIGN.md / BRANCHES.md and "Phase 2 ownership" for the
// shared `createRefElement` contract this view relies on for card titles.

import { ButtonComponent, DropdownComponent, ItemView, Notice, TextComponent, TFile, WorkspaceLeaf } from 'obsidian';
import { VaireError } from '../cli';
import { parseRef, type IdRef } from '../ids';
import type VairePlugin from '../main';
import { openFileAtLine, openRef } from '../navigate';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import type { VaireSettings } from '../settings';
import type { Anchor, SearchHit } from '../types';
import { highlightTerms, pushHistory, typesInResults } from './pure-search';

export const VIEW_TYPE_SEARCH = 'vaire-search';

const SEARCH_DEBOUNCE_MS = 250;
const HISTORY_MAX = 10;
const LIMIT_OPTIONS: number[] = [10, 20, 50];
const DEFAULT_LIMIT = 20;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SearchView extends ItemView {
  private readonly plugin: VairePlugin;

  private currentPkg: PackageInfo | null = null;
  private query = '';
  private searchScope: VaireSettings['searchScope'] = 'deps';
  private typeFilter = '';
  private scopeContainer = '';
  private limit: number = DEFAULT_LIMIT;

  private lastResults: SearchHit[] = [];
  /** The query that actually produced `lastResults` — kept separate from the live `query`
   *  field so a snippet's highlighted terms never race ahead of a debounced/in-flight search. */
  private resultsQuery = '';
  private loading = false;
  private errorObj: unknown = null;
  /** Bumped on every search; a stale (superseded) response is discarded. */
  private seq = 0;
  private debounceTimer: number | null = null;

  private resultsEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null;
  private typeDropdown: DropdownComponent | null = null;
  private queryInputEl: HTMLInputElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SEARCH;
  }

  getIcon(): string {
    return 'search';
  }

  getDisplayText(): string {
    return 'Vairë search';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-search-view');
    this.searchScope = this.plugin.settings.searchScope;

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.followFile(file)));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.followFile(this.app.workspace.getActiveFile())),
    );
    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        if (this.currentPkg && this.currentPkg.absRoot === root) void this.runSearch();
      }),
    );
    // Cold start: the vault's packages may still be scanning when this view opens (see
    // PackageRegistry.init in src/packages.ts); once the first pass completes, pick up
    // whichever package the active file actually belongs to instead of staying on "no package".
    this.registerEvent(
      this.plugin.events.on('local-index-rebuilt', () => this.followFile(this.app.workspace.getActiveFile())),
    );

    this.followFile(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer != null) window.clearTimeout(this.debounceTimer);
    this.contentEl.empty();
  }

  // ---- package following -----------------------------------------------------------------

  /** The query follows the active file's package; with no active file (or file outside any
   *  package), falls back to the first vault package, matching activePackageOrFirst() in
   *  package-node.ts. */
  private followFile(file: TFile | null): void {
    const filePkg = file ? this.plugin.packages.packageFor(file) : null;
    const resolved = filePkg ?? this.plugin.packages.all()[0] ?? null;
    const changed = (resolved?.absRoot ?? null) !== (this.currentPkg?.absRoot ?? null);
    this.currentPkg = resolved;
    if (!changed) return;

    this.lastResults = [];
    this.errorObj = null;
    this.loading = false;
    this.render();
    if (this.query.trim()) this.scheduleSearch(true); // keep searching, now against the new package
  }

  // ---- layout -------------------------------------------------------------------------------

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.resultsEl = null;
    this.historyEl = null;
    this.typeDropdown = null;
    this.queryInputEl = null;

    const pkg = this.currentPkg;
    if (!pkg) {
      contentEl.createDiv({ cls: 'vaire-empty', text: 'No package found in this vault.' });
      return;
    }

    this.buildHeader(contentEl, pkg);
    this.buildControls(contentEl, pkg);
    this.resultsEl = contentEl.createDiv({ cls: 'vaire-search-results' });
    this.renderResults();
  }

  private buildHeader(root: HTMLElement, pkg: PackageInfo): void {
    const header = root.createDiv({ cls: 'vaire-search-header' });
    header.createSpan({ cls: 'vaire-muted', text: 'Searching ' });
    header.createSpan({ cls: 'vaire-search-pkg-name', text: pkg.name });
  }

  private buildControls(root: HTMLElement, pkg: PackageInfo): void {
    const controls = root.createDiv({ cls: 'vaire-search-controls' });

    const query = new TextComponent(controls);
    query.inputEl.addClass('vaire-search-input');
    query.setPlaceholder(`Search ${pkg.name}…`).setValue(this.query);
    this.queryInputEl = query.inputEl;
    query.onChange((value) => {
      this.query = value;
      this.scheduleSearch(false);
    });
    query.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter') return;
      evt.preventDefault();
      this.scheduleSearch(true);
    });

    const filters = controls.createDiv({ cls: 'vaire-search-filters' });

    const scopeDropdown = new DropdownComponent(filters);
    scopeDropdown.selectEl.addClass('vaire-search-scope-select');
    scopeDropdown.addOptions({ local: 'This package', deps: 'Package + dependencies', all: 'Every catalog package' });
    scopeDropdown.setValue(this.searchScope);
    scopeDropdown.onChange((value) => {
      this.searchScope = value as VaireSettings['searchScope'];
      this.plugin.settings.searchScope = this.searchScope;
      void this.plugin.saveSettings();
      this.scheduleSearch(true);
    });

    this.typeDropdown = new DropdownComponent(filters);
    this.typeDropdown.selectEl.addClass('vaire-search-type-select');
    this.refreshTypeOptions(pkg);
    this.typeDropdown.onChange((value) => {
      this.typeFilter = value;
      this.scheduleSearch(true);
    });

    const scopeInput = new TextComponent(filters);
    scopeInput.inputEl.addClass('vaire-search-scope-input');
    scopeInput.setPlaceholder('Scope to container id…').setValue(this.scopeContainer);
    scopeInput.onChange((value) => {
      this.scopeContainer = value;
      this.scheduleSearch(false);
    });

    const limitDropdown = new DropdownComponent(filters);
    limitDropdown.selectEl.addClass('vaire-search-limit-select');
    for (const n of LIMIT_OPTIONS) limitDropdown.addOption(String(n), `${n} results`);
    limitDropdown.setValue(String(this.limit));
    limitDropdown.onChange((value) => {
      const n = Number(value);
      this.limit = LIMIT_OPTIONS.includes(n) ? n : DEFAULT_LIMIT;
      this.scheduleSearch(true);
    });

    this.historyEl = controls.createDiv({ cls: 'vaire-search-history vaire-chips' });
    this.renderHistory();
  }

  /** Rebuilds the type dropdown's options from `pkg.types` ∪ the types seen in the last
   *  results, preserving the current selection when it's still among them. */
  private refreshTypeOptions(pkg: PackageInfo): void {
    const dropdown = this.typeDropdown;
    if (!dropdown) return;
    const options = [...new Set([...pkg.types, ...typesInResults(this.lastResults)])].sort((a, b) =>
      a.localeCompare(b),
    );
    if (!options.includes(this.typeFilter)) this.typeFilter = '';
    dropdown.selectEl.empty();
    dropdown.addOption('', 'All types');
    for (const t of options) dropdown.addOption(t, t);
    dropdown.setValue(this.typeFilter);
  }

  private renderHistory(): void {
    const el = this.historyEl;
    if (!el) return;
    el.empty();
    for (const q of this.plugin.settings.searchHistory) {
      const chip = el.createEl('button', { cls: 'vaire-chip', text: q });
      chip.addEventListener('click', () => {
        this.query = q;
        if (this.queryInputEl) this.queryInputEl.value = q;
        this.scheduleSearch(true);
      });
    }
  }

  // ---- search ---------------------------------------------------------------------------

  private scheduleSearch(immediate: boolean): void {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (immediate) {
      void this.runSearch();
      return;
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(): Promise<void> {
    const pkg = this.currentPkg;
    if (!pkg) return;
    const q = this.query.trim();
    const mySeq = ++this.seq;

    if (!q) {
      this.loading = false;
      this.errorObj = null;
      this.lastResults = [];
      this.renderResults();
      return;
    }

    this.loading = true;
    this.errorObj = null;
    this.renderResults();

    const opts: { limit?: number; type?: string; all?: boolean; local?: boolean; scope?: string } = {
      limit: this.limit,
    };
    if (this.typeFilter) opts.type = this.typeFilter;
    const scopeContainer = this.scopeContainer.trim();
    if (scopeContainer) opts.scope = scopeContainer;
    if (this.searchScope === 'local') opts.local = true;
    else if (this.searchScope === 'all') opts.all = true;

    try {
      const result = await this.plugin.cli.search(pkg.absRoot, q, opts);
      if (mySeq !== this.seq) return; // superseded by a newer search
      this.loading = false;
      this.lastResults = result.results;
      this.resultsQuery = q;
      this.errorObj = null;
      this.recordHistory(q);
      this.refreshTypeOptions(pkg);
      this.renderResults();
    } catch (err) {
      if (mySeq !== this.seq) return;
      this.loading = false;
      this.lastResults = [];
      this.errorObj = err;
      this.renderResults();
    }
  }

  private recordHistory(q: string): void {
    this.plugin.settings.searchHistory = pushHistory(this.plugin.settings.searchHistory, q, HISTORY_MAX);
    void this.plugin.saveSettings();
    this.renderHistory();
  }

  // ---- results --------------------------------------------------------------------------

  private renderResults(): void {
    const el = this.resultsEl;
    const pkg = this.currentPkg;
    if (!el || !pkg) return;
    el.empty();

    if (this.loading) {
      el.createDiv({ cls: 'vaire-empty', text: 'Searching…' });
      return;
    }
    if (this.errorObj) {
      this.renderError(el, pkg, this.errorObj);
      return;
    }
    if (!this.query.trim()) {
      el.createDiv({ cls: 'vaire-empty', text: `Type a query to search ${pkg.name}.` });
      return;
    }
    if (this.lastResults.length === 0) {
      el.createDiv({ cls: 'vaire-empty', text: 'No results.' });
      return;
    }
    for (const hit of this.lastResults) this.renderCard(el, pkg, hit);
  }

  private renderError(container: HTMLElement, pkg: PackageInfo, err: unknown): void {
    const div = container.createDiv({ cls: 'vaire-error' });
    div.createSpan({ text: `Search failed — ${errMessage(err)}` });
    if (err instanceof VaireError && err.kind === 'index_not_built') {
      div.createEl('br');
      new ButtonComponent(div).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  private renderCard(container: HTMLElement, pkg: PackageInfo, hit: SearchHit): void {
    const card = container.createDiv({ cls: 'vaire-search-card' });
    const head = card.createDiv({ cls: 'vaire-search-card-header' });

    // Name: resolved via LocalIndex when local, else the bare id until plugin.resolveViaCli
    // (invoked by createRefElement itself) fills it in — same resolution/click behavior as
    // every other reference in the plugin.
    const ref = parseRef(hit.id);
    if (ref && ref.kind === 'id') {
      head.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
    } else {
      head.createEl('code', { cls: 'vaire-nid', text: hit.id });
    }

    head.createSpan({ cls: 'vaire-badge', text: hit.type });
    if (hit.package) head.createSpan({ cls: 'vaire-search-pkg-badge', text: `@${hit.package}` });
    head.createSpan({
      cls: 'vaire-muted vaire-search-score',
      text: Number.isFinite(hit.score) ? hit.score.toFixed(2) : '—',
    });

    if (hit.anchors.length > 0) {
      const anchors = card.createDiv({ cls: 'vaire-search-anchors' });
      for (const anchor of hit.anchors) this.renderAnchor(anchors, pkg, hit, anchor);
    }
  }

  private renderAnchor(container: HTMLElement, pkg: PackageInfo, hit: SearchHit, anchor: Anchor): void {
    const row = container.createDiv({ cls: 'vaire-search-anchor' });
    row.createDiv({
      cls: 'vaire-search-anchor-meta',
      text: `${anchor.heading || '(no heading)'} · line ${anchor.line}`,
    });
    if (anchor.snippet) {
      const snippetEl = row.createDiv({ cls: 'vaire-search-snippet' });
      for (const seg of highlightTerms(anchor.snippet, this.resultsQuery)) {
        if (seg.hit) snippetEl.createEl('mark', { cls: 'vaire-hit', text: seg.text });
        else snippetEl.appendText(seg.text);
      }
    }
    row.addEventListener('click', (evt) => {
      void this.openHit(pkg, hit, anchor, evt.metaKey || evt.ctrlKey);
    });
  }

  /** Vault hit (local to `pkg`, or to another vault package) -> open the file at the anchor's
   *  line. Dependency hit -> open the external read-only view (which has no line granularity,
   *  same as every other external reference in the plugin — see src/render/ref-el.ts). */
  private async openHit(pkg: PackageInfo, hit: SearchHit, anchor: Anchor, newLeaf: boolean): Promise<void> {
    const ref = parseRef(hit.id);
    if (!ref || ref.kind !== 'id') {
      new Notice(`Vairë: could not parse id ${hit.id}`);
      return;
    }
    const node = this.localNodeFor(ref, pkg);
    if (node) {
      await openFileAtLine(this.app, node.file, Math.max(0, anchor.line - 1), newLeaf);
      return;
    }
    await openRef(this.plugin, ref, pkg, { newLeaf });
  }

  private localNodeFor(ref: IdRef, pkg: PackageInfo): LocalNode | null {
    if (!ref.pkg) return pkg.index.get(ref.local);
    const vaultPkg = this.plugin.packages.byName(ref.pkg);
    return vaultPkg ? vaultPkg.index.get(ref.local) : null;
  }
}
