// Vairë explorer sidebar (feat/type-tree): package -> type (or folder) -> nodes, with the
// scoped-layout/group-by trade-off built in src/tree/pure.ts. See BRANCHES.md.

import { ItemView, Menu, Notice, TFile, TextComponent, WorkspaceLeaf, setIcon } from 'obsidian';
import type { LocalNode, PackageInfo } from '../packages';
import { openFileAtLine } from '../navigate';
import { buildTree, filterTree, pathToNode, type NodeLike, type TreeNode, type TreeNodeKind, type TreeOptions } from './pure';
import { VIEW_TYPE_NODE } from '../views/node-view';
import type VairePlugin from '../main';
import { applyTypeColor } from '../theme/index';

export const VIEW_TYPE_TREE = 'vaire-tree';

/** A `pure.ts` `TreeNode`, namespaced to one package and carrying the extra 'package' kind for
 *  the row the view itself wraps each package's tree in — kept out of `pure.ts` since it has
 *  no `obsidian` (or `PackageInfo`) dependency and doesn't need one. */
interface DisplayNode {
  key: string;
  kind: 'package' | TreeNodeKind;
  label: string;
  pkgDir: string;
  fullId?: string;
  type?: string;
  count?: number;
  gone?: boolean;
  missingContainer?: boolean;
  scopedInName?: string;
  children: DisplayNode[];
}

function toNodeLike(n: LocalNode): NodeLike {
  return {
    type: n.type,
    full: n.full,
    name: n.name,
    aliases: n.aliases,
    scope: n.scope,
    supersededBy: n.supersededBy,
    path: n.file.path,
  };
}

function toDisplay(pkgDir: string, n: TreeNode): DisplayNode {
  return {
    key: `${pkgDir}\u0000${n.key}`,
    kind: n.kind,
    label: n.label,
    pkgDir,
    fullId: n.fullId,
    type: n.type,
    count: n.count,
    gone: n.gone,
    missingContainer: n.missingContainer,
    scopedInName: n.scopedInName,
    children: n.children.map((c) => toDisplay(pkgDir, c)),
  };
}

const CHEVRON_ICON: Record<'open' | 'closed', string> = { open: 'chevron-down', closed: 'chevron-right' };

export class TreeView extends ItemView {
  private readonly plugin: VairePlugin;

  private toolbarEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private filterInput!: TextComponent;

