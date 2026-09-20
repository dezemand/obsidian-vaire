// Catalog and registry browser. See DESIGN.md "Features §5 Catalog and registries".

import { type Debouncer, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import { VaireError } from '../cli';
import { openFileAtLine } from '../navigate';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import type { RegistryEntry, SearchHit, Sighting } from '../types';
import { confirm, promptText } from '../ui/prompt-modal';
import { ExternalNodeView } from './external-view';
import { describeRegistryShow, relativeTime, shortPath } from './pure-ext';

export const VIEW_TYPE_CATALOG = 'vaire-catalog';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CatalogView extends ItemView {
  private readonly plugin: VairePlugin;
  private catalogSectionEl!: HTMLElement;
  private registrySectionEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CATALOG;
  }

  getIcon(): string {
    return 'library';
  }

  getDisplayText(): string {
    return 'Vairë catalog';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('vaire-catalog-view');
    container.addClass('vaire-panel');
    this.catalogSectionEl = container.createDiv({ cls: 'vaire-catalog-section' });
    this.registrySectionEl = container.createDiv({ cls: 'vaire-registry-section' });
    await Promise.all([this.refreshCatalog(), this.refreshRegistries()]);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Opens (or reveals, if already open) the one catalog view in the main area. */
  static async open(plugin: VairePlugin): Promise<void> {
    const { workspace } = plugin.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CATALOG)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_CATALOG, active: true });
    await workspace.revealLeaf(leaf);
  }

  private activePackage(): PackageInfo | null {
    const file = this.app.workspace.getActiveFile();
    return file ? this.plugin.packages.packageFor(file) : null;
  }

  // ---- Catalog section ----------------------------------------------------

  private async refreshCatalog(): Promise<void> {
    const el = this.catalogSectionEl;
    el.empty();
    el.createEl('h3', { text: 'Catalog' });

    const actions = el.createDiv({ cls: 'vaire-section-actions' });
    actions.createEl('button', { text: 'Scan folder…' }).addEventListener('click', () => void this.scanFolder());
    const addBtn = actions.createEl('button', { text: 'Add current package' });
    if (!this.activePackage()) addBtn.setAttr('disabled', 'true');
    addBtn.addEventListener('click', () => void this.addCurrentPackage());
    actions.createEl('button', { text: 'Refresh' }).addEventListener('click', () => void this.refreshCatalog());

    try {
      const list = await this.plugin.cli.catalogList();
      if (list.sightings.length === 0) {
        el.createEl('p', { cls: 'vaire-empty', text: 'No packages in the catalog yet.' });
        return;
      }
      const table = el.createEl('table', { cls: 'vaire-catalog-table' });
      const headRow = table.createEl('thead').createEl('tr');
      for (const h of ['Name', 'Version', 'State', 'Origin', 'Path', 'Last seen', '']) {
        headRow.createEl('th', { text: h });
      }
      const tbody = table.createEl('tbody');
      const now = Math.floor(Date.now() / 1000);
      for (const sighting of list.sightings) {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: sighting.name });
        row.createEl('td', { text: sighting.version });
        row.createEl('td').createSpan({ cls: `vaire-badge vaire-state-${sighting.state}`, text: sighting.state });
        row.createEl('td', { text: sighting.origin });
        const pathTd = row.createEl('td', { cls: 'vaire-mono vaire-muted', text: shortPath(sighting.path, 44) });
        pathTd.setAttribute('title', sighting.path);
        row.createEl('td', { text: relativeTime(sighting.last_seen, now) });
        const actionsTd = row.createEl('td', { cls: 'vaire-row-actions' });
        actionsTd.createEl('button', { text: 'Browse' }).addEventListener('click', () => {
          new PackageBrowserModal(this.plugin, sighting).open();
        });
        actionsTd
          .createEl('button', { text: 'Forget' })
          .addEventListener('click', () => void this.forgetSighting(sighting));
      }
    } catch (err) {
      el.createDiv({ cls: 'vaire-error', text: errMessage(err) });
    }
  }

  private async scanFolder(): Promise<void> {
    const dir = await promptText(this.app, {
      title: 'Scan folder',
      placeholder: '/absolute/path/to/folder',
      submitLabel: 'Scan',
    });
    if (!dir) return;
    try {
      await this.plugin.cli.catalogScan(dir);
      new Notice(`Vairë: scanned ${dir}`);
    } catch (err) {
      new Notice(`Vairë: scan failed — ${errMessage(err)}`);
    }
    await this.refreshCatalog();
  }

  private async addCurrentPackage(): Promise<void> {
    const pkg = this.activePackage();
    if (!pkg) return;
    try {
      await this.plugin.cli.catalogAdd(pkg.absRoot);
      new Notice(`Vairë: added ${pkg.name} to the catalog`);
    } catch (err) {
      new Notice(`Vairë: could not add ${pkg.name} — ${errMessage(err)}`);
    }
    await this.refreshCatalog();
  }

  private async forgetSighting(sighting: Sighting): Promise<void> {
    const ok = await confirm(this.app, {
      title: 'Forget package',
      message: `Remove ${sighting.name} (${sighting.path}) from the catalog?`,
      okLabel: 'Forget',
    });
    if (!ok) return;
    try {
      await this.plugin.cli.catalogRm(sighting.path);
      new Notice(`Vairë: forgot ${sighting.name}`);
    } catch (err) {
      new Notice(`Vairë: could not forget ${sighting.name} — ${errMessage(err)}`);
    }
    await this.refreshCatalog();
  }

  // ---- Registries section --------------------------------------------------

  private async refreshRegistries(): Promise<void> {
    const el = this.registrySectionEl;
    el.empty();
    el.createEl('h3', { text: 'Registries' });

    const actions = el.createDiv({ cls: 'vaire-section-actions' });
    actions.createEl('button', { text: 'Add registry…' }).addEventListener('click', () => void this.addRegistry());
    actions.createEl('button', { text: 'Refresh' }).addEventListener('click', () => void this.refreshRegistries());

    try {
      const list = await this.plugin.cli.registryList();
      if (list.registries.length === 0) {
        el.createEl('p', { cls: 'vaire-empty', text: 'No registries configured.' });
        return;
      }
      const table = el.createEl('table', { cls: 'vaire-registry-table' });
      const headRow = table.createEl('thead').createEl('tr');
      for (const h of ['Name', 'URL', 'Kind', 'Priority', 'Search by default', '']) {
        headRow.createEl('th', { text: h });
      }
      const tbody = table.createEl('tbody');
      for (const reg of list.registries) {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: reg.name });
        row.createEl('td', { cls: 'vaire-mono', text: reg.url });
        row.createEl('td', { text: reg.kind });
        row.createEl('td', { text: String(reg.priority) });
        row.createEl('td', { text: reg.search_by_default ? 'yes' : 'no' });

        const actionsTd = row.createEl('td', { cls: 'vaire-row-actions' });
        const detailRow = tbody.createEl('tr', { cls: 'vaire-registry-detail-row' });
        const detailCell = detailRow.createEl('td', { attr: { colspan: 6 } });
        detailRow.hide();

        actionsTd.createEl('button', { text: 'Show' }).addEventListener('click', () => {
          if (detailRow.isShown()) {
            detailRow.hide();
            return;
          }
          detailRow.show();
          void this.showRegistryDetail(reg.name, detailCell);
        });
        actionsTd
          .createEl('button', { text: 'Remove' })
          .addEventListener('click', () => void this.removeRegistry(reg));
      }
    } catch (err) {
      el.createDiv({ cls: 'vaire-error', text: errMessage(err) });
    }
  }

  private async showRegistryDetail(name: string, container: HTMLElement): Promise<void> {
    container.empty();
    container.addClass('vaire-registry-detail');
    container.createEl('p', { cls: 'vaire-muted', text: 'Loading…' });

    let result: Record<string, unknown>;
    try {
      result = await this.plugin.cli.registryShow(name);
    } catch (err) {
      container.empty();
      container.createDiv({ cls: 'vaire-error', text: errMessage(err) });
      return;
    }

    container.empty();
    const described = describeRegistryShow(result);

    if (described.rows.length > 0) {
      const rowsEl = container.createDiv({ cls: 'vaire-registry-rows' });
      for (const [key, value] of described.rows) {
        const rowEl = rowsEl.createDiv({ cls: 'vaire-registry-row' });
        rowEl.createSpan({ cls: 'vaire-registry-row-key', text: key });
        rowEl.createSpan({ cls: 'vaire-registry-row-value', text: value });
      }
    }

    if (described.packages.length > 0) {
      const vaultPkg = this.activePackage();
      const table = container.createEl('table', { cls: 'vaire-registry-packages-table' });
      const headRow = table.createEl('thead').createEl('tr');
      for (const h of ['Package', 'Versions', 'Description', '']) headRow.createEl('th', { text: h });
      const tbody = table.createEl('tbody');
      for (const pkg of described.packages) {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: pkg.name });
        row.createEl('td', { cls: 'vaire-mono', text: pkg.versions.join(', ') });
        row.createEl('td', { text: pkg.description ?? '' });
        const actionsTd = row.createEl('td');
        const addBtn = actionsTd.createEl('button', { text: 'Add as dependency and pull' });
        if (!vaultPkg) {
          addBtn.setAttr('disabled', 'true');
          addBtn.setAttr('title', 'Open a package in the vault first');
        } else {
          addBtn.addEventListener('click', () => void this.addDependency(vaultPkg, pkg.name, name));
        }
      }
    }

    if (described.raw) {
      const pre = container.createEl('pre', { cls: 'vaire-registry-raw' });
      pre.createEl('code', { text: described.raw });
    }
  }

  private async addDependency(vaultPkg: PackageInfo, depName: string, registryName: string): Promise<void> {
    const ok = await confirm(this.app, {
      title: 'Add dependency',
      message: `Add '${depName}' as a dependency of ${vaultPkg.name} and pull it from '${registryName}'?`,
      okLabel: 'Add & pull',
    });
    if (!ok) return;
    try {
      await this.plugin.cli.add(vaultPkg.absRoot, depName);
      new Notice(`Vairë: added ${depName} to ${vaultPkg.name}`);
    } catch (err) {
      new Notice(`Vairë: could not add ${depName} — ${errMessage(err)}`);
      return;
    }
    try {
      await this.plugin.cli.pull(vaultPkg.absRoot, depName, { registry: registryName });
      new Notice(`Vairë: pulled ${depName}`);
    } catch (err) {
      new Notice(`Vairë: pull failed for ${depName} — ${errMessage(err)}`);
      return;
    }
    await this.plugin.rebuildIndex(vaultPkg);
  }

  private async addRegistry(): Promise<void> {
    const name = await promptText(this.app, { title: 'Add registry — name', placeholder: 'name', submitLabel: 'Next' });
    if (!name) return;
    const url = await promptText(this.app, {
      title: 'Add registry — URL or directory',
      placeholder: 'https://… or /absolute/path',
      submitLabel: 'Add',
    });
    if (!url) return;
    try {
      await this.plugin.cli.registryAdd(name, url);
      new Notice(`Vairë: added registry '${name}'`);
    } catch (err) {
      new Notice(`Vairë: could not add registry — ${errMessage(err)}`);
    }
    await this.refreshRegistries();
  }

  private async removeRegistry(reg: RegistryEntry): Promise<void> {
    const ok = await confirm(this.app, {
      title: 'Remove registry',
      message: `Remove registry '${reg.name}'?`,
      okLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await this.plugin.cli.registryRm(reg.name);
      new Notice(`Vairë: removed registry '${reg.name}'`);
    } catch (err) {
      new Notice(`Vairë: could not remove '${reg.name}' — ${errMessage(err)}`);
    }
    await this.refreshRegistries();
  }
}

