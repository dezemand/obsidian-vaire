// Dedicated Vairë backlinks view (right sidebar), modeled on Obsidian's core backlinks pane:
// a search box filtering by text, collapsible groups per referencing node (name + `type:id` +
// count), a "Group by type" toggle, and a footer count. Follows the active file; refreshes on
// `index-rebuilt`. See BRANCHES.md "feat/backlinks-context" and DESIGN.md "§6 Package view and
// node panel".

import { type Debouncer, ItemView, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import { VaireError } from '../cli';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { loadBacklinkContexts, type BacklinkContext } from './backlinks-data';
import { openBacklinkContext, refForContext, renderBacklinkSnippet } from './backlinks-render';
import { filterContexts, groupByNode, type NodeGroup } from './pure-backlinks';

export const VIEW_TYPE_BACKLINKS = 'vaire-backlinks';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

/** Identifies a node group for the collapsed-state set: `package ?? ''` + id. */
function groupKey(group: Pick<NodeGroup, 'id' | 'package'>): string {
  return `${group.package ?? ''}\u0000${group.id}`;
}

export class BacklinksView extends ItemView {
  private readonly plugin: VairePlugin;
  private currentFile: TFile | null = null;
  private query = '';
  private groupByType = false;
  private readonly collapsed = new Set<string>();
  private readonly debouncedRender: Debouncer<[], void>;

  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private lastContexts: BacklinkContext[] | null = null;
  private lastPkg: PackageInfo | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.debouncedRender = debounce(() => this.renderFiltered(), 120, true);
  }

  getViewType(): string {
    return VIEW_TYPE_BACKLINKS;
  }

  getIcon(): string {
    return 'links-coming-in';
  }

  getDisplayText(): string {
    return 'Vairë backlinks';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-backlinks-view');
    this.buildChrome();

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.followFile(file)));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.followFile(this.app.workspace.getActiveFile())),
    );
    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        const pkg = this.currentFile ? this.plugin.packages.packageFor(this.currentFile) : null;
        if (pkg && pkg.absRoot === root) this.reload();
      }),
    );

    this.followFile(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  // ---- chrome (search box, toggle, containers) -------------------------------------------

  private buildChrome(): void {
    const { contentEl } = this;
    contentEl.empty();

    const toolbar = contentEl.createDiv({ cls: 'vaire-backlinks-toolbar' });
    this.headerEl = toolbar.createDiv({ cls: 'vaire-backlinks-target' });

    const searchEl = toolbar.createEl('input', {
      cls: 'vaire-backlinks-search',
      attr: { type: 'search', placeholder: 'Search backlinks…' },
    });
    searchEl.addEventListener('input', () => {
      this.query = searchEl.value;
      this.debouncedRender();
    });

    const toggleLabel = toolbar.createEl('label', { cls: 'vaire-backlinks-toggle' });
    const checkbox = toggleLabel.createEl('input', { attr: { type: 'checkbox' } });
    checkbox.checked = this.groupByType;
    toggleLabel.appendText(' Group by type');
    checkbox.addEventListener('change', () => {
      this.groupByType = checkbox.checked;
      this.collapsed.clear();
      this.renderFiltered();
    });

    this.bodyEl = contentEl.createDiv({ cls: 'vaire-backlinks-body' });
    this.footerEl = contentEl.createDiv({ cls: 'vaire-backlinks-footer' });
  }

  // ---- following the active file ----------------------------------------------------------

  private followFile(file: TFile | null): void {
    this.currentFile = file;
    this.collapsed.clear();
    this.reload();
  }

  private currentTarget(): { pkg: PackageInfo; node: LocalNode } | null {
    const file = this.currentFile;
    if (!file) return null;
    const pkg = this.plugin.packages.packageFor(file);
    if (!pkg) return null;
    const node = pkg.index.byFile(file);
    if (!node) return null;
    return { pkg, node };
  }

  private reload(): void {
    const target = this.currentTarget();
    this.lastContexts = null;
    this.lastPkg = target?.pkg ?? null;
    this.headerEl.empty();
    this.bodyEl.empty();
    this.footerEl.empty();

    if (!this.currentFile) {
      this.headerEl.setText('No file open.');
      return;
    }
    if (!target) {
      this.headerEl.setText('Not a Vairë node.');
      return;
    }

    const { pkg, node } = target;
    this.headerEl.setText(node.name);
    this.bodyEl.createDiv({ cls: 'vaire-empty', text: 'Loading…' });

    loadBacklinkContexts(this.plugin, pkg, node)
      .then((contexts) => {
        // The followed file may have changed while this request was in flight.
        const stillCurrent = this.currentTarget();
        if (!stillCurrent || stillCurrent.node.full !== node.full || stillCurrent.pkg.absRoot !== pkg.absRoot) return;
        this.lastContexts = contexts;
        this.lastPkg = pkg;
        this.renderFiltered();
      })
      .catch((err: unknown) => {
        this.bodyEl.empty();
        const div = this.bodyEl.createDiv({ cls: 'vaire-error' });
        div.createSpan({ text: `Could not load backlinks — ${errMessage(err)}` });
        if (isIndexNotBuilt(err)) {
          div.createEl('br');
          const btn = div.createEl('button', { text: 'Rebuild index' });
          btn.addEventListener('click', () => void this.plugin.rebuildIndex(pkg).then(() => this.reload()));
        }
      });
  }

  // ---- rendering ---------------------------------------------------------------------------

  private renderFiltered(): void {
    const pkg = this.lastPkg;
    const contexts = this.lastContexts;
    if (!pkg || contexts === null) return;

    this.bodyEl.empty();
    this.footerEl.empty();

    if (contexts.length === 0) {
      this.bodyEl.createDiv({ cls: 'vaire-empty', text: 'No backlinks.' });
      this.footerEl.setText('0 backlinks');
      return;
    }

    const filtered = filterContexts(contexts, this.query);
    const plural = contexts.length === 1 ? 'backlink' : 'backlinks';
    this.footerEl.setText(
      filtered.length === contexts.length
        ? `${contexts.length} ${plural}`
        : `${filtered.length} of ${contexts.length} ${plural}`,
    );

    if (filtered.length === 0) {
      this.bodyEl.createDiv({ cls: 'vaire-empty', text: 'No backlinks match your search.' });
      return;
    }

    if (this.groupByType) {
      this.renderGroupedByType(pkg, filtered);
    } else {
      for (const group of groupByNode(filtered)) this.renderNodeGroup(this.bodyEl, pkg, group);
    }
  }

  private renderGroupedByType(pkg: PackageInfo, contexts: BacklinkContext[]): void {
    const byType = new Map<string, BacklinkContext[]>();
    for (const ctx of contexts) {
      const list = byType.get(ctx.type);
      if (list) list.push(ctx);
      else byType.set(ctx.type, [ctx]);
    }
    for (const [type, items] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const section = this.bodyEl.createDiv({ cls: 'vaire-backlinks-type-section' });
      section.createEl('h3', { text: `${type} (${items.length})` });
      for (const group of groupByNode(items)) this.renderNodeGroup(section, pkg, group);
    }
  }

  private renderNodeGroup(parent: HTMLElement, pkg: PackageInfo, group: NodeGroup): void {
    const container = parent.createDiv({ cls: 'vaire-backlinks-group' });
    const key = groupKey(group);
    const isCollapsed = this.collapsed.has(key);

    const headerEl = container.createDiv({
      cls: 'vaire-backlinks-group-header',
      attr: { role: 'button', tabindex: '0' },
    });
    const chevron = headerEl.createSpan({ cls: 'vaire-chevron' + (isCollapsed ? ' is-collapsed' : '') });
    chevron.setText('▾');

    const ref = refForContext(group);
    if (ref) headerEl.appendChild(createRefElement(this.plugin, ref, { repo: pkg.absRoot }));
    else headerEl.createSpan({ text: group.name });
    headerEl.createEl('code', { cls: 'vaire-nid', text: group.id });
    headerEl.createSpan({ cls: 'vaire-muted', text: `(${group.count})` });

    const rowsEl = container.createDiv({ cls: 'vaire-backlinks-group-rows' });
    if (isCollapsed) rowsEl.hide();

    const toggle = (): void => {
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        chevron.removeClass('is-collapsed');
        rowsEl.show();
      } else {
        this.collapsed.add(key);
        chevron.addClass('is-collapsed');
        rowsEl.hide();
      }
    };
    headerEl.addEventListener('click', (evt) => {
      // The referencing-node link inside the header has its own click handling (navigates to
      // the node); don't also toggle the group underneath it.
      if ((evt.target as HTMLElement).closest('a.vaire-link')) return;
      toggle();
    });
    headerEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggle();
      }
    });

    for (const ctx of group.rows) this.renderRow(rowsEl, pkg, ctx);
  }

  private renderRow(container: HTMLElement, pkg: PackageInfo, ctx: BacklinkContext): void {
    const item = container.createDiv({ cls: 'vaire-backlink-item' });

    const meta = item.createDiv({ cls: 'vaire-backlink-row' });
    meta.createSpan({ cls: 'vaire-badge vaire-reftype-badge', text: ctx.ref_type });
    meta.createSpan({ cls: 'vaire-muted', text: `line ${ctx.line}` });

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
}