  /** Collapse state, keyed by the same namespaced key as `DisplayNode.key` — persists for the
   *  life of this view instance (i.e. per Obsidian session), not across reloads. */
  private readonly expanded = new Set<string>();
  private filterText = '';
  private activePkgDir: string | null = null;
  private activeFullId: string | null = null;
  private rowEls = new Map<string, HTMLElement>();
  private metaDebounce: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TREE;
  }

  getIcon(): string {
    return 'list-tree';
  }

  getDisplayText(): string {
    return 'Vairë explorer';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaire-tree-view');

    this.toolbarEl = contentEl.createDiv({ cls: 'vaire-tree-toolbar' });
    this.buildToolbar(this.toolbarEl);
    this.bodyEl = contentEl.createDiv({ cls: 'vaire-tree-body' });

    this.registerEvent(this.plugin.events.on('local-index-rebuilt', () => this.render()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleMetaRefresh()));
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.followFile(file)));

    this.followFile(this.app.workspace.getActiveFile());
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.contentEl.empty();
  }

  private scheduleMetaRefresh(): void {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.metaDebounce = window.setTimeout(() => {
      this.metaDebounce = null;
      this.render();
    }, 300);
  }

  // ---- toolbar: filter box + scopedLayout/groupBy toggles --------------------------------

  private buildToolbar(root: HTMLElement): void {
    this.filterInput = new TextComponent(root);
    this.filterInput.setPlaceholder('Filter by id, name, alias…').setValue(this.filterText);
    this.filterInput.inputEl.addClass('vaire-tree-filter');
    this.filterInput.onChange((value) => {
      this.filterText = value;
      this.render();
    });

    const toggles = root.createDiv({ cls: 'vaire-tree-toggles' });

    const layoutLabel = toggles.createEl('label', { cls: 'vaire-tree-toggle-label', text: 'Scoped nodes' });
    const layoutSelect = layoutLabel.createEl('select', { cls: 'dropdown vaire-tree-toggle-select' });
    layoutSelect.createEl('option', { value: 'nested', text: 'Nested under container' });
    layoutSelect.createEl('option', { value: 'flat', text: 'Flat, like the published site' });
    layoutSelect.value = this.plugin.settings.treeScopedLayout;
    layoutSelect.addEventListener('change', () => {
      this.plugin.settings.treeScopedLayout = layoutSelect.value === 'flat' ? 'flat' : 'nested';
      void this.plugin.saveSettings();
      this.render();
    });

    const groupLabel = toggles.createEl('label', { cls: 'vaire-tree-toggle-label', text: 'Group by' });
    const groupSelect = groupLabel.createEl('select', { cls: 'dropdown vaire-tree-toggle-select' });
    groupSelect.createEl('option', { value: 'type', text: 'Type' });
    groupSelect.createEl('option', { value: 'folder', text: 'Folder' });
    groupSelect.value = this.plugin.settings.treeGroupBy;
    groupSelect.addEventListener('change', () => {
      this.plugin.settings.treeGroupBy = groupSelect.value === 'folder' ? 'folder' : 'type';
      void this.plugin.saveSettings();
      this.render();
    });
  }

  private treeOptions(): TreeOptions {
    return { scopedLayout: this.plugin.settings.treeScopedLayout, groupBy: this.plugin.settings.treeGroupBy };
  }

  // ---- following the active file (highlight + reveal only, no data rebuild) --------------

  private followFile(file: TFile | null): void {
    const pkg = file ? this.plugin.packages.packageFor(file) : null;
    const node = pkg && file ? pkg.index.byFile(file) : null;
    this.activePkgDir = pkg?.dir ?? null;
    this.activeFullId = node?.full ?? null;
    this.render();
  }

  // ---- render ------------------------------------------------------------------------------

  private render(): void {
    this.bodyEl.empty();
    this.rowEls.clear();

    const packages = this.plugin.packages.all();
    if (packages.length === 0) {
      this.bodyEl.createDiv({ cls: 'vaire-empty', text: 'No Vairë package found in this vault.' });
      return;
    }

    const opts = this.treeOptions();
    const filtering = this.filterText.trim().length > 0;
    let rendered = 0;

    for (const pkg of packages) {
      const { display, forceExpand } = this.buildPackageDisplay(pkg, opts);
      if (filtering && display.children.length === 0) continue;
      rendered++;
      if (filtering) forceExpand.add(display.key);
      this.renderRow(this.bodyEl, display, 0, forceExpand);
    }

    if (filtering && rendered === 0) {
      this.bodyEl.createDiv({ cls: 'vaire-empty', text: 'No nodes match.' });
    }

    const activeRow = this.activeFullId ? this.rowEls.get(this.activeRowKey()) : undefined;
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  }

  private activeRowKey(): string {
    return `${this.activePkgDir}\u0000node:${this.activeFullId}`;
  }

  private buildPackageDisplay(pkg: PackageInfo, opts: TreeOptions): { display: DisplayNode; forceExpand: Set<string> } {
    const nodes = pkg.index.all().map(toNodeLike);
    const tree = buildTree(nodes, opts);
    const forceExpand = new Set<string>();

    let visibleTree = tree;
    if (this.filterText.trim()) {
      const filtered = filterTree(tree, this.filterText);
      visibleTree = filtered.tree;
      for (const key of filtered.expandKeys) forceExpand.add(`${pkg.dir}\u0000${key}`);
    }

    // Reveal the active file's node (if it's in this package) regardless of filtering, so
    // clearing the filter still shows it expanded.
    if (this.activePkgDir === pkg.dir && this.activeFullId) {
      const revealPath = pathToNode(tree, `node:${this.activeFullId}`);
      if (revealPath) for (const key of revealPath) forceExpand.add(`${pkg.dir}\u0000${key}`);
    }

    const children = visibleTree.map((n) => toDisplay(pkg.dir, n));
    const display: DisplayNode = {
      key: `pkg:${pkg.dir}`,
      kind: 'package',
      label: pkg.name,
      pkgDir: pkg.dir,
      count: nodes.length,
      children,
    };
    return { display, forceExpand };
  }

  private renderRow(container: HTMLElement, node: DisplayNode, depth: number, forceExpand: Set<string>): void {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && (forceExpand.has(node.key) || this.expanded.has(node.key));

    const row = container.createDiv({ cls: `vaire-tree-row vaire-tree-row-${node.kind}` });
    row.style.setProperty('--vaire-tree-depth', String(depth));

    const chevron = row.createSpan({ cls: 'vaire-tree-chevron' + (hasChildren ? '' : ' is-empty') });
    if (hasChildren) {
      setIcon(chevron, CHEVRON_ICON[isExpanded ? 'open' : 'closed']);
      chevron.addEventListener('click', (evt) => {
        evt.stopPropagation();
        this.toggleExpand(node.key);
      });
    }

    if (node.kind === 'node') {
      const typeDot = row.createSpan({ cls: `vaire-tree-type-dot vaire-type-${node.type}` });
      if (node.type) applyTypeColor(this.plugin, typeDot, node.type);
    } else if (node.kind === 'package') {
      setIcon(row.createSpan({ cls: 'vaire-tree-icon' }), 'package');
    }

    const label = row.createSpan({ cls: 'vaire-tree-label', text: node.label });
    if (node.kind === 'node' && node.missingContainer) {
      const warn = row.createSpan({ cls: 'vaire-tree-warning', text: '⚠' });
      warn.setAttr('title', `Scoped, but its container was not found in this package.`);
    }
    if (node.kind === 'node' && node.scopedInName) {
      row.createSpan({ cls: 'vaire-tree-scoped-in', text: `in ${node.scopedInName}` });
    }
    if (node.count != null) {
      row.createSpan({ cls: 'vaire-tree-count', text: String(node.count) });
    }

    if (node.kind === 'node') {
      if (node.gone) row.addClass('vaire-gone');
      if (node.pkgDir === this.activePkgDir && node.fullId === this.activeFullId) row.addClass('is-active');
      this.rowEls.set(node.key, row);
      row.addEventListener('click', (evt) => void this.handleNodeClick(evt, node));
      row.addEventListener('contextmenu', (evt) => this.handleNodeContextMenu(evt, node));
      row.setAttr('tabindex', '0');
      label.setAttr('title', node.fullId ?? '');
    } else {
      row.addEventListener('click', () => this.toggleExpand(node.key));
    }

    const childrenEl = container.createDiv({ cls: 'vaire-tree-children' });
    if (isExpanded) {
      for (const child of node.children) this.renderRow(childrenEl, child, depth + 1, forceExpand);
    }
  }

  private toggleExpand(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.render();
  }

  // ---- node actions --------------------------------------------------------------------

  private localNodeFor(node: DisplayNode): LocalNode | null {
    if (!node.fullId) return null;
    const pkg = this.plugin.packages.all().find((p) => p.dir === node.pkgDir);
    return pkg ? pkg.index.get(node.fullId) : null;
  }

  private async handleNodeClick(evt: MouseEvent, node: DisplayNode): Promise<void> {
    evt.preventDefault();
    const local = this.localNodeFor(node);
    if (!local) return;
    const newLeaf = evt.metaKey || evt.ctrlKey;
    await openFileAtLine(this.app, local.file, undefined, newLeaf);
  }

  private handleNodeContextMenu(evt: MouseEvent, node: DisplayNode): void {
    evt.preventDefault();
    const local = this.localNodeFor(node);
    if (!local) return;

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Open in new tab')
        .setIcon('file-plus')
        .onClick(() => void openFileAtLine(this.app, local.file, undefined, true)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Copy id')
        .setIcon('copy')
        .onClick(() => {
          navigator.clipboard.writeText(local.full).then(
            () => new Notice(`Copied ${local.full}`),
            () => new Notice('Vairë: could not copy to the clipboard'),
          );
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open node panel')
        .setIcon('git-branch')
        .onClick(() => void this.openNodePanelFor(local)),
    );
    if (this.supersedeCommandAvailable()) {
      menu.addItem((item) =>
        item
          .setTitle('Supersede…')
          .setIcon('archive')
          .onClick(() => void this.supersedeVia(local)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async openNodePanelFor(local: LocalNode): Promise<void> {
    await openFileAtLine(this.app, local.file);
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NODE)[0];
    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_NODE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  /** `app.commands` is an undocumented internal API (not in `obsidian.d.ts`) — guarded per
   *  DESIGN's instruction, so a build without it (or a future Obsidian that removes it) just
   *  hides this menu item instead of throwing. */
  private supersedeCommandAvailable(): boolean {
    const commands = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands;
    return Boolean(commands?.commands?.['vaire:supersede-node']);
  }

  private async supersedeVia(local: LocalNode): Promise<void> {
    await openFileAtLine(this.app, local.file);
    const commands = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => unknown } }).commands;
    if (commands?.executeCommandById) {
      commands.executeCommandById('vaire:supersede-node');
    } else {
      new Notice('Vairë: the supersede command is not available.');
    }
  }
}
