import { Events, Notice, Plugin, TFile } from 'obsidian';
import { VaireCli, resolveMemoKey } from './cli';
import type { IdRef, LooseRef } from './ids';
import { PackageRegistry, type LocalNode, type PackageInfo } from './packages';
import { DEFAULT_SETTINGS, VaireSettingTab, type VaireSettings } from './settings';
import type { CheckResult, ResolveResult } from './types';
import { PersistentCache } from './cache/store';
import { cachedResolve } from './cache/query';
import { registerRendering } from './render/index';
import { registerSuggestions } from './suggest/index';
import { registerViews } from './views/index';
import { registerGraph } from './graph/index';
import { registerDepGraph } from './depgraph/index';
import { registerPackageGraph } from './package-graph/index';
import { registerDiagnostics } from './diagnostics/index';
import { registerStatusBar } from './status-bar';
import { registerAuthoring, registerSupersede } from './authoring/index';
import { registerTemplates } from './templates/index';
import { registerTypeColors } from './theme/index';
import { registerHealth } from './health/index';
import { registerUpdates } from './updates/index';
import { registerWorkbench } from './workbench/index';
import { registerTree } from './tree/index';
import { registerNav } from './nav/index';
import { registerQueryBlocks } from './query/index';
import { registerHistory } from './history/index';
import { registerExport } from './export/index';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default class VairePlugin extends Plugin {
  settings!: VaireSettings;
  cli!: VaireCli;
  packages!: PackageRegistry;

  /** `perf/disk-cache`: the on-disk resolve/backlinks cache behind `persistentCache`. See
   *  src/cache/store.ts, src/cache/query.ts and src/cache/pure.ts. */
  cache!: PersistentCache;

  /** Resolves once `cache.load()` (kicked off from `onload` below, not awaited there — this
   *  plugin never blocks `onload` on I/O) has finished reading `cache.json`. `cache/query.ts`
   *  awaits this before its first read of the cache each session, so an early lookup can't
   *  race the load and see an empty cache when a real one is on disk. */
  cacheReady!: Promise<void>;

  /**
   * Resolves once the initial package scan (`packages.init()`, kicked off from
   * `workspace.onLayoutReady` below) has completed. `src/health/index.ts` awaits this before
   * running the on-load health check / catalog auto-registration, so it never races the scan.
   */
  packagesReady!: Promise<void>;

  /** Plugin-local pub/sub. Triggers `'index-rebuilt'` (payload: package absRoot) and `'settings-changed'`. */
  readonly events = new Events();

  /**
   * Extension points for features not built in phase 1 (external read-only pages, loose-end
   * resolution). `src/navigate.ts` calls these when set; until then it falls back to a Notice.
   */
  readonly hooks: {
    openExternal?: (ref: IdRef, absRoot: string, opts?: { newLeaf?: boolean }) => Promise<void>;
    resolveLooseEnd?: (ref: LooseRef, fromRepo: PackageInfo | string, at?: { file: TFile; line: number }) => Promise<void>;
    /**
     * Opens the external read-only view for an absolute filesystem path, rather than a
     * resolved `type:id` — used by the `feat/ext-render-mode` reading-mode branch for
     * `vaire://<absolute-path>` links inside `render`-mode external pages (see
     * `src/render/reading.ts` and `ExternalState.filePath` in `src/views/external-view.ts`).
     */
    openExternalFile?: (absPath: string, opts?: { newLeaf?: boolean }) => Promise<void>;
    /**
     * Creates a new entity node for a descriptor of the given `type` and returns its new id,
     * or `null` if the flow was cancelled. Not built on this branch — `feat/new-node` (see
     * BRANCHES.md) owns entity creation; until it lands, this stays `undefined` and any caller
     * that only makes sense with it (the check-findings quick fix `dangling_ref`'s "Create
     * entity…", `src/diagnostics/fixes.ts`) simply doesn't offer that action.
     */
    createNode?: (opts: { pkg: PackageInfo; type: string; descriptor: string }) => Promise<{ id: string } | null>;
  } = {};

  /** `cli.resolve` memoized per `repo + NUL + id`; cleared whenever an index is rebuilt. Also
   *  the seeding target for the refs-prefetch pass — see `resolveMemoKey` in cli.ts and
   *  render/prefetch.ts. */
  readonly resolveMemo = new Map<string, Promise<ResolveResult | null>>();

  /** Batches a rendered vault node's outbound refs into at most two CLI calls (`refs` +
   *  `render`) and seeds `resolveMemo`, so `createRefElement` finds everything already
   *  settled. Wired up by the rendering pass (`registerRendering`, see render/prefetch.ts); a
   *  no-op until then. */
  prefetchDocument: (pkg: PackageInfo, node: LocalNode) => Promise<void> = async () => {};

  /** Most recent `check` result per package absRoot. */
  readonly lastCheck = new Map<string, CheckResult>();

  private readonly autoIndexTimers = new Map<string, number>();
  private readonly lastAutoIndexError = new Map<string, string>();

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.cli = new VaireCli(() => this.settings, undefined, {
      // perf/mcp-transport: a package root's persistent MCP server crashed past its restart
      // budget (3/min) and has permanently fallen back to spawn for the rest of the session.
      onMcpFallback: (absRoot, reason) =>
        new Notice(`Vairë: the MCP server for ${absRoot} kept crashing — falling back to per-call spawn. (${reason})`),
    });
    this.packages = new PackageRegistry(this.app, this);

    this.cache = new PersistentCache(this);
    this.cacheReady = this.cache.load();

    this.app.workspace.onLayoutReady(() => {
      this.packagesReady = this.packages.init();
    });

    this.addSettingTab(new VaireSettingTab(this.app, this));

    this.registerEvent(
      this.events.on('index-rebuilt', (root) => {
        this.resolveMemo.clear();
        if (typeof root !== 'string') return;
        // perf/mcp-transport: restart (don't reuse) the pooled MCP client for this root — see
        // src/mcp/pool.ts's `restart()` doc comment for why.
        this.cli.restartMcpClient(root);
        // perf/disk-cache: the package's index just changed, so its cached resolve/backlinks
        // entries are presumed stale regardless of `persistentCache` mode — see
        // `PersistentCache.reindexed`.
        this.cache.reindexed(root);
      }),
    );

    this.registerEvent(
      this.events.on('settings-changed', () => {
        // perf/mcp-transport: a lingering `vaire mcp` child would otherwise outlive the user
        // switching the setting back to spawn (idle-shutdown is 5 minutes).
        if (this.settings.cliTransport !== 'mcp') this.cli.closeMcpPool();
      }),
    );


    this.registerCommands();
    this.registerAutoIndex();

    void this.checkBinaryAvailable();

    registerRendering(this);
    registerSuggestions(this);
    registerViews(this);
    registerGraph(this);
    registerDepGraph(this); // dependency graph view: tree/graph closure of `cli.deps`, see src/depgraph/index.ts
    registerPackageGraph(this); // feat/package-graph: whole-package graph view, see src/package-graph/index.ts
    registerDiagnostics(this);
    registerStatusBar(this); // perf/refs-prefetch: CLI activity counter, see src/status-bar.ts
    registerSupersede(this);
    registerAuthoring(this);
    registerTemplates(this); // feat/record-templates: "New Vairë node from template…", see src/templates/index.ts
    registerTypeColors(this);
    registerHealth(this);
    registerUpdates(this); // feat/dep-updates: Check for updates / Update / Pin / Unpin / Reproduce lockfile / Clean store
    registerWorkbench(this);
    registerTree(this);
    registerNav(this); // feat/tab-titles: tab/view title node names + 'view'-placement breadcrumbs
    registerQueryBlocks(this); // feat/query-blocks: live `vaire` query code blocks, see src/query/index.ts
    registerHistory(this); // feat/node-history: node panel History section + "Show node history" command
    registerExport(this); // feat/export-markdown: portable Markdown export commands, see src/export/index.ts
  }

  onunload(): void {
    for (const timer of this.autoIndexTimers.values()) window.clearTimeout(timer);
    this.autoIndexTimers.clear();
    this.cli.closeMcpPool(); // perf/mcp-transport: don't leak `vaire mcp` child processes
    void this.cache.flush(); // perf/disk-cache: don't lose a pending debounced write
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.events.trigger('settings-changed');
  }

  /** `cli.resolve(absRoot, id)`, memoized (a `id_not_found` error resolves to `null` instead
   *  of throwing — see `cache/query.ts`'s `fetchResolve`). `perf/disk-cache`: below the
   *  in-memory memo, `cachedResolve` (src/cache/query.ts) consults the on-disk cache per
   *  `settings.persistentCache` before ever falling through to a real CLI call — see
   *  DESIGN.md's disk-cache trade-off note. The memo stays the first layer either way, so a
   *  hit here (disk-cache or CLI) is only ever paid once per repo+id per session. */
  resolveViaCli(absRoot: string, id: string): Promise<ResolveResult | null> {
    const key = resolveMemoKey(absRoot, id);
    let promise = this.resolveMemo.get(key);
    if (!promise) {
      promise = cachedResolve(this, absRoot, id);
      this.resolveMemo.set(key, promise);
    }
    return promise;
  }

  async rebuildIndex(pkg: PackageInfo, opts: { full?: boolean } = {}): Promise<void> {
    const label = opts.full ? 'full' : 'working tree';
    new Notice(`Vairë: rebuilding index (${label}) for ${pkg.name}…`);
    try {
      await this.cli.index(pkg.absRoot, opts.full ? { full: true } : { workingTree: true });
      this.events.trigger('index-rebuilt', pkg.absRoot); // clears resolveMemo via the listener registered in onload()
      new Notice(`Vairë: index rebuilt for ${pkg.name}`);
    } catch (err) {
      new Notice(`Vairë: rebuilding the index for ${pkg.name} failed — ${errMessage(err)}`);
    }
  }

  /** Runs `vaire check`, stores the result in `lastCheck`, and triggers `'check-completed'`
   * (payload: package absRoot) so the inline diagnostics and status bar (src/diagnostics/)
   * pick it up. Throws on a real error (e.g. `index_not_built`); a `check` that finds
   * violations is a normal outcome (`cli.check` resolves, it never throws for that). */
  async runCheck(pkg: PackageInfo, strict = false): Promise<CheckResult> {
    const result = await this.cli.check(pkg.absRoot, { strict });
    this.lastCheck.set(pkg.absRoot, result);
    this.events.trigger('check-completed', pkg.absRoot);
    return result;
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'rebuild-index-working-tree',
      name: 'Rebuild index (working tree)',
      checkCallback: (checking) => {
        const pkg = this.activeFilePackage();
        if (!pkg) return false;
        if (!checking) void this.rebuildIndex(pkg, { full: false });
        return true;
      },
    });

    this.addCommand({
      id: 'rebuild-index-full',
      name: 'Rebuild index (full)',
      checkCallback: (checking) => {
        const pkg = this.activeFilePackage();
        if (!pkg) return false;
        if (!checking) void this.rebuildIndex(pkg, { full: true });
        return true;
      },
    });

    this.addCommand({
      id: 'run-check',
      name: 'Run check',
      checkCallback: (checking) => {
        const pkg = this.activeFilePackage();
        if (!pkg) return false;
        if (!checking) {
          void this.runCheck(pkg, this.settings.checkStrict).then(
            (result) =>
              new Notice(
                `Vairë check (${pkg.name}): ${result.violations.length} violation(s), ${result.warnings.length} warning(s)`,
              ),
            (err) => new Notice(`Vairë: check failed — ${errMessage(err)}`),
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: 'copy-node-id',
      name: "Copy this node's id",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const pkg = file ? this.packages.packageFor(file) : null;
        const node = pkg && file ? pkg.index.byFile(file) : null;
        if (!node) return false;
        if (!checking) {
          navigator.clipboard.writeText(node.full).then(
            () => new Notice(`Copied ${node.full}`),
            () => new Notice('Vairë: could not copy to the clipboard'),
          );
        }
        return true;
      },
    });
  }

  private activeFilePackage(): PackageInfo | null {
    const file = this.app.workspace.getActiveFile();
    return file ? this.packages.packageFor(file) : null;
  }

  private registerAutoIndex(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.settings.autoIndex) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const pkg = this.packages.packageFor(file);
        if (!pkg) return;
        this.scheduleAutoIndex(pkg);
      }),
    );
  }

  private scheduleAutoIndex(pkg: PackageInfo): void {
    const existing = this.autoIndexTimers.get(pkg.absRoot);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.autoIndexTimers.delete(pkg.absRoot);
      void this.runAutoIndex(pkg);
    }, this.settings.autoIndexDelayMs);
    this.autoIndexTimers.set(pkg.absRoot, timer);
  }

  private async runAutoIndex(pkg: PackageInfo): Promise<void> {
    try {
      await this.cli.index(pkg.absRoot, { workingTree: true });
      this.lastAutoIndexError.delete(pkg.absRoot);
      this.events.trigger('index-rebuilt', pkg.absRoot); // clears resolveMemo via the listener registered in onload()
    } catch (err) {
      const message = errMessage(err);
      if (this.lastAutoIndexError.get(pkg.absRoot) !== message) {
        this.lastAutoIndexError.set(pkg.absRoot, message);
        new Notice(`Vairë: auto-index failed for ${pkg.name} — ${message}`);
      }
    }
  }

  private async checkBinaryAvailable(): Promise<void> {
    const ok = await this.cli.available();
    if (ok) return;
    new Notice(
      'Vairë: the vaire binary was not found. Install it and set the path in Settings → Vairë if it is not on PATH. ' +
        'Rendering still works from the local index; CLI-backed features are unavailable until then.',
      0,
    );
  }
}
