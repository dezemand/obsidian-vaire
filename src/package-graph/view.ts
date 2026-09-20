// Whole-package graph view. See DESIGN.md-style feature brief in BRANCHES.md wave 7
// (`feat/package-graph`): unlike the local graph (src/graph/, one node's CLI-fetched
// neighborhood), this draws every node of one vault package and every edge between them, built
// entirely locally from `LocalIndex` + frontmatter edges + the metadata cache's own `links`
// (src/package-graph/pure.ts's `buildPackageGraph`) — no CLI calls, so it's instant even on
// `packages/vaire` (~160 nodes, ~2800 edges) or `acme-platform` (~250 nodes).
//
// Two layouts, switchable per session (and by default via `settings.packageGraphLayout`):
// `force` reuses `src/graph/layout.ts`'s `ForceLayout` (now Barnes-Hut accelerated above 150
// nodes) over the whole package; `lanes` is a single deterministic pass
// (`src/package-graph/pure.ts`'s `laneLayout`) with one vertical lane per type.

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { parseRef } from '../ids';
import { openRef } from '../navigate';
import type { PackageInfo } from '../packages';
import { localTooltip } from '../render/pure';
import { FAMILY_ORDER } from '../theme/families';
import type VairePlugin from '../main';
import { ForceLayout } from '../graph/layout';
import {
  clampZoom,
  distance as ptDistance,
  hashSeed,
  screenToWorld,
  typeColor,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../graph/pure';
import {
  buildPackageGraph,
  degrees,
  laneLayout,
  radiusForDegree,
  type PackageGraphEdge,
  type PackageGraphModel,
  type PackageGraphNode,
} from './pure';

export const VIEW_TYPE_PACKAGE_GRAPH = 'vaire-package-graph';

type LayoutMode = 'force' | 'lanes';

const MAX_TICKS = 300;
const ENERGY_EPSILON = 0.05;
/** How long a single click waits to see if a second one arrives (making it a double-click)
 *  before actually opening the node — see `handleRawClick`'s doc comment. */
const DBLCLICK_MS = 280;

interface PackageGraphViewState {
  packageDir: string;
}

interface Position {
  x: number;
  y: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PackageGraphView extends ItemView {
  private readonly plugin: VairePlugin;
  private packageDir = '';

  // Filters / toggles
  private layoutMode: LayoutMode;
  private includeDependencies = false;
  private hideSuperseded = true;
  private hideOrphans = false;
  private readonly disabledTypes = new Set<string>();
  private textFilter = '';

  // Data
  private graph: PackageGraphModel | null = null;
  private forceLayout: ForceLayout | null = null;
  private lanePositions: Map<string, Position> | null = null;

  // Chrome
  private toolbarEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private filterInput!: HTMLInputElement;
  private layoutForceBtn!: HTMLButtonElement;
  private layoutLanesBtn!: HTMLButtonElement;
  private supersededToggle!: HTMLButtonElement;
  private orphansToggle!: HTMLButtonElement;
  private depsToggle!: HTMLButtonElement;
  private countEl!: HTMLElement;
  private canvasWrapEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private tooltipEl!: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private metaDebounce: number | null = null;

  // Canvas sizing (CSS pixels; devicePixelRatio handled purely in the transform).
  private viewportWidth = 800;
  private viewportHeight = 600;

  // Pan/zoom
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private isPanning = false;
  private panMoved = false;
  private panStartScreen: Position = { x: 0, y: 0 };
  private panStartOffset: Position = { x: 0, y: 0 };
  private mouseDownHit: string | null = null;

  // Hover / click-vs-double-click
  private hoverId: string | null = null;
  private pendingClick: { id: string; timer: number } | null = null;
  private lastClick: { id: string; time: number } | null = null;

  // Simulation loop (force layout only)
  private rafId: number | null = null;
  private simActive = false;
  private tickCount = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.layoutMode = plugin.settings.packageGraphLayout;
  }

  getViewType(): string {
    return VIEW_TYPE_PACKAGE_GRAPH;
  }

  getIcon(): string {
    return 'share-2';
  }

  getDisplayText(): string {
    const pkg = this.currentPkg();
    return pkg ? `${pkg.name} graph` : 'Package graph';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), packageDir: this.packageDir };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<PackageGraphViewState> | undefined;
    if (s && typeof s.packageDir === 'string') this.packageDir = s.packageDir;
    await super.setState(state, result);
    this.reload();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-package-graph-view');
    this.buildChrome();

    this.registerEvent(
      this.plugin.events.on('local-index-rebuilt', () => this.scheduleRefresh()),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        const pkg = this.currentPkg();
        if (!pkg) return;
        if (pkg.dir !== '' && !file.path.startsWith(`${pkg.dir}/`)) return;
        this.scheduleRefresh();
      }),
    );

    this.registerDomEvent(this.canvas, 'mousedown', this.onMouseDown);
    this.registerDomEvent(this.canvas, 'wheel', this.onWheel, { passive: false });
    this.registerDomEvent(window, 'mousemove', this.onMouseMove);
    this.registerDomEvent(window, 'mouseup', this.onMouseUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvasWrapEl);
    this.handleResize();

    this.reload();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    if (this.pendingClick) window.clearTimeout(this.pendingClick.timer);
    this.stopLoop();
    this.contentEl.empty();
  }

  private currentPkg(): PackageInfo | null {
    return this.plugin.packages.all().find((p) => p.dir === this.packageDir) ?? null;
  }

  private scheduleRefresh(): void {
    if (this.metaDebounce != null) window.clearTimeout(this.metaDebounce);
    this.metaDebounce = window.setTimeout(() => {
      this.metaDebounce = null;
      this.reload();
    }, 500);
  }

  // ---- chrome -----------------------------------------------------------------------------

  private buildChrome(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.toolbarEl = contentEl.createDiv({ cls: 'vaire-pkg-graph-toolbar' });

    const layoutGroup = this.toolbarEl.createDiv({ cls: 'vaire-pkg-graph-btn-group' });
    this.layoutForceBtn = layoutGroup.createEl('button', { cls: 'vaire-graph-toggle', text: 'Force' });
    this.layoutLanesBtn = layoutGroup.createEl('button', { cls: 'vaire-graph-toggle', text: 'Lanes' });
    this.layoutForceBtn.addEventListener('click', () => this.setLayoutMode('force'));
    this.layoutLanesBtn.addEventListener('click', () => this.setLayoutMode('lanes'));

    this.depsToggle = this.toolbarEl.createEl('button', { cls: 'vaire-graph-toggle', text: 'Show dependencies' });
    this.depsToggle.addEventListener('click', () => {
      this.includeDependencies = !this.includeDependencies;
      this.reload();
    });

    this.supersededToggle = this.toolbarEl.createEl('button', { cls: 'vaire-graph-toggle', text: 'Hide superseded' });
    this.supersededToggle.addEventListener('click', () => {
      this.hideSuperseded = !this.hideSuperseded;
      this.reload();
    });

    this.orphansToggle = this.toolbarEl.createEl('button', { cls: 'vaire-graph-toggle', text: 'Hide orphans' });
    this.orphansToggle.addEventListener('click', () => {
      this.hideOrphans = !this.hideOrphans;
      this.reload();
    });

    this.filterInput = this.toolbarEl.createEl('input', {
      cls: 'vaire-pkg-graph-filter',
      attr: { type: 'text', placeholder: 'Filter…' },
    });
    this.filterInput.addEventListener('input', () => {
      this.textFilter = this.filterInput.value;
      this.draw();
    });

    const fitBtn = this.toolbarEl.createEl('button', { cls: 'vaire-graph-refresh', text: 'Fit' });
    fitBtn.addEventListener('click', () => this.fitToView());
    const resetBtn = this.toolbarEl.createEl('button', { cls: 'vaire-graph-refresh', text: 'Reset' });
    resetBtn.addEventListener('click', () => this.resetView());

    this.countEl = this.toolbarEl.createSpan({ cls: 'vaire-graph-status' });

    this.chipsEl = contentEl.createDiv({ cls: 'vaire-pkg-graph-chips' });

    const body = contentEl.createDiv({ cls: 'vaire-graph-body' });
    this.canvasWrapEl = body.createDiv({ cls: 'vaire-graph-canvas-wrap' });
    this.canvas = this.canvasWrapEl.createEl('canvas', { cls: 'vaire-graph-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('vaire: could not get a 2d canvas context');
    this.ctx = ctx;
    this.tooltipEl = this.canvasWrapEl.createDiv({ cls: 'vaire-graph-tooltip' });
    this.tooltipEl.hide();

    this.updateToggleChrome();
  }

  private updateToggleChrome(): void {
    this.layoutForceBtn.toggleClass('is-active', this.layoutMode === 'force');
    this.layoutLanesBtn.toggleClass('is-active', this.layoutMode === 'lanes');
    this.depsToggle.toggleClass('is-active', this.includeDependencies);
    this.supersededToggle.toggleClass('is-active', this.hideSuperseded);
    this.orphansToggle.toggleClass('is-active', this.hideOrphans);
  }

  private setLayoutMode(mode: LayoutMode): void {
    if (this.layoutMode === mode) return;
    this.layoutMode = mode;
    this.plugin.settings.packageGraphLayout = mode;
    void this.plugin.saveSettings();
    this.updateToggleChrome();
    if (this.graph) this.startLayout(this.graph);
  }

  private setStatus(text: string): void {
    this.countEl.setText(text);
  }

  // ---- data loading -------------------------------------------------------------------------

  private reload(): void {
    this.stopLoop();
    this.hoverId = null;
    this.hideTooltip();

    const pkg = this.currentPkg();
    if (!pkg) {
      this.showEmpty('This package is no longer in the vault.');
      return;
    }

    this.updateToggleChrome();

    const localNodes = pkg.index.all();
    const inputs = localNodes.map((n) => ({
      full: n.full,
      type: n.type,
      name: n.name,
      frontmatter: n.frontmatter,
      supersededBy: n.supersededBy,
    }));
    const linksByFile = new Map<string, string[]>();
    for (const n of localNodes) {
      const cache = this.app.metadataCache.getFileCache(n.file);
      linksByFile.set(n.full, (cache?.links ?? []).map((l) => l.link));
    }

    // Every type actually present (after dependency/superseded/orphan filters, but *before* the
    // type filter itself — otherwise disabling every chip but one would make the rest vanish
    // from the toolbar along with the graph, leaving no way to re-enable them).
    const chipBasis = buildPackageGraph(inputs, linksByFile, {
      includeDependencies: this.includeDependencies,
      hideSuperseded: this.hideSuperseded,
      hideOrphans: false,
    });
    const allTypes = [...new Set(chipBasis.nodes.map((n) => n.type))].sort((a, b) => a.localeCompare(b));
    const typeCounts = new Map<string, number>();
    for (const n of chipBasis.nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
    // Drop a disabled-type entry that no longer exists (e.g. after "Show dependencies" is
    // switched off and a dependency-only type disappears).
    for (const t of [...this.disabledTypes]) if (!allTypes.includes(t)) this.disabledTypes.delete(t);
    this.renderChips(allTypes, typeCounts);

    const enabledTypes = new Set(allTypes.filter((t) => !this.disabledTypes.has(t)));
    const typesFilter = this.disabledTypes.size > 0 ? enabledTypes : undefined;

    const graph = buildPackageGraph(inputs, linksByFile, {
      includeDependencies: this.includeDependencies,
      hideSuperseded: this.hideSuperseded,
      hideOrphans: this.hideOrphans,
      types: typesFilter,
      resolveDependencyName: (id) => this.resolveGhostName(id),
    });
    this.graph = graph;
    this.setStatus(`${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}, ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}`);
    this.startLayout(graph);
  }

  /** Same trick `src/graph/graph-view.ts`'s `namesResolver` uses: a dependency's real display
   *  name only if that package also happens to be open as a sibling vault package — never a CLI
   *  call, per this feature's "built locally and instantly, no CLI calls" contract. */
  private resolveGhostName(fullId: string): string | undefined {
    const ref = parseRef(fullId);
    if (!ref || ref.kind !== 'id' || !ref.pkg) return undefined;
    const depPkg = this.plugin.packages.byName(ref.pkg);
    return depPkg?.index.get(ref.local)?.name;
  }

  private renderChips(types: string[], counts: Map<string, number>): void {
    this.chipsEl.empty();
    for (const type of types) {
      const chip = this.chipsEl.createEl('button', { cls: 'vaire-chip vaire-pkg-graph-chip' });
      const swatch = chip.createSpan({ cls: 'vaire-pkg-graph-chip-swatch' });
      swatch.style.backgroundColor = typeColor(type);
      chip.createSpan({ text: `${type} (${counts.get(type) ?? 0})` });
      const disabled = this.disabledTypes.has(type);
      chip.toggleClass('is-off', disabled);
      chip.addEventListener('click', () => {
        if (this.disabledTypes.has(type)) this.disabledTypes.delete(type);
        else this.disabledTypes.add(type);
        this.reload();
      });
    }
  }

  private showEmpty(text: string): void {
    this.graph = null;
    this.forceLayout = null;
    this.lanePositions = null;
    if (this.chipsEl) this.chipsEl.empty();
    this.setStatus(text);
    this.draw();
  }

  // ---- layout -------------------------------------------------------------------------------

  private startLayout(graph: PackageGraphModel): void {
    this.stopLoop();
    if (this.layoutMode === 'lanes') {
      this.forceLayout = null;
      this.lanePositions = laneLayout(graph, FAMILY_ORDER, { width: this.viewportWidth, height: this.viewportHeight });
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      this.draw();
      return;
    }

    this.lanePositions = null;
    const seed = hashSeed(this.packageDir || 'vaire-package-graph');
    this.forceLayout = new ForceLayout(
      graph.nodes.map((n) => ({ id: n.id })),
      graph.edges,
      { width: this.viewportWidth, height: this.viewportHeight, seed },
    );
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
    if (!this.forceLayout || !this.simActive) {
      this.draw();
      return;
    }
    const energy = this.forceLayout.step();
    this.tickCount++;
    this.draw();
    if (this.tickCount >= MAX_TICKS || energy < ENERGY_EPSILON) {
      this.simActive = false;
      this.fitToView(); // frame the settled result once, so the initial view isn't cropped
      return;
    }
    this.scheduleTick();
  };

  private positionOf(id: string): Position | undefined {
    if (this.lanePositions) return this.lanePositions.get(id);
    return this.forceLayout?.get(id);
  }

  private allPositions(): Position[] {
    if (this.lanePositions) return [...this.lanePositions.values()];
    return this.forceLayout?.all() ?? [];
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
    this.forceLayout?.resize(width, height);
    this.draw();
  }

  // ---- pan/zoom/hover/click ---------------------------------------------------------------

  private currentViewport(): Viewport {
    return { panX: this.panX, panY: this.panY, zoom: this.zoom };
  }

  private mouseScreenPos(evt: MouseEvent): Position {
    const rect = this.canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  private hitTestNode(screenX: number, screenY: number): PackageGraphNode | null {
    if (!this.graph) return null;
    const deg = degrees(this.graph);
    const world = screenToWorld(screenX, screenY, this.currentViewport());
    let hit: PackageGraphNode | null = null;
    for (const node of this.graph.nodes) {
      const p = this.positionOf(node.id);
      if (!p) continue;
      const r = radiusForDegree(deg.get(node.id) ?? 0) + 3;
      if (ptDistance(world.x, world.y, p.x, p.y) <= r) hit = node; // last match wins (drawn on top)
    }
    return hit;
  }

  private readonly onMouseDown = (evt: MouseEvent): void => {
    if (evt.button !== 0) return;
    const pos = this.mouseScreenPos(evt);
    if (pos.x < 0 || pos.y < 0 || pos.x > this.viewportWidth || pos.y > this.viewportHeight) return;
    const hit = this.hitTestNode(pos.x, pos.y);
    this.mouseDownHit = hit?.id ?? null;
    this.isPanning = true;
    this.panMoved = false;
    this.panStartScreen = pos;
    this.panStartOffset = { x: this.panX, y: this.panY };
  };

  private readonly onMouseMove = (evt: MouseEvent): void => {
    const pos = this.mouseScreenPos(evt);

    if (this.isPanning) {
      const dx = pos.x - this.panStartScreen.x;
      const dy = pos.y - this.panStartScreen.y;
      if (Math.hypot(dx, dy) > 3) this.panMoved = true;
      // Only actually pan the camera once we know this isn't a click-on-a-node — otherwise a
      // few pixels of jitter while clicking would visibly nudge the view.
      if (this.panMoved && this.mouseDownHit == null) {
        this.panX = this.panStartOffset.x + dx;
        this.panY = this.panStartOffset.y + dy;
        this.draw();
      }
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
    if (!this.isPanning) return;
    this.isPanning = false;
    if (!this.panMoved && this.mouseDownHit) {
      this.handleRawClick(this.mouseDownHit, evt);
    }
    this.mouseDownHit = null;
    this.panMoved = false;
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

  /**
   * Disambiguates a single click (open the node, Cmd/Ctrl = new leaf) from the first half of a
   * double-click (re-center on the node) by holding every click for `DBLCLICK_MS` before acting
   * on it: if a second click on the *same* node arrives within that window, the pending "open"
   * is cancelled and "re-center" runs instead. Without this, double-clicking a node would just
   * fire two opens back to back (the first of which may well navigate this very leaf away from
   * the graph before the second/native dblclick event could ever reach it) instead of the
   * "double-click re-centers" behavior DESIGN.md's feature brief calls for.
   */
  private handleRawClick(nodeId: string, evt: MouseEvent): void {
    const now = performance.now();
    if (this.lastClick && this.lastClick.id === nodeId && now - this.lastClick.time < DBLCLICK_MS) {
      if (this.pendingClick) {
        window.clearTimeout(this.pendingClick.timer);
        this.pendingClick = null;
      }
      this.lastClick = null;
      this.centerOnNode(nodeId);
      return;
    }
    this.lastClick = { id: nodeId, time: now };
    const newLeaf = evt.metaKey || evt.ctrlKey;
    const timer = window.setTimeout(() => {
      this.pendingClick = null;
      this.openNode(nodeId, newLeaf);
    }, DBLCLICK_MS);
    this.pendingClick = { id: nodeId, timer };
  }

  private openNode(nodeId: string, newLeaf: boolean): void {
    const pkg = this.currentPkg();
    if (!pkg || !this.graph) return;
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const ref = parseRef(node.id);
    if (!ref || ref.kind !== 'id') return;
    void openRef(this.plugin, ref, pkg.absRoot, { newLeaf });
  }

  private centerOnNode(nodeId: string): void {
    const p = this.positionOf(nodeId);
    if (!p) return;
    this.panX = this.viewportWidth / 2 - p.x * this.zoom;
    this.panY = this.viewportHeight / 2 - p.y * this.zoom;
    this.draw();
  }

  private fitToView(): void {
    const positions = this.allPositions();
    if (positions.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of positions) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 50;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const zoomX = (this.viewportWidth - pad * 2) / spanX;
    const zoomY = (this.viewportHeight - pad * 2) / spanY;
    const zoom = clampZoom(Math.min(zoomX, zoomY));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.zoom = zoom;
    this.panX = this.viewportWidth / 2 - cx * zoom;
    this.panY = this.viewportHeight / 2 - cy * zoom;
    this.draw();
  }

  private resetView(): void {
    if (this.graph) this.startLayout(this.graph); // re-run the layout fresh, same seed
    else {
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      this.draw();
    }
  }

  private updateTooltip(pos: Position, node: PackageGraphNode | null, inside = true): void {
    if (!node || !inside) {
      this.tooltipEl.hide();
      return;
    }
    this.tooltipEl.setText(localTooltip(node.id, node.name) + (node.isGhost ? ' · dependency' : ''));
    this.tooltipEl.style.left = `${pos.x + 12}px`;
    this.tooltipEl.style.top = `${pos.y + 12}px`;
    this.tooltipEl.show();
  }

  private hideTooltip(): void {
    this.tooltipEl?.hide();
  }

  // ---- drawing ----------------------------------------------------------------------------

  /** Nodes directly connected to `id` (either direction), plus `id` itself — the "neighborhood"
   *  hover highlights, per DESIGN.md. */
  private neighborhoodOf(id: string): Set<string> {
    const set = new Set<string>([id]);
    if (!this.graph) return set;
    for (const e of this.graph.edges) {
      if (e.source === id) set.add(e.target);
      else if (e.target === id) set.add(e.source);
    }
    return set;
  }

  private matchesTextFilter(node: PackageGraphNode): boolean {
    const needle = this.textFilter.trim().toLowerCase();
    if (!needle) return true;
    return node.id.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle);
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    if (!this.graph) return;

    const vp = this.currentViewport();
    const style = getComputedStyle(this.containerEl);
    const edgeColor = style.getPropertyValue('--text-faint').trim() || '#8a8a8a';
    const hoverRing = style.getPropertyValue('--interactive-accent').trim() || '#7c3aed';
    const textColor = style.getPropertyValue('--text-normal').trim() || '#222222';
    const fontFamily = style.fontFamily || 'sans-serif';

    const deg = degrees(this.graph);
    const highlight = this.hoverId ? this.neighborhoodOf(this.hoverId) : null;
    const searching = this.textFilter.trim().length > 0;

    // Culling margin: the largest possible node radius (radiusForDegree's own cap), so a node
    // whose center is just off screen but whose circle still overlaps the viewport isn't dropped.
    const cullMargin = radiusForDegree(Number.MAX_SAFE_INTEGER) * this.zoom + 20;
    const inViewport = (p: Position): boolean => {
      const s = worldToScreen(p.x, p.y, vp);
      return s.x >= -cullMargin && s.y >= -cullMargin && s.x <= this.viewportWidth + cullMargin && s.y <= this.viewportHeight + cullMargin;
    };

    this.drawEdges(ctx, this.graph.edges, vp, edgeColor, highlight, searching, inViewport);
    this.drawNodes(ctx, this.graph.nodes, deg, vp, hoverRing, textColor, fontFamily, highlight, searching, inViewport);
  }

  private edgeDimmed(
    edge: PackageGraphEdge,
    highlight: Set<string> | null,
    searching: boolean,
  ): boolean {
    if (highlight) return !(highlight.has(edge.source) && highlight.has(edge.target));
    if (searching && this.graph) {
      const s = this.graph.nodes.find((n) => n.id === edge.source);
      const t = this.graph.nodes.find((n) => n.id === edge.target);
      return !((s && this.matchesTextFilter(s)) || (t && this.matchesTextFilter(t)));
    }
    return false;
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    edges: PackageGraphEdge[],
    vp: Viewport,
    color: string,
    highlight: Set<string> | null,
    searching: boolean,
    inViewport: (p: Position) => boolean,
  ): void {
    for (const edge of edges) {
      const a = this.positionOf(edge.source);
      const b = this.positionOf(edge.target);
      if (!a || !b) continue;
      if (!inViewport(a) && !inViewport(b)) continue; // cull: neither endpoint is near the screen

      const dimmed = this.edgeDimmed(edge, highlight, searching);
      const pa = worldToScreen(a.x, a.y, vp);
      const pb = worldToScreen(b.x, b.y, vp);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = dimmed ? 0.04 : highlight ? 0.55 : 0.14; // low alpha by default, per DESIGN.md
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawNodes(
    ctx: CanvasRenderingContext2D,
    nodes: PackageGraphNode[],
    deg: Map<string, number>,
    vp: Viewport,
    hoverRing: string,
    textColor: string,
    fontFamily: string,
    highlight: Set<string> | null,
    searching: boolean,
    inViewport: (p: Position) => boolean,
  ): void {
    for (const node of nodes) {
      const p = this.positionOf(node.id);
      if (!p) continue;
      if (!inViewport(p)) continue; // cull off-screen nodes

      const screen = worldToScreen(p.x, p.y, vp);
      const r = radiusForDegree(deg.get(node.id) ?? 0) * this.zoom;

      const dimmed = highlight ? !highlight.has(node.id) : searching && !this.matchesTextFilter(node);

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fillStyle = typeColor(node.type);
      ctx.fill();
      if (node.isGhost) {
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = textColor;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (node.id === this.hoverId) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = hoverRing;
        ctx.stroke();
      }

      if (this.zoom > 0.5 && !dimmed) {
        ctx.fillStyle = textColor;
        ctx.font = `${Math.max(9, 11 * Math.min(this.zoom, 1.4))}px ${fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(node.name, screen.x + r + 4, screen.y);
      }
      ctx.restore();
    }
  }
}