/** Status + search over one catalog package, opened from a "Browse" row action. */
class PackageBrowserModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly sighting: Sighting;
  private readonly vaultPkg: PackageInfo | null;
  private readonly debouncedSearch: Debouncer<[string], void>;
  private resultsEl!: HTMLElement;

  constructor(plugin: VairePlugin, sighting: Sighting) {
    super(plugin.app);
    this.plugin = plugin;
    this.sighting = sighting;
    this.vaultPkg = plugin.packages.all().find((p) => p.absRoot === sighting.path) ?? null;
    this.debouncedSearch = debounce((q: string) => void this.runSearch(q), 250, true);
  }

  onOpen(): void {
    this.setTitle(`${this.sighting.name} ${this.sighting.version}`);
    const { contentEl } = this;
    contentEl.addClass('vaire-package-browser');

    if (this.vaultPkg) {
      contentEl.createEl('p', { cls: 'vaire-muted', text: 'This package is in the vault.' });
    }

    const statusEl = contentEl.createDiv({ cls: 'vaire-package-browser-status' });
    void this.loadStatus(statusEl);

    new Setting(contentEl).setName('Search').addText((text) => {
      text.setPlaceholder('Search this package…');
      text.onChange((value) => this.debouncedSearch(value));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    this.resultsEl = contentEl.createDiv({ cls: 'vaire-package-browser-results' });
  }

  onClose(): void {
    this.debouncedSearch.cancel();
    this.contentEl.empty();
  }

  private async loadStatus(container: HTMLElement): Promise<void> {
    container.empty();
    try {
      const status = await this.plugin.cli.status(this.sighting.path);
      const types = Object.entries(status.nodes.by_type).sort((a, b) => b[1] - a[1]);
      if (types.length === 0) {
        container.createEl('p', { cls: 'vaire-muted', text: `${status.nodes.total} node(s).` });
        return;
      }
      const list = container.createDiv({ cls: 'vaire-type-counts' });
      for (const [type, count] of types) {
        list.createSpan({ cls: 'vaire-badge', text: `${type} · ${count}` });
      }
    } catch (err) {
      if (err instanceof VaireError && err.kind === 'index_not_built') {
        container.createEl('p', { text: 'The index for this package has not been built yet.' });
        const btn = container.createEl('button', { text: 'Build index' });
        btn.addEventListener('click', () => void this.buildIndex(container, btn));
        return;
      }
      container.createDiv({ cls: 'vaire-error', text: errMessage(err) });
    }
  }

  private async buildIndex(container: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      await this.plugin.cli.index(this.sighting.path, {});
      await this.loadStatus(container);
    } catch (err) {
      new Notice(`Vairë: could not build the index — ${errMessage(err)}`);
      btn.disabled = false;
    }
  }

  private async runSearch(query: string): Promise<void> {
    const q = query.trim();
    this.resultsEl.empty();
    if (!q) return;
    try {
      const result = await this.plugin.cli.search(this.sighting.path, q, { limit: 20, local: true });
      if (result.results.length === 0) {
        this.resultsEl.createEl('p', { cls: 'vaire-muted', text: 'No matches.' });
        return;
      }
      for (const hit of result.results) {
        const row = this.resultsEl.createDiv({ cls: 'vaire-package-browser-hit' });
        row.createDiv({ cls: 'vaire-hit-name', text: hit.id });
        row.createDiv({ cls: 'vaire-hit-type vaire-muted', text: hit.type });
        const snippet = hit.anchors[0]?.snippet;
        if (snippet) row.createDiv({ cls: 'vaire-hit-snippet vaire-muted', text: snippet });
        row.addEventListener('click', () => void this.openHit(hit));
      }
    } catch (err) {
      this.resultsEl.createDiv({ cls: 'vaire-error', text: errMessage(err) });
    }
  }

  private async openHit(hit: SearchHit): Promise<void> {
    if (this.vaultPkg) {
      const vaultPkg = this.vaultPkg;
      const relPath = vaultPkg.dir ? `${vaultPkg.dir}/${hit.path}` : hit.path;
      const file = this.plugin.app.vault.getAbstractFileByPath(relPath);
      if (file instanceof TFile) {
        await openFileAtLine(this.plugin.app, file, hit.anchors[0]?.line);
      } else {
        new Notice(`Vairë: not found in vault: ${relPath}`);
      }
      this.close();
      return;
    }
    await ExternalNodeView.open(this.plugin, {
      repo: this.sighting.path,
      id: hit.id,
      pkg: this.sighting.name,
      version: this.sighting.version,
    });
    this.close();
  }
}
