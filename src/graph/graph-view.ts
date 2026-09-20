// Local graph view: the active node's neighborhood (outbound refs to depth N + inbound
// backlinks) drawn on a canvas with a small self-written force layout. See DESIGN.md's
// "Local graph" feature brief (BRANCHES.md wave 2) and "Implementation guidance".
//
// Owns: src/graph/*, styles/70-graph.css. Registers via src/graph/index.ts (registerGraph),
// wired into main.ts the same way registerRendering/registerSuggestions/registerViews are.

import { ButtonComponent, ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { VaireError } from '../cli';
import { parseRef } from '../ids';
import { openRef } from '../navigate';
import type { PackageInfo } from '../packages';
import { localTooltip } from '../render/pure';
import type VairePlugin from '../main';
import { exportLocalGraphToCanvas } from './export';
import { buildGraph, type GraphEdge, type GraphModel, type GraphNode } from './model';
import { ForceLayout } from './layout';
import {
  clampZoom,
  distance as ptDistance,
  hashSeed,
  nodeRadius,
  screenToWorld,
  typeColor,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './pure';

export const VIEW_TYPE_GRAPH = 'vaire-graph';

const MAX_TICKS = 300;
const ENERGY_EPSILON = 0.05;
const MAX_NODES = 300;
const DEPTH_OPTIONS = [1, 2, 3];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndexNotBuilt(err: unknown): boolean {
  return err instanceof VaireError && err.kind === 'index_not_built';
}

/** Draws a small filled triangle so `to` reads as the arrow's target, backed off by `backoff`
 *  (the node's screen radius) so the tip touches the circle's edge instead of its center. */
function drawArrowhead(
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

export class GraphView extends ItemView {
  private readonly plugin: VairePlugin;

  private currentFile: TFile | null = null;
  private pkg: PackageInfo | null = null;
  private graph: GraphModel | null = null;
  private layout: ForceLayout | null = null;
  private loadToken = 0;

  private depth: number;
  private showBacklinks = true;

  // Chrome
  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private depthSelect!: HTMLSelectElement;
  private backlinksToggle!: HTMLButtonElement;
  private legendEl!: HTMLElement;
  private canvasWrapEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tooltipEl!: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;

  // Canvas sizing (CSS pixels; devicePixelRatio is handled purely in the transform).
  private viewportWidth = 600;
  private viewportHeight = 400;

  // Pan/zoom
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private isPanning = false;
  private panStartScreen = { x: 0, y: 0 };
  private panStartOffset = { x: 0, y: 0 };

  // Node interaction
  private hoverId: string | null = null;
  private dragId: string | null = null;
  private dragMoved = false;

  // Simulation loop
  private rafId: number | null = null;
  private simActive = false;
  private tickCount = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.depth = plugin.settings.graphDepth;
  }

  getViewType(): string {
    return VIEW_TYPE_GRAPH;
  }

  getIcon(): string {
    return 'git-fork';
  }

  getDisplayText(): string {
    return 'Local graph';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-graph-view');
    this.buildChrome();

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.followFile(file)));
    this.registerEvent(
      this.plugin.events.on('index-rebuilt', (root) => {
        if (this.pkg && this.pkg.absRoot === root) void this.reload();
      }),
    );

    this.registerDomEvent(this.canvas, 'mousedown', this.onMouseDown);
    this.registerDomEvent(this.canvas, 'wheel', this.onWheel, { passive: false });
    this.registerDomEvent(window, 'mousemove', this.onMouseMove);
    this.registerDomEvent(window, 'mouseup', this.onMouseUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvasWrapEl);
    this.handleResize();

    this.followFile(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopLoop();
    this.contentEl.empty();
  }

  // ---- chrome -----------------------------------------------------------------------------

  private buildChrome(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.toolbarEl = contentEl.createDiv({ cls: 'vaire-graph-toolbar' });

    this.toolbarEl.createEl('label', { cls: 'vaire-graph-depth-label', text: 'Depth' });
    this.depthSelect = this.toolbarEl.createEl('select', { cls: 'vaire-graph-depth-select' });
    for (const d of DEPTH_OPTIONS) {
      const opt = this.depthSelect.createEl('option', { text: String(d), value: String(d) });
      if (d === this.depth) opt.selected = true;
    }
    this.depthSelect.addEventListener('change', () => {
      const value = Number(this.depthSelect.value);
      if (!Number.isFinite(value) || value < 1 || value > 3) return;
      this.depth = value;
      this.plugin.settings.graphDepth = value;
      void this.plugin.saveSettings();
      void this.reload();
    });

    this.backlinksToggle = this.toolbarEl.createEl('button', {
      cls: 'vaire-graph-toggle',
      text: 'Backlinks',
    });
    this.backlinksToggle.toggleClass('is-active', this.showBacklinks);
    this.backlinksToggle.addEventListener('click', () => {
      this.showBacklinks = !this.showBacklinks;
      this.backlinksToggle.toggleClass('is-active', this.showBacklinks);
      void this.reload();
    });

    const refreshBtn = this.toolbarEl.createEl('button', { cls: 'vaire-graph-refresh', text: 'Refresh' });
    refreshBtn.addEventListener('click', () => void this.reload());

    const exportBtn = this.toolbarEl.createEl('button', { cls: 'vaire-graph-export', text: 'To canvas' });
    exportBtn.addEventListener('click', () => void exportLocalGraphToCanvas(this.plugin));

    this.statusEl = this.toolbarEl.createSpan({ cls: 'vaire-graph-status' });

    const body = contentEl.createDiv({ cls: 'vaire-graph-body' });
    this.canvasWrapEl = body.createDiv({ cls: 'vaire-graph-canvas-wrap' });
    this.canvas = this.canvasWrapEl.createEl('canvas', { cls: 'vaire-graph-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('vaire: could not get a 2d canvas context');
    this.ctx = ctx;
    this.tooltipEl = this.canvasWrapEl.createDiv({ cls: 'vaire-graph-tooltip' });
    this.tooltipEl.hide();

    this.legendEl = body.createDiv({ cls: 'vaire-graph-legend' });
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  // ---- data loading -------------------------------------------------------------------------

  private followFile(file: TFile | null): void {
    this.currentFile = file;
    void this.reload();
  }

  private async reload(): Promise<void> {
    const token = ++this.loadToken;
    this.stopLoop();
    this.hoverId = null;
    this.dragId = null;
    this.hideTooltip();

    const file = this.currentFile;
    if (!file) {
      this.showEmpty('No file open.');
      return;
    }
    const pkg = this.plugin.packages.packageFor(file);
    if (!pkg) {
      this.showEmpty('Not a Vairë node.');
      return;
    }
    const node = pkg.index.byFile(file);
    if (!node) {
      this.showEmpty('Not a Vairë node.');
      return;
    }
    this.pkg = pkg;
    this.setStatus('Loading…');
    this.legendEl.empty();

    try {
      const [refs, backlinks] = await Promise.all([
        this.plugin.cli.refs(pkg.absRoot, node.full, this.depth),
        this.showBacklinks
          ? this.plugin.cli.backlinks(pkg.absRoot, node.full)
          : Promise.resolve({ id: node.full, backlinks: [] }),
      ]);
      if (token !== this.loadToken) return;

      const names = this.namesResolver(pkg);
      const graph = buildGraph(
        { center: { id: node.full, type: node.type, name: node.name }, refs, backlinks, names },
        { maxNodes: MAX_NODES },
      );
      this.graph = graph;
      this.renderLegend(graph);
      this.setStatus(`${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}, ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}`);
      this.startSimulation(graph);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.graph = null;
      this.layout = null;
      this.showError(err, pkg);
      this.draw();
    }
  }

  /** `{local id or @pkg/local id}` -> display name, from `LocalIndex`es already in memory —
   *  no CLI round trips, per the feature brief ("local names from pkg.index, else the id"). */
  private namesResolver(pkg: PackageInfo): (id: string) => string | undefined {
    return (id: string): string | undefined => {
      const ref = parseRef(id);
      if (!ref || ref.kind !== 'id') return undefined;
      if (ref.pkg) {
        const depPkg = this.plugin.packages.byName(ref.pkg);
        return depPkg?.index.get(ref.local)?.name;
      }
      return pkg.index.get(ref.local)?.name;
    };
  }

  private showEmpty(text: string): void {
    this.graph = null;
    this.layout = null;
    this.pkg = null;
    this.legendEl.empty();
    this.setStatus(text);
    this.draw();
  }

  private showError(err: unknown, pkg: PackageInfo): void {
    this.statusEl.empty();
    this.statusEl.createSpan({ text: `Could not load graph — ${errMessage(err)}` });
    if (isIndexNotBuilt(err)) {
      new ButtonComponent(this.statusEl).setButtonText('Rebuild index').onClick(() => void this.plugin.rebuildIndex(pkg));
    }
  }

  private renderLegend(graph: GraphModel): void {
    this.legendEl.empty();
    const types = [...new Set(graph.nodes.map((n) => n.type))].sort((a, b) => a.localeCompare(b));
    if (types.length === 0) return;
    this.legendEl.createEl('h3', { text: 'Legend' });
    for (const type of types) {
      const chip = this.legendEl.createDiv({ cls: 'vaire-graph-legend-chip' });
      const swatch = chip.createSpan({ cls: 'vaire-graph-legend-swatch' });
      swatch.style.backgroundColor = typeColor(type);
      chip.createSpan({ cls: 'vaire-graph-legend-label', text: type });
    }
  }

  // ---- simulation loop ----------------------------------------------------------------------

  private startSimulation(graph: GraphModel): void {
    const seed = hashSeed(graph.nodes.find((n) => n.isCenter)?.id ?? 'vaire-graph');
    this.layout = new ForceLayout(graph.nodes, graph.edges, {
      width: this.viewportWidth,
      height: this.viewportHeight,
      seed,
    });
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.tickCount = 0;
    this.simActive = true;
    this.scheduleTick();
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
    if (!this.layout || !this.simActive) {
      this.draw();
      return;
    }
    const energy = this.layout.step();
    this.tickCount++;
    this.draw();
    if (this.tickCount >= MAX_TICKS || energy < ENERGY_EPSILON) {
      this.simActive = false;
      return;
    }
    this.scheduleTick();
  };

  /** Restarts a short burst of ticks (e.g. after a drag) so the rest of the graph can react,
   *  without paying for a full ~300-tick settle every time. */
  private nudgeSimulation(): void {
    if (!this.layout) return;
    this.tickCount = Math.max(this.tickCount, MAX_TICKS - 90);
    this.simActive = true;
    this.scheduleTick();
  }

  // ---- resize ---------------------------------------------------------------------------

  private handleResize(): void {
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
    this.layout?.resize(width, height);
    this.draw();
  }

  // ---- pan/zoom/drag/hover/click ---------------------------------------------------------

  private currentViewport(): Viewport {
    return { panX: this.panX, panY: this.panY, zoom: this.zoom };
  }

  private mouseScreenPos(evt: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  private hitTestNode(screenX: number, screenY: number): GraphNode | null {
    if (!this.graph || !this.layout) return null;
    const world = screenToWorld(screenX, screenY, this.currentViewport());
    let hit: GraphNode | null = null;
    for (const node of this.graph.nodes) {
      const p = this.layout.get(node.id);
      if (!p) continue;
      const r = nodeRadius(node.isCenter, node.distance) + 3;
      if (ptDistance(world.x, world.y, p.x, p.y) <= r) hit = node; // last match wins (drawn on top)
    }
    return hit;
  }

  private readonly onMouseDown = (evt: MouseEvent): void => {
    if (evt.button !== 0) return;
    const pos = this.mouseScreenPos(evt);
    if (pos.x < 0 || pos.y < 0 || pos.x > this.viewportWidth || pos.y > this.viewportHeight) return;
    const hit = this.hitTestNode(pos.x, pos.y);
    if (hit) {
      this.dragId = hit.id;
      this.dragMoved = false;
      this.layout?.pin(hit.id);
      evt.preventDefault();
    } else {
      this.isPanning = true;
      this.panStartScreen = pos;
      this.panStartOffset = { x: this.panX, y: this.panY };
    }
  };

  private readonly onMouseMove = (evt: MouseEvent): void => {
    const pos = this.mouseScreenPos(evt);

    if (this.dragId) {
      const world = screenToWorld(pos.x, pos.y, this.currentViewport());
      this.layout?.setPosition(this.dragId, world.x, world.y);
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
    const nextHoverId = hit?.id ?? null;
    if (nextHoverId !== this.hoverId) {
      this.hoverId = nextHoverId;
      this.draw();
    }
    this.updateTooltip(pos, hit, inside);
  };

  private readonly onMouseUp = (evt: MouseEvent): void => {
    if (this.dragId) {
      const id = this.dragId;
      const moved = this.dragMoved;
      this.layout?.unpin(id);
      this.dragId = null;
      this.dragMoved = false;
      if (!moved) {
        this.handleNodeClick(id, evt);
      } else {
        this.nudgeSimulation();
      }
      this.draw();
      return;
    }
    if (this.isPanning) this.isPanning = false;
  };

  private readonly onWheel = (evt: WheelEvent): void => {
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

  private handleNodeClick(nodeId: string, evt: MouseEvent): void {
    if (!this.pkg || !this.graph) return;
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const ref = parseRef(node.id);
    if (!ref || ref.kind !== 'id') return;
    const newLeaf = evt.metaKey || evt.ctrlKey;
    void openRef(this.plugin, ref, this.pkg.absRoot, { newLeaf });
  }

  private updateTooltip(pos: { x: number; y: number }, node: GraphNode | null, inside = true): void {
    if (!node || !inside) {
      this.tooltipEl.hide();
      return;
    }
    this.tooltipEl.setText(localTooltip(node.id, node.name));
    this.tooltipEl.style.left = `${pos.x + 12}px`;
    this.tooltipEl.style.top = `${pos.y + 12}px`;
    this.tooltipEl.show();
  }

  private hideTooltip(): void {
    this.tooltipEl?.hide();
  }

  // ---- drawing ----------------------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    if (!this.graph || !this.layout) return;

    const vp = this.currentViewport();
    const style = getComputedStyle(this.containerEl);
    const edgeColor = style.getPropertyValue('--text-faint').trim() || '#8a8a8a';
    const centerRing = style.getPropertyValue('--interactive-accent').trim() || '#7c3aed';
    const hoverRing = style.getPropertyValue('--text-muted').trim() || '#999999';
    const textColor = style.getPropertyValue('--text-normal').trim() || '#222222';
    // Canvas `font` needs an already-resolved font-family (it does not read CSS custom
    // properties / var(...) the way element styles do), so read the computed value once.
    const fontFamily = style.fontFamily || 'sans-serif';

    this.drawEdges(ctx, this.graph.edges, vp, edgeColor);
    this.drawNodes(ctx, this.graph.nodes, vp, centerRing, hoverRing, textColor, fontFamily);
  }

  private drawEdges(ctx: CanvasRenderingContext2D, edges: GraphEdge[], vp: Viewport, color: string): void {
    for (const edge of edges) {
      const a = this.layout!.get(edge.source);
      const b = this.layout!.get(edge.target);
      const targetNode = this.graph!.nodes.find((n) => n.id === edge.target);
      if (!a || !b || !targetNode) continue;
      const pa = worldToScreen(a.x, a.y, vp);
      const pb = worldToScreen(b.x, b.y, vp);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(edge.frontmatter ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.restore();

      const backoff = nodeRadius(targetNode.isCenter, targetNode.distance) * this.zoom + 2;
      drawArrowhead(ctx, pa, pb, backoff, color);
    }
  }

  private drawNodes(
    ctx: CanvasRenderingContext2D,
    nodes: GraphNode[],
    vp: Viewport,
    centerRing: string,
    hoverRing: string,
    textColor: string,
    fontFamily: string,
  ): void {
    for (const node of nodes) {
      const p = this.layout!.get(node.id);
      if (!p) continue;
      const screen = worldToScreen(p.x, p.y, vp);
      const r = nodeRadius(node.isCenter, node.distance) * this.zoom;

      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fillStyle = typeColor(node.type);
      ctx.fill();

      if (node.isCenter) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = centerRing;
        ctx.stroke();
      } else if (node.id === this.hoverId) {
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
}
