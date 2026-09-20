// Dependency graph view: the active package's resolved dependency closure from `cli.deps`, as
// either an indented collapsible outline ("tree", default) or a force-directed node-link
// diagram ("graph") — `settings.depViewLayout` plus a toolbar toggle. See DESIGN.md's
// dependency-graph feature brief and "§3 Dependencies" / "CLI contract nuances".

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ButtonComponent, ItemView, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import { VaireError } from '../cli';
import { ForceLayout } from '../graph/layout';
import {
  clampZoom,
  distance as ptDistance,
  nodeRadius,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../graph/pure';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { linkFolder, linkFromCatalog, pullDependency } from '../views/deps-actions';
import { CatalogView } from '../views/catalog-view';
import { ExternalNodeView } from '../views/external-view';
import { openPackageIndex } from '../views/package-node';
import type { DepsResult } from '../types';
import {
  buildDepGraph,
  buildDepOutline,
  conflicts,
  type BuildDepGraphOptions,
  type DepGraphEdge,
  type DepGraphNode,
  type DepGraphResult,
  type DepGraphState,
  type DepOutlineNode,
  type ResolvedFrom,
} from './pure';

export const VIEW_TYPE_DEPGRAPH = 'vaire-deps';

interface DepViewState {
  packageDir: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

/** `~/.vaire/store` — see `resolvedFromOf` (src/depgraph/pure.ts). */
function storeDir(): string {
  return path.join(os.homedir(), '.vaire', 'store');
}

const STATE_LABEL: Record<DepGraphState, string> = {
  ok: 'ok',
  unlinked: 'unlinked',
  mismatch: 'mismatch',
  error: 'error',
  cycle: 'cycle',
};

const RESOLVED_FROM_LABEL: Record<ResolvedFrom, string> = {
  'working copy': 'working copy',
  'linked checkout': 'linked checkout',
  store: 'store',
  unresolved: 'unresolved',
};

export class DepGraphView extends ItemView {
  private readonly plugin: VairePlugin;
  private packageDir = '';
  private layout: 'tree' | 'graph';

  private depsResult: DepsResult | null = null;
  private depGraph: DepGraphResult | null = null;
  private outline: DepOutlineNode[] | null = null;
  private loadToken = 0;

  private selectedName: string | null = null;
  private collapsed = new Set<string>();

  // Chrome
  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private sideEl!: HTMLElement;

  // Canvas (graph layout)
  private canvasWrapEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tooltipEl!: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private forceLayout: ForceLayout | null = null;
  private viewportWidth = 600;
  private viewportHeight = 400;
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private isPanning = false;
  private panStartScreen = { x: 0, y: 0 };
  private panStartOffset = { x: 0, y: 0 };
  private hoverId: string | null = null;
  private dragId: string | null = null;
  private dragMoved = false;
  private rafId: number | null = null;
  private simActive = false;
  private tickCount = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.layout = plugin.settings.depViewLayout;
  }

  getViewType(): string {
    return VIEW_TYPE_DEPGRAPH;
  }

  getIcon(): string {
    return 'network';
  }

  getDisplayText(): string {
    const pkg = this.currentPkg();
    return pkg ? `${pkg.name} dependencies` : 'Vairë dependencies';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), packageDir: this.packageDir };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<DepViewState> | undefined;
    if (s && typeof s.packageDir === 'string') this.packageDir = s.packageDir;
    await super.setState(state, result);
    void this.reload();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-depgraph-view');
    this.buildChrome();

    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        const pkg = this.currentPkg();
        if (pkg && pkg.absRoot === root) void this.reload();
      }),
    );

    this.registerDomEvent(this.canvas, 'mousedown', this.onMouseDown);
    this.registerDomEvent(this.canvas, 'wheel', this.onWheel, { passive: false });
    this.registerDomEvent(window, 'mousemove', this.onMouseMove);
    this.registerDomEvent(window, 'mouseup', this.onMouseUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvasWrapEl);

    void this.reload();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopLoop();
    this.contentEl.empty();
  }

  private currentPkg(): PackageInfo | null {
    return this.plugin.packages.all().find((p) => p.dir === this.packageDir) ?? null;
  }

  // ---- chrome -----------------------------------------------------------------------------

  private buildChrome(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.toolbarEl = contentEl.createDiv({ cls: 'vaire-depgraph-toolbar' });
    this.buildToolbar(this.toolbarEl);

    this.bodyEl = contentEl.createDiv({ cls: 'vaire-depgraph-body' });
    this.mainEl = this.bodyEl.createDiv({ cls: 'vaire-depgraph-main' });
    this.sideEl = this.bodyEl.createDiv({ cls: 'vaire-depgraph-side' });

    this.canvasWrapEl = this.mainEl.createDiv({ cls: 'vaire-depgraph-canvas-wrap' });
    this.canvas = this.canvasWrapEl.createEl('canvas', { cls: 'vaire-depgraph-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('vaire: could not get a 2d canvas context');
    this.ctx = ctx;
    this.tooltipEl = this.canvasWrapEl.createDiv({ cls: 'vaire-depgraph-tooltip' });
    this.tooltipEl.hide();
  }

  private buildToolbar(root: HTMLElement): void {
    root.empty();

    const label = root.createEl('label', { cls: 'vaire-depgraph-layout-label', text: 'Layout' });
    const select = label.createEl('select', { cls: 'dropdown vaire-depgraph-layout-select' });
    select.createEl('option', { value: 'tree', text: 'Tree (outline)' });
    select.createEl('option', { value: 'graph', text: 'Graph (diagram)' });
    select.value = this.layout;
    select.addEventListener('change', () => {
      this.layout = select.value === 'graph' ? 'graph' : 'tree';
      this.plugin.settings.depViewLayout = this.layout;
      void this.plugin.saveSettings();
      this.renderBody();
    });

    const refreshBtn = root.createEl('button', { cls: 'vaire-depgraph-refresh', text: 'Refresh' });
    refreshBtn.addEventListener('click', () => void this.reload());

    this.statusEl = root.createSpan({ cls: 'vaire-depgraph-status' });
  }

  private setStatus(text: string): void {
    this.statusEl.empty();
    this.statusEl.createSpan({ text });
  }

  // ---- data loading -------------------------------------------------------------------------

  private async reload(): Promise<void> {
    const token = ++this.loadToken;
    this.stopLoop();
    if (!this.mainEl) return; // reload() can in principle race onOpen(); buildChrome() not run yet

    const pkg = this.currentPkg();
    if (!pkg) {
      this.depsResult = null;
      this.depGraph = null;
      this.outline = null;
      this.mainEl.empty();
      this.mainEl.createDiv({ cls: 'vaire-empty', text: 'This package is no longer in the vault.' });
      this.sideEl.empty();
      this.setStatus('');
      return;
    }

    this.setStatus('Loading…');
    try {
      const result = await this.plugin.cli.deps(pkg.absRoot);
      if (token !== this.loadToken) return;
      this.depsResult = result;
      const opts: BuildDepGraphOptions = {
        rootName: result.name,
        rootAbs: pkg.absRoot,
        vaultRoots: this.plugin.packages.all().map((p) => p.absRoot),
        storeDir: storeDir(),
      };
      this.depGraph = buildDepGraph(result, opts);
      this.outline = buildDepOutline(result, opts);
      if (this.selectedName && !this.depGraph.nodes.some((n) => n.name === this.selectedName)) {
        this.selectedName = null;
      }
      const conflicted = conflicts(this.depGraph.nodes);
      const conflictNote = conflicted.length > 0 ? `, ${conflicted.length} version conflict(s)` : '';
      this.setStatus(`${this.depGraph.nodes.length} package(s), ${this.depGraph.edges.length} edge(s)${conflictNote}`);
      this.renderBody();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.depsResult = null;
      this.depGraph = null;
      this.outline = null;
      this.mainEl.empty();
      this.showError(pkg, err);
      this.sideEl.empty();
    }
  }

  private showError(pkg: PackageInfo, err: unknown): void {
    this.setStatus('');
    const div = this.mainEl.createDiv({ cls: 'vaire-error' });
    div.createSpan({ text: `Could not load dependencies — ${errMessage(err)}` });
    if (isIndexNotBuilt(err)) {
      div.createEl('br');
      new ButtonComponent(div).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  // ---- body dispatch ------------------------------------------------------------------------

  private renderBody(): void {
    this.stopLoop();
    this.mainEl.empty();
    if (!this.depGraph || !this.outline) return;

    if (this.layout === 'tree') {
      this.renderTree(this.mainEl, this.outline);
    } else {
      this.mainEl.appendChild(this.canvasWrapEl);
      this.handleResize();
      this.startSimulation(this.depGraph);
    }
    this.renderSidePanel();
  }

  // ==== TREE LAYOUT ============================================================================

  private renderTree(root: HTMLElement, outline: DepOutlineNode[]): void {
    const wrap = root.createDiv({ cls: 'vaire-depgraph-outline' });
    for (const node of outline) this.renderOutlineRow(wrap, node, 0);
  }

  private outlineKey(node: DepOutlineNode, depth: number, index: number): string {
    return `${depth}:${index}:${node.name}`;
  }

  private renderOutlineRow(container: HTMLElement, node: DepOutlineNode, depth: number, index = 0): void {
    const hasChildren = node.children.length > 0;
    const key = this.outlineKey(node, depth, index);
    const isCollapsed = hasChildren && this.collapsed.has(key);

    const row = container.createDiv({ cls: 'vaire-depgraph-row' });
    row.style.setProperty('--vaire-depgraph-indent', String(depth));
    if (node.name === this.selectedName) row.addClass('is-selected');

    const chevron = row.createSpan({ cls: 'vaire-depgraph-chevron' + (hasChildren ? '' : ' is-empty') });
    if (hasChildren) {
      setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
      chevron.addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.renderBody();
      });
    }

    row.createSpan({ cls: `vaire-state-badge vaire-state-${node.state}`, text: STATE_LABEL[node.state] });
    row.createSpan({ cls: 'vaire-depgraph-name', text: node.name });
    row.createSpan({ cls: 'vaire-depgraph-constraint', text: node.constraint });
    if (node.version) row.createSpan({ cls: 'vaire-depgraph-version', text: node.version });
    row.createSpan({ cls: 'vaire-depgraph-resolved-from', text: RESOLVED_FROM_LABEL[node.resolvedFrom] });

    if (node.seeAbove) {
      const link = row.createEl('a', { cls: 'vaire-depgraph-see-above', text: 'see above', href: '#' });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.selectedName = node.name;
        this.refreshTree();
        this.renderSidePanel();
        this.scrollToFirst(node.name);
      });
    }

    row.addEventListener('click', () => {
      this.selectedName = node.name;
      this.refreshTree();
      this.renderSidePanel();
    });

    if (hasChildren && !isCollapsed) {
      const childrenEl = container.createDiv({ cls: 'vaire-depgraph-children' });
      node.children.forEach((child, i) => this.renderOutlineRow(childrenEl, child, depth + 1, i));
    }
  }

  /** Re-renders the outline in place (`collapsed`/`selectedName` are fields on the view, so
   *  toggle state survives) — cheap enough for a dependency closure's realistic size, and much
   *  simpler than diffing individual row classes. */
  private refreshTree(): void {
    if (!this.outline) return;
    this.mainEl.empty();
    this.renderTree(this.mainEl, this.outline);
  }

  private scrollToFirst(name: string): void {
    const row = [...this.mainEl.querySelectorAll('.vaire-depgraph-row')].find(
      (el) => el.querySelector('.vaire-depgraph-name')?.textContent === name,
    );
    row?.scrollIntoView({ block: 'center' });
  }

  // ==== GRAPH LAYOUT ===========================================================================

  private startSimulation(graph: DepGraphResult): void {
    const distances = this.bfsDistances(graph);
    const nodeInputs = graph.nodes.map((n) => ({ id: n.name, distance: distances.get(n.name) ?? 1 }));
    this.forceLayout = new ForceLayout(
      nodeInputs,
      graph.edges.map((e) => ({ source: e.source, target: e.target })),
      { width: this.viewportWidth, height: this.viewportHeight, seed: 1 },
    );
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.tickCount = 0;
    this.simActive = true;
    this.scheduleTick();
  }

  /** BFS hop count from the run root to every node, in one pass, over the dependency edges —
   *  used only to bias initial layout radius (closer packages start nearer the center), same
   *  idea as the local graph view's `RefEntry.distance`. */
  private bfsDistances(graph: DepGraphResult): Map<string, number> {
    const bySource = new Map<string, string[]>();
    for (const e of graph.edges) {
      const list = bySource.get(e.source);
      if (list) list.push(e.target);
      else bySource.set(e.source, [e.target]);
    }
    const rootName = this.depsResult?.name;
    const dist = new Map<string, number>(rootName ? [[rootName, 0]] : []);
    let frontier = rootName ? [rootName] : [];
    let hop = 0;
    while (frontier.length > 0 && hop < 20) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const target of bySource.get(id) ?? []) {
          if (!dist.has(target)) {
            dist.set(target, hop + 1);
            next.push(target);
          }
        }
      }
      frontier = next;
      hop++;
    }
    return dist;
  }

  private scheduleTick(): void {
    if (this.rafId != null) return;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.rafId != null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.simActive = false;
  }

  private readonly tick = (): void => {
    this.rafId = null;
    if (!this.forceLayout || !this.simActive) {
      this.draw();
      return;
    }
    const energy = this.forceLayout.step();
    this.tickCount++;
    this.draw();
    if (this.tickCount >= 300 || energy < 0.05) {
      this.simActive = false;
      return;
    }
    this.scheduleTick();
  };

  private nudgeSimulation(): void {
    if (!this.forceLayout) return;
    this.tickCount = Math.max(this.tickCount, 300 - 90);
    this.simActive = true;
    this.scheduleTick();
  }

  private handleResize(): void {
    if (!this.canvasWrapEl.isConnected) return;
    const rect = this.canvasWrapEl.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.forceLayout?.resize(width, height);
    this.draw();
  }

  private currentViewport(): Viewport {
    return { panX: this.panX, panY: this.panY, zoom: this.zoom };
  }

  private mouseScreenPos(evt: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  private hitTestNode(screenX: number, screenY: number): DepGraphNode | null {
    if (!this.depGraph || !this.forceLayout) return null;
    const world = screenToWorld(screenX, screenY, this.currentViewport());
    let hit: DepGraphNode | null = null;
    for (const node of this.depGraph.nodes) {
      const p = this.forceLayout.get(node.name);
      if (!p) continue;
      const r = nodeRadius(node.direct, p.distance) + 3;
      if (ptDistance(world.x, world.y, p.x, p.y) <= r) hit = node;
    }
    return hit;
  }

  private readonly onMouseDown = (evt: MouseEvent): void => {
    if (this.layout !== 'graph' || evt.button !== 0) return;
    const pos = this.mouseScreenPos(evt);
    if (pos.x < 0 || pos.y < 0 || pos.x > this.viewportWidth || pos.y > this.viewportHeight) return;
    const hit = this.hitTestNode(pos.x, pos.y);
    if (hit) {
      this.dragId = hit.name;
      this.dragMoved = false;
      this.forceLayout?.pin(hit.name);
      evt.preventDefault();
    } else {
      this.isPanning = true;
      this.panStartScreen = pos;
      this.panStartOffset = { x: this.panX, y: this.panY };
    }
  };

  private readonly onMouseMove = (evt: MouseEvent): void => {
    if (this.layout !== 'graph') return;
    const pos = this.mouseScreenPos(evt);

    if (this.dragId) {
      const world = screenToWorld(pos.x, pos.y, this.currentViewport());
      this.forceLayout?.setPosition(this.dragId, world.x, world.y);
      this.dragMoved = true;
      this.draw();
      return;
    }
    if (this.isPanning) {
      this.panX = this.panStartOffset.x + (pos.x - this.panStartScreen.x);
      this.panY = this.panStartOffset.y + (pos.y - this.panStartScreen.y);
      this.draw();
      return;
    }

    const inside = pos.x >= 0 && pos.y >= 0 && pos.x <= this.viewportWidth && pos.y <= this.viewportHeight;
    const hit = inside ? this.hitTestNode(pos.x, pos.y) : null;
    const nextHoverId = hit?.name ?? null;
    if (nextHoverId !== this.hoverId) {
      this.hoverId = nextHoverId;
      this.draw();
    }
    this.updateTooltip(pos, hit, inside);
  };

  private readonly onMouseUp = (evt: MouseEvent): void => {
    if (this.layout !== 'graph') return;
    if (this.dragId) {
      const id = this.dragId;
      const moved = this.dragMoved;
      this.forceLayout?.unpin(id);
      this.dragId = null;
      this.dragMoved = false;
      if (!moved) {
        this.selectedName = id;
        this.renderSidePanel();
      } else {
        this.nudgeSimulation();
      }
      this.draw();
      return;
    }
    if (this.isPanning) this.isPanning = false;
  };

  private readonly onWheel = (evt: WheelEvent): void => {
    if (this.layout !== 'graph') return;
    evt.preventDefault();
    const pos = this.mouseScreenPos(evt);
    const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = clampZoom(this.zoom * factor);
    const next = zoomAt(pos.x, pos.y, nextZoom, this.currentViewport());
    this.panX = next.panX;
    this.panY = next.panY;
    this.zoom = next.zoom;
    this.draw();
  };

  private updateTooltip(pos: { x: number; y: number }, node: DepGraphNode | null, inside = true): void {
    if (!node || !inside) {
      this.tooltipEl.hide();
      return;
    }
    this.tooltipEl.setText(`${node.name} · ${STATE_LABEL[node.state]} · ${RESOLVED_FROM_LABEL[node.resolvedFrom]}`);
    this.tooltipEl.style.left = `${pos.x + 12}px`;
    this.tooltipEl.style.top = `${pos.y + 12}px`;
    this.tooltipEl.show();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    if (!this.depGraph || !this.forceLayout) return;

    const vp = this.currentViewport();
    const style = getComputedStyle(this.containerEl);
    const edgeColor = style.getPropertyValue('--text-faint').trim() || '#8a8a8a';
    const hoverRing = style.getPropertyValue('--text-muted').trim() || '#999999';
    const selectedRing = style.getPropertyValue('--interactive-accent').trim() || '#7c3aed';
    const textColor = style.getPropertyValue('--text-normal').trim() || '#222222';
    const fontFamily = style.fontFamily || 'sans-serif';

    this.drawEdges(ctx, this.depGraph.edges, vp, edgeColor);
    this.drawNodes(ctx, this.depGraph.nodes, vp, hoverRing, selectedRing, textColor, fontFamily, style);
  }

  private drawEdges(ctx: CanvasRenderingContext2D, edges: DepGraphEdge[], vp: Viewport, color: string): void {
    if (!this.forceLayout) return;
    for (const edge of edges) {
      const a = this.forceLayout.get(edge.source);
      const b = this.forceLayout.get(edge.target);
      const targetNode = this.depGraph!.nodes.find((n) => n.name === edge.target);
      if (!a || !b) continue;
      const pa = worldToScreen(a.x, a.y, vp);
      const pb = worldToScreen(b.x, b.y, vp);
      const unresolved = targetNode?.resolvedFrom === 'unresolved';

      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(unresolved ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.restore();

      const r = (targetNode ? nodeRadius(targetNode.direct, b.distance) : 8) * this.zoom + 2;
      this.drawArrowhead(ctx, pa, pb, r, color);
    }
  }

  private drawArrowhead(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
    backoff: number,
    color: string,
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = to.x - ux * backoff;
    const tipY = to.y - uy * backoff;
    const size = 6;
    const baseX = tipX - ux * size;
    const baseY = tipY - uy * size;
    const leftX = baseX + -uy * size * 0.5;
    const leftY = baseY + ux * size * 0.5;
    const rightX = baseX - -uy * size * 0.5;
    const rightY = baseY - ux * size * 0.5;

    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private stateColor(state: DepGraphState, style: CSSStyleDeclaration): string {
    switch (state) {
      case 'ok':
        return style.getPropertyValue('--color-green').trim() || '#4caf50';
      case 'unlinked':
      case 'mismatch':
        return style.getPropertyValue('--text-warning').trim() || '#e0a640';
      case 'error':
        return style.getPropertyValue('--text-error').trim() || '#e05252';
      case 'cycle':
        return style.getPropertyValue('--color-purple').trim() || '#9b6bce';
    }
  }

  private drawNodes(
    ctx: CanvasRenderingContext2D,
    nodes: DepGraphNode[],
    vp: Viewport,
    hoverRing: string,
    selectedRing: string,
    textColor: string,
    fontFamily: string,
    style: CSSStyleDeclaration,
  ): void {
    if (!this.forceLayout) return;
    for (const node of nodes) {
      const p = this.forceLayout.get(node.name);
      if (!p) continue;
      const screen = worldToScreen(p.x, p.y, vp);
      const r = nodeRadius(node.direct, p.distance) * this.zoom;

      ctx.save();
      if (node.resolvedFrom === 'unresolved') ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.stateColor(node.state, style);
      ctx.fill();
      if (node.resolvedFrom === 'unresolved') {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = this.stateColor(node.state, style);
        ctx.stroke();
      }
      ctx.restore();

      if (node.name === this.selectedName) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = selectedRing;
        ctx.stroke();
      } else if (node.name === this.hoverId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = hoverRing;
        ctx.stroke();
      }

      if (this.zoom > 0.4) {
        ctx.fillStyle = textColor;
        ctx.font = `${Math.max(9, 11 * Math.min(this.zoom, 1.4))}px ${fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(node.name, screen.x + r + 4, screen.y);
      }
    }
  }

  // ==== SIDE PANEL =============================================================================

  private renderSidePanel(): void {
    this.sideEl.empty();
    const pkg = this.currentPkg();
    if (!pkg || !this.depGraph) return;

    if (conflicts(this.depGraph.nodes).length > 0) {
      const box = this.sideEl.createDiv({ cls: 'vaire-depgraph-conflicts' });
      box.createEl('h3', { text: 'Version conflicts' });
      for (const n of conflicts(this.depGraph.nodes)) {
        const row = box.createDiv({ cls: 'vaire-depgraph-conflict-row' });
        row.createSpan({ text: `${n.name}: ${n.versions.join(', ')}` });
        row.addEventListener('click', () => {
          this.selectedName = n.name;
          this.renderSidePanel();
        });
      }
    }

    if (!this.selectedName) {
      this.sideEl.createDiv({ cls: 'vaire-empty', text: 'Click a package to see its details.' });
      return;
    }
    const node = this.depGraph.nodes.find((n) => n.name === this.selectedName);
    if (!node) {
      this.sideEl.createDiv({ cls: 'vaire-empty', text: 'Not found in the current closure.' });
      return;
    }
    this.renderNodeDetail(pkg, node);
  }

  private renderNodeDetail(pkg: PackageInfo, node: DepGraphNode): void {
    const panel = this.sideEl.createDiv({ cls: 'vaire-depgraph-detail' });
    panel.createEl('h3', { text: node.name });
    panel.createSpan({ cls: `vaire-state-badge vaire-state-${node.state}`, text: STATE_LABEL[node.state] });

    const rows = panel.createDiv({ cls: 'vaire-depgraph-detail-rows' });
    this.detailRow(rows, 'Constraint(s)', node.constraints.join(', ') || '—');
    this.detailRow(rows, 'Version(s)', node.versions.length > 0 ? node.versions.join(', ') : '—');
    if (node.versions.length > 1) {
      rows.createDiv({ cls: 'vaire-depgraph-conflict-warning', text: '⚠ resolved to more than one version' });
    }
    this.detailRow(rows, 'Resolves from', RESOLVED_FROM_LABEL[node.resolvedFrom]);
    if (node.absRoot) this.detailRow(rows, 'Root', node.absRoot);

    const parentsEl = panel.createDiv({ cls: 'vaire-depgraph-parents' });
    parentsEl.createEl('h4', { text: 'Declared by' });
    if (node.parents.length === 0) {
      parentsEl.createDiv({ cls: 'vaire-empty', text: 'Not declared by anything in this closure.' });
    } else {
      for (const parent of node.parents) {
        parentsEl.createDiv({ cls: 'vaire-depgraph-parent-row', text: `${parent.name} (${parent.constraint})` });
      }
    }

    if (node.notes.length > 0) {
      const notesEl = panel.createDiv({ cls: 'vaire-depgraph-notes' });
      notesEl.createEl('h4', { text: 'Note' });
      for (const note of node.notes) notesEl.createDiv({ cls: 'vaire-dep-note', text: note });
    }

    const actions = panel.createDiv({ cls: 'vaire-actions vaire-depgraph-actions' });
    new ButtonComponent(actions).setButtonText('Open package').onClick(() => void this.openPackageFor(node));

    if (node.state !== 'ok') {
      if (node.direct) {
        new ButtonComponent(actions)
          .setButtonText('Link from catalog…')
          .onClick(() => void linkFromCatalog(this.plugin, pkg, node.name).then((changed) => { if (changed) void this.reload(); }));
        new ButtonComponent(actions)
          .setButtonText('Link folder…')
          .onClick(() => void linkFolder(this.plugin, pkg, node.name).then((changed) => { if (changed) void this.reload(); }));
        new ButtonComponent(actions)
          .setButtonText('Pull')
          .onClick(() => void pullDependency(this.plugin, pkg, node.name).then((changed) => { if (changed) void this.reload(); }));
      } else {
        const declaredBy = node.parents.map((p) => p.name).join(', ') || 'an unknown package';
        panel.createDiv({
          cls: 'vaire-hint vaire-depgraph-transitive-hint',
          text:
            `'${node.name}' is a transitive dependency — vaire only links/pulls into the run root ` +
            `(${pkg.name}). It must be declared and linked by ${declaredBy} instead.`,
        });
      }
    }
  }

  private detailRow(root: HTMLElement, label: string, value: string): void {
    const row = root.createDiv({ cls: 'vaire-depgraph-detail-row' });
    row.createSpan({ cls: 'vaire-depgraph-detail-label', text: label });
    row.createSpan({ cls: 'vaire-depgraph-detail-value', text: value });
  }

  private async openPackageFor(node: DepGraphNode): Promise<void> {
    const vaultPkg = this.plugin.packages.byName(node.name);
    if (vaultPkg) {
      await openPackageIndex(this.plugin, vaultPkg.dir);
      return;
    }
    if (!node.absRoot) {
      new Notice(`Vairë: '${node.name}' has no resolved location to open.`);
      return;
    }
    try {
      if (fs.existsSync(path.join(node.absRoot, 'README.md'))) {
        await ExternalNodeView.open(this.plugin, { repo: node.absRoot, filePath: 'README.md', pkg: node.name });
        return;
      }
    } catch {
      // fall through to the catalog browser
    }
    await CatalogView.open(this.plugin);
  }
}
