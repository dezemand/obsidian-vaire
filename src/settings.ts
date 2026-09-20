import type { ExplorerNameMode } from './render/pure';
import { App, PluginSettingTab, Setting } from 'obsidian';
import type VairePlugin from './main';
import type { TypeColorSource } from './theme/families';
import type { BreadcrumbPlacement, TabTitleMode } from './nav/pure';

/** `always`: show on any hover. `modifier`: only while Ctrl/Cmd is held (mirrors Obsidian's own
 *  page-preview convention). `off`: never show the popover. */
export type HoverPreviewMode = 'always' | 'modifier' | 'off';

export interface VaireSettings {
  binaryPath: string;
  /** `perf/mcp-transport`: `'spawn'` (default) — every CLI read spawns a fresh `vaire`
   *  process, as on `main`. `'mcp'` — the eight read commands are routed through a persistent
   *  per-package-root `vaire mcp` server instead (src/mcp/); maintenance commands (index,
   *  check, status, add, pull, catalog, registry, release...) still spawn either way. Default
   *  is `'spawn'` so the trade-off is explicit and the two transports compare on equal footing
   *  (status bar shows spawn vs MCP call counts and p50/p95 latency — see src/cli.ts's
   *  `CliStats`/`CliLatencyStats`). Switchable at runtime.
   */
  cliTransport: 'spawn' | 'mcp';
  /**
   * `feat/dep-updates`: adds the global `--frozen` flag to every CLI call this plugin makes.
   * Frozen mode answers only from the store (registry.md §7) — a dependency that would
   * resolve to a working copy is refused instead of silently answered against it, which is
   * the whole point for reproducibility, but it also means a linked/workspace dependency
   * stops answering at all until it's pulled into the store. Off by default because most of
   * this plugin's day-to-day use (editing a package, following links to a linked dependency
   * you're also authoring) wants the two-worlds rule's normal behavior, not CI's.
   */
  frozen: boolean;
  /**
   * `feat/dep-updates`: when the package view's dependency-update check runs. `'manual'`
   * (default): only the "Check for updates" button/command touches the network — opening a
   * package never spawns a `vaire pull --dry-run`. `'on-open'`: also runs that dry-run check
   * (at most once per 30 minutes per package, cached in memory — see src/updates/index.ts)
   * when the package view opens, surfacing an "updates available" issue in the health strip.
   * The cost of `'on-open'` is real: a network round trip to every configured registry each
   * time the cache goes stale, and — depending on the registry — a fresh auth prompt each
   * time that round trip happens.
   */
  updateCheck: 'manual' | 'on-open';
  /**
   * `feat/dep-updates`: dependency names this plugin itself pinned (`vaire pin`), per package
   * absolute root, kept only as a fallback for when `knowledge.lock` doesn't expose pin state
   * in a shape `src/updates/pure.ts`'s `lockfilePins` recognizes — the lockfile is always
   * asked first. Never the source of truth: a pin made outside the plugin (or by a `vaire`
   * version whose lockfile shape we do recognize) won't appear here, and the Updates section
   * says so when it's relying on this instead of the lockfile.
   */
  pinnedDependencies: Record<string, string[]>;
  autoIndex: boolean;
  autoIndexDelayMs: number;
  suggestAll: boolean;
  insertDisplayText: boolean;
  suggestLimit: number;
  /** Folder pattern for the "New Vairë node" command; `{type}` is substituted. */
  newNodeFolderPattern: string;
  /** Primary folder-placement strategy for new nodes; `'infer'` falls back to the pattern
   *  when no existing node of that type exists to infer a folder from. */
  newNodePlacement: 'infer' | 'pattern';
  propertiesLinks: boolean;
  relationsFooter: boolean;
  /** When Add alias / Add edge change a node, also set its "updated" frontmatter field to
   *  today. */
  bumpUpdatedOnEdit: boolean;
  /** 'manual': diagnostics reflect `lastCheck` as updated by the Run check command / Check
   *  button. 'auto': also run `check` (debounced 1s, never concurrently per package) after
   *  every successful auto-index, so inline diagnostics stay fresh at the cost of one extra
   *  `vaire check` process per package per debounced save. */
  checkMode: 'manual' | 'auto';
  /** Passes `--strict` to every `vaire check` this plugin runs. */
  checkStrict: boolean;
  /**
   * How the external (dependency) read-only view gets its page content. `'render'` (default):
   * one `vaire render` call per page — names and links already resolved, links pre-rewritten
   * to plain Markdown. `'raw'`: read the file straight off disk and let the reading-mode post
   * processor resolve each `[[…]]` itself (one `cli.resolve` per unknown link, memoized). See
   * BRANCHES.md `feat/ext-render-mode` for the fidelity/speed trade-off this compares.
   */
  externalRenderMode: 'render' | 'raw';
  hoverPreview: HoverPreviewMode;
  /**
   * Live preview "B" variant (feat/lp-inline-names): render a Vairë wikilink in place as its
   * resolved name, hiding the raw `[[type:id]]`, except on the cursor's own line. Off falls
   * back to the "A" variant: the raw id stays visible everywhere, with the name as a muted
   * suffix (skipped on the cursor's line so editing is undisturbed).
   */
  livePreviewInlineNames: boolean;
  /** `perf/refs-prefetch`: `'refs-render'` batches a document's outbound refs into <=2 CLI
   *  calls (see render/prefetch.ts); `'off'` falls back to `main`'s per-link `resolve`, for
   *  an apples-to-apples spawn-count comparison without switching branches. */
  prefetchMode: 'refs-render' | 'off';
  /** Default outbound-refs depth for the local graph view (1-3); the view's toolbar can
   *  override this per session, writing the choice back here. */
  graphDepth: number;
  /** Last 10 search-panel queries, most recent first. See src/views/search-view.ts. */
  searchHistory: string[];
  /** Search panel's default scope selector: this package only, +dependencies, or every catalog package. */
  searchScope: 'local' | 'deps' | 'all';
  nodeEmbeds: boolean;
  /** Vault-relative folder "Export local graph to canvas" writes `.canvas` files into; created
   *  if missing. Not automatically kept outside package directories — see export.ts. */
  canvasFolder: string;
  /** Show a small type-slug badge (and, for package roots, a `pkg` badge) in the file explorer. */
  explorerBadges: boolean;
  /** Show the small type label (e.g. `CONCEPT`) before every Vairë link: reading mode, live
   *  preview, the node panel and other views. */
  typeLabelsOnLinks: boolean;
  /** Show the type label next to a node's name in tab headers and the view title. */
  typeLabelsInTabs: boolean;
  /** What the file explorer shows for a Vairë node: `'node'` (default) its `name`, `'id'` its full
   *  `type:id` address, `'file'` Obsidian's file basename. The original text stays in the DOM,
   *  hidden, so rename/edit still works; the row's tooltip keeps the file name. */
  explorerNames: ExplorerNameMode;
  /** Quick switcher (`vaire-quick-switch`): append up to 5 CLI-suggested dependency hits below
   *  the local results once the query is at least 3 characters. */
  quickSwitchIncludeDependencies: boolean;
  /**
   * How type badges get their colour (feat/type-colors; src/theme/). `'renderer'` (default):
   * a package's `vaire-renderer.toml` `[families]`/`[family_colors]` plus the renderer's
   * built-in family table/colours — so colours match the published site — falling back to
   * the renderer's deterministic FNV-hash family assignment for a type neither configures.
   * `'hash'`: a simple per-type hue hash, no config needed. `'off'`: the plain neutral badge.
   */
  typeColorSource: TypeColorSource;
  /** Run a health check (`cli.status` + `cli.deps` per package) shortly after the vault's
   *  packages are scanned on load, and Notice a summary per package that has issues. Also
   *  runnable on demand via the "Check package health" command regardless of this setting. */
  healthCheckOnLoad: boolean;
  /** On load, `cli.catalogAdd` any vault package this machine's catalog doesn't already have a
   *  sighting for at that absolute path. */
  autoRegisterCatalog: boolean;
  /** Default clustering strategy for the loose-end workbench (src/workbench/). The view's own
   *  toggle can switch per-session for comparison; this is what a freshly opened workbench
   *  starts on, and switching the toggle persists back here. */
  workbenchGrouping: 'exact' | 'fuzzy';
  /**
   * How the Vairë explorer (src/tree/) places a scoped node (frontmatter `scope: <container
   * full id>`) in the tree. `'nested'` (default): listed under its container's row instead of
   * its own type group, grouped by type there (e.g. `cli:vaire` -> `command` -> …); the
   * container row gets a child-count badge. `'flat'`: every node appears only in its type
   * group, like the published site, with a muted "in <container>" suffix. The view's toolbar
   * toggle switches this per session and writes the choice back here.
   */
  treeScopedLayout: 'nested' | 'flat';
  /**
   * The Vairë explorer's top-level grouping. `'type'` (default): package -> type -> nodes.
   * `'folder'`: mirrors the package's directory layout, showing node names and type badges
   * instead of file names. A container's own (nested-layout) children are always grouped by
   * type regardless of this setting. The view's toolbar toggle switches this per session and
   * writes the choice back here.
   */
  treeGroupBy: 'type' | 'folder';
  /**
   * `feat/tab-titles`: what a markdown tab header and its view title show for a Vairë node.
   * `'file'`: untouched (file basename, as Obsidian normally shows). `'node'` (default): the
   * node's name replaces the visible title — the original basename stays in the DOM, hidden,
   * so title-click-to-rename and tooltips keep working; the file itself is never renamed.
   * `'both'`: `Name · basename`. See `src/nav/titles.ts`.
   */
  tabTitles: TabTitleMode;
  /**
   * `feat/tab-titles`: where the scope breadcrumb trail (`package › container › … › this
   * node`) for a scoped node is shown. `'header'` (default): inside the reading-mode node
   * header. `'view'`: in the view header bar next to the title (also covers live preview).
   * `'off'`: nowhere. See `src/nav/breadcrumbs.ts`.
   */
  breadcrumbs: BreadcrumbPlacement;
  /**
   * Default backend for `vaire` query blocks (feat/query-blocks; src/query/) when a block
   * doesn't set its own `source:` clause. `'local'`: `LocalIndex` + the metadata cache only —
   * instant, re-renders on every metadata change, vault packages only. `'cli'`: `vaire`
   * backlinks/refs/search/unresolved — real ranked hybrid search, includes dependencies,
   * re-renders on index rebuild only. `'auto'` (default): local for a pure type/where/sort
   * block, cli as soon as search/refs-from/backlinks-to/unresolved appear (see
   * `pickSource`, src/query/pure.ts).
   */
  queryBlockSource: 'local' | 'cli' | 'auto';
  /**
   * `perf/disk-cache`: whether `resolve` results and backlink lists are persisted to disk
   * (`<vault>/.obsidian/plugins/vaire/cache.json`, see src/cache/) so a restart can render
   * external/cross-package links instantly instead of paying a fresh CLI spawn for the first
   * view of every page, at the cost of possibly showing a stale name until revalidated.
   * `'off'` (default): current behavior — every lookup goes to the CLI (memoized in-session
   * only), so this is the baseline to compare the other two modes against.
   * `'stale-while-revalidate'`: a cached value is shown immediately and refreshed in the
   * background; a changed result updates on-screen references in place.
   * `'trust-until-reindex'`: a cached value is served with no revalidation at all as long as
   * the package's index fingerprint hasn't moved since it was cached; any change (a reindex,
   * `vaire index --full`, ...) drops that package's entire cache.
   */
  persistentCache: 'off' | 'stale-while-revalidate' | 'trust-until-reindex';
  /**
   * `feat/node-history`: which source(s) the node panel's History section draws from.
   * `'releases'`: only the semantic, corpus-native source — releases whose `added`/`changed`/
   * `retired` edges cite this node (cheap, but only as granular as releases exist). `'git'`:
   * only the granular, file-level source — every commit that touched this file, via the local
   * git repository (needs the package to sit inside a git working tree; noisier). `'both'`
   * (default): both, as two sub-sections, so the two trade-offs compare side by side without
   * switching branches.
   */
  historySource: 'releases' | 'git' | 'both';
  /**
   * `feat/record-templates`: where "New Vairë node from template…" and the New-node modal's
   * "Use template…" button get their templates from. `'package'`: only a package's own
   * `<templateFolder>/<type>.md` files — curated by the package owner, travels with the
   * package, but nothing is offered for a type without one. `'builtin'`: the plugin's shipped
   * presets (src/templates/builtin.ts) for every declared type — always available, but not
   * curated by the owner. `'both'` (default): package template first per type, a builtin
   * preset for the rest, each option labeled with its source in the picker.
   */
  templateSource: 'package' | 'builtin' | 'both';
  /** Vault-relative folder, next to a package's `knowledge.toml`, holding its
   *  `<type>.md` template files (`feat/record-templates`). */
  templateFolder: string;
  /**
   * Default layout for the dependency graph view (src/depgraph/). `'tree'` (default): an
   * indented, collapsible outline mirroring the CLI's own nesting — exact and scannable,
   * repeated subtrees collapse to a "see above" link. `'graph'`: a force-directed node-link
   * diagram of the deduplicated closure — shows the shape of shared dependencies at the cost
   * of being less scannable. The view's own toolbar toggle switches this per session and
   * writes the choice back here.
   */
  depViewLayout: 'tree' | 'graph';
  /**
   * `feat/export-markdown`: how "Copy node as portable Markdown" builds its output, and the
   * default the "Export node as portable Markdown…" modal starts on (that command can override
   * this per export). `'render'` (default): one `vaire render` call — the CLI's exact portable
   * form, with every resolvable reference (including cross-package) rewritten to a plain
   * `[Name](path)` link — but needs an up-to-date index, and cross-package hrefs are
   * machine-specific filesystem paths (see `crossPackageLinks`). `'local'`: transforms the
   * *current editor buffer* using only this vault's `LocalIndex` — instant, includes unsaved and
   * unindexed edits, but only ever resolves vault nodes (a dependency not also open in this
   * vault degrades to its bare address, or a cached name if `plugin.resolveViaCli` already knows
   * it this session).
   */
  exportMode: 'render' | 'local';
  /**
   * `feat/export-markdown`, render mode only: how a cross-package link in `vaire render`'s
   * output — a real filesystem path into a dependency's store/working-copy root, meaningless on
   * a machine without that exact path — is written into the export. `'path'`: keep it as a link,
   * rebased to still resolve from the export's new location. `'text'`: drop the link, keep only
   * the display text. `'address'` (default): replace it with `Name (@pkg/type:id)` — portable,
   * and still tells the reader what package the reference lives in.
   */
  crossPackageLinks: 'path' | 'text' | 'address';
  /** Vault-relative folder "Export node as portable Markdown…" writes `<id>.md` files into
   *  (created if missing). Not automatically kept outside package directories — see
   *  src/export/index.ts, same convention as `canvasFolder`. */
  exportFolder: string;
  /** Whether both export modes append a "## Relations" list (the frontmatter edges, each
   *  resolved like a body reference) at the end of the export. Default on. */
  exportEdgesSection: boolean;
  /**
   * `feat/package-graph`: default layout for the whole-package graph view (its own toolbar
   * toggle can switch per session, writing the choice back here). `'force'` (default): the
   * same seeded `ForceLayout` the local graph uses (now Barnes-Hut accelerated above 150
   * nodes — src/graph/quadtree.ts), run over the *whole* package — shows clusters and hubs
   * organically, but node positions carry no fixed meaning and a large/densely-connected
   * package reads as a hairball. `'lanes'`: one deterministic vertical lane per type
   * (ordered who/what/how/when/why/where, then alphabetically — src/theme/families.ts),
   * nodes sorted by degree then name within a lane — positions are stable and meaningful
   * ("where are the decisions?"), but clusters are invisible and cross-lane edges pile up.
   */
  packageGraphLayout: 'force' | 'lanes';
}

export const DEFAULT_SETTINGS: VaireSettings = {
  binaryPath: '',
  cliTransport: 'spawn',
  frozen: false,
  updateCheck: 'manual',
  pinnedDependencies: {},
  autoIndex: true,
  autoIndexDelayMs: 2500,
  suggestAll: false,
  insertDisplayText: false,
  suggestLimit: 10,
  newNodeFolderPattern: '{type}s',
  newNodePlacement: 'infer',
  propertiesLinks: true,
  relationsFooter: true,
  checkMode: 'manual',
  checkStrict: false,
  externalRenderMode: 'render',
  hoverPreview: 'always',
  livePreviewInlineNames: true,
  prefetchMode: 'refs-render',
  graphDepth: 2,
  bumpUpdatedOnEdit: true,
  searchHistory: [],
  searchScope: 'deps',
  nodeEmbeds: true,
  // Keep in sync with graph/export.ts's DEFAULT_CANVAS_FOLDER (used there only as a fallback if
  // this ever ends up empty, e.g. a hand-edited data.json).
  canvasFolder: 'Vairë canvases',
  explorerBadges: true,
  typeLabelsOnLinks: true,
  typeLabelsInTabs: true,
  explorerNames: 'node',
  quickSwitchIncludeDependencies: true,
  typeColorSource: 'renderer',
  healthCheckOnLoad: true,
  autoRegisterCatalog: true,
  workbenchGrouping: 'exact',
  treeScopedLayout: 'nested',
  treeGroupBy: 'type',
  tabTitles: 'node',
  breadcrumbs: 'header',
  queryBlockSource: 'auto',
  persistentCache: 'off',
  historySource: 'both',
  templateSource: 'both',
  templateFolder: 'templates',
  depViewLayout: 'tree',
  exportMode: 'render',
  crossPackageLinks: 'address',
  exportFolder: 'Vairë exports',
  exportEdgesSection: true,
  packageGraphLayout: 'force',
};

export class VaireSettingTab extends PluginSettingTab {
  plugin: VairePlugin;
  private detectedEl: HTMLElement | null = null;

  constructor(app: App, plugin: VairePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Binary path')
      .setDesc('Absolute path to the vaire binary. Leave empty to auto-detect from PATH.')
      .addText((text) => {
        text
          .setPlaceholder('auto')
          .setValue(this.plugin.settings.binaryPath)
          .onChange(async (value) => {
            this.plugin.settings.binaryPath = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => void this.refreshDetected());
      });

    this.detectedEl = containerEl.createDiv({ cls: 'vaire-settings-detected setting-item-description' });
    void this.refreshDetected();

    new Setting(containerEl)
      .setName('CLI transport')
      .setDesc(
        '"Spawn" (default): every read spawns a fresh vaire process, as on main. "Persistent MCP server": ' +
          'the eight read commands (resolve, render, backlinks, refs, search, suggest, unresolved, deps) go ' +
          'through one long-lived "vaire mcp" server per package instead — maintenance commands (index, check, ' +
          'add, pull, ...) still spawn either way. Switchable live; the status bar tooltip shows call counts ' +
          'and p50/p95 latency for both transports so you can compare.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ spawn: 'Spawn (default)', mcp: 'Persistent MCP server' })
          .setValue(this.plugin.settings.cliTransport)
          .onChange(async (value) => {
            this.plugin.settings.cliTransport = value === 'mcp' ? 'mcp' : 'spawn';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Frozen mode')
      .setDesc(
        'Add --frozen to every vaire call: dependencies answer only from the store, and one that would ' +
          'resolve to a working copy is refused (with the pull that would fix it) instead of silently ' +
          "answered against it. Off by default — most editing wants a linked dependency you're also " +
          'authoring to keep answering.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.frozen).onChange(async (value) => {
          this.plugin.settings.frozen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Dependency update check')
      .setDesc(
        '"Manual" (default): checking for dependency updates never happens on its own — only the ' +
          '"Check for updates" button/command touches the network. "On package open": also runs that ' +
          'check (vaire pull --dry-run, at most once per 30 minutes per package, cached in memory) when ' +
          "you open a package's index, and adds an \"updates available\" issue to its health strip. That " +
          'costs a real network round trip to every configured registry each time the cache goes stale, ' +
          'and, depending on the registry, a fresh auth prompt each time.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ manual: 'Manual', 'on-open': 'On package open' })
          .setValue(this.plugin.settings.updateCheck)
          .onChange(async (value) => {
            this.plugin.settings.updateCheck = value === 'on-open' ? 'on-open' : 'manual';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Live preview: inline names')
      .setDesc(
        'Show the resolved node name in place of a raw [[type:id]] when the cursor is elsewhere. ' +
          'Off shows the raw id everywhere, with the name as a muted suffix instead.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.livePreviewInlineNames).onChange(async (value) => {
          this.plugin.settings.livePreviewInlineNames = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-index on save')
      .setDesc('Reindex a package (working tree) shortly after you save a file inside it.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoIndex).onChange(async (value) => {
          this.plugin.settings.autoIndex = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-index delay (ms)')
      .setDesc('How long to wait after the last save before reindexing.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.autoIndexDelayMs)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.autoIndexDelayMs = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Link Properties panel values')
      .setDesc('Render Vairë references shown in the Properties panel (frontmatter) as clickable resolved links.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.propertiesLinks).onChange(async (value) => {
          this.plugin.settings.propertiesLinks = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Suggest from every catalog package')
      .setDesc('Include results from every package this machine knows about, not just this one and its dependencies.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.suggestAll).onChange(async (value) => {
          this.plugin.settings.suggestAll = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Quick switch: include dependencies')
      .setDesc(
        'In the quick switcher (Cmd/Ctrl+Shift+O), once you\'ve typed at least 3 characters, append up to 5 ' +
          "matching nodes from the active package's dependencies below the local results.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.quickSwitchIncludeDependencies).onChange(async (value) => {
          this.plugin.settings.quickSwitchIncludeDependencies = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Insert display text on link insert')
      .setDesc('When inserting a suggested link, add "|Display name" after the id.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.insertDisplayText).onChange(async (value) => {
          this.plugin.settings.insertDisplayText = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Check mode')
      .setDesc(
        'Manual: inline diagnostics reflect the last "Run check" / Check button result. ' +
          'Auto: also run check after every successful auto-index (one extra `vaire check` per package per save).',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ manual: 'Manual', auto: 'Auto (after auto-index)' })
          .setValue(this.plugin.settings.checkMode)
          .onChange(async (value) => {
            this.plugin.settings.checkMode = value === 'auto' ? 'auto' : 'manual';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Strict check')
      .setDesc('Pass --strict to every check this plugin runs (treats warnings as violations).')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.checkStrict).onChange(async (value) => {
          this.plugin.settings.checkStrict = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('External page rendering')
      .setDesc(
        '"Rendered" asks vaire to render the whole page in one call — names and links already ' +
          'resolved. "Raw" reads the file straight off disk and resolves each link as it renders ' +
          '(one CLI call per unknown link, memoized).',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ render: 'Rendered (vaire render)', raw: 'Raw file' })
          .setValue(this.plugin.settings.externalRenderMode)
          .onChange(async (value) => {
            this.plugin.settings.externalRenderMode = value === 'raw' ? 'raw' : 'render';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Hover preview')
      .setDesc(
        'Show a popover with node details (name, aliases, edges, first paragraph) when hovering a Vairë ' +
          "reference Obsidian's own page preview can't handle — external links, live-preview links, and " +
          'links in the node header/panel. "Hold Ctrl/Cmd" mirrors the modifier Obsidian itself uses for ' +
          'page preview.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ always: 'Always', modifier: 'Hold Ctrl/Cmd', off: 'Off' })
          .setValue(this.plugin.settings.hoverPreview)
          .onChange(async (value) => {
            this.plugin.settings.hoverPreview = value as VaireSettings['hoverPreview'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Reference prefetch')
      .setDesc(
        'Per-document batching: one "refs" + one "render" CLI call per rendered node instead of ' +
          'one "resolve" per external link. Set to "Off" to compare against the per-link behavior ' +
          'without switching branches.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('refs-render', 'Batched (refs + render)')
          .addOption('off', 'Off (per-link resolve)')
          .setValue(this.plugin.settings.prefetchMode)
          .onChange(async (value) => {
            this.plugin.settings.prefetchMode = value === 'off' ? 'off' : 'refs-render';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Persistent cache')
      .setDesc(
        'Save resolve results and backlink lists to disk so a restart renders external/cross-package links ' +
          'instantly instead of re-spawning vaire for the first view of every page. "Off" (default) never ' +
          'persists, matching current behavior. "Stale while revalidate" shows a cached value immediately and ' +
          'refreshes it in the background, updating on-screen references in place if it changed. "Trust until ' +
          "reindex\" serves a cached value with no revalidation at all as long as the package's index hasn't " +
          "changed since — fastest, but a name can go stale until the package is reindexed.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('off', 'Off')
          .addOption('stale-while-revalidate', 'Stale while revalidate')
          .addOption('trust-until-reindex', 'Trust until reindex')
          .setValue(this.plugin.settings.persistentCache)
          .onChange(async (value) => {
            this.plugin.settings.persistentCache = value as VaireSettings['persistentCache'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Suggestion limit')
      .setDesc('Maximum number of CLI-backed suggestions to request.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.suggestLimit)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.suggestLimit = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('New node folder placement')
      .setDesc(
        "'Infer from existing nodes' uses the most common folder among existing nodes of the chosen type, " +
          "falling back to the pattern below when there are none. 'Always use pattern' always uses it.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('infer', 'Infer from existing nodes')
          .addOption('pattern', 'Always use pattern')
          .setValue(this.plugin.settings.newNodePlacement)
          .onChange(async (value) => {
            this.plugin.settings.newNodePlacement = value === 'pattern' ? 'pattern' : 'infer';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('New node folder pattern')
      .setDesc("Folder for a new node when inference doesn't apply (or placement is 'Always use pattern'). \"{type}\" is substituted with the node's type.")
      .addText((text) =>
        text.setValue(this.plugin.settings.newNodeFolderPattern).onChange(async (value) => {
          this.plugin.settings.newNodeFolderPattern = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Type labels').setHeading();

    new Setting(containerEl)
      .setName('On links')
      .setDesc('Show the type (e.g. CONCEPT) before every Vairë link, in reading mode, live preview and the Vairë views.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.typeLabelsOnLinks).onChange(async (value) => {
          this.plugin.settings.typeLabelsOnLinks = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('In the file explorer')
      .setDesc('Show the type after each Vairë node in the file explorer, and a "pkg" label on package root folders.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.explorerBadges).onChange(async (value) => {
          this.plugin.settings.explorerBadges = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('In tab titles')
      .setDesc("Show the type next to a node's name in tab headers and the view title.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.typeLabelsInTabs).onChange(async (value) => {
          this.plugin.settings.typeLabelsInTabs = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Other').setHeading();

    new Setting(containerEl)
      .setName("Bump 'updated' on edit")
      .setDesc('When Add alias / Add edge change a node, set its "updated" frontmatter field to today.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.bumpUpdatedOnEdit).onChange(async (value) => {
          this.plugin.settings.bumpUpdatedOnEdit = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('File explorer names')
      .setDesc(
        'What the file explorer shows for a Vairë node. "Node name" (default) shows its name, "Node id" ' +
          'shows its type:id address, "File name" leaves Obsidian\'s file name. Hovering a row still shows the file name.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ node: 'Node name', id: 'Node id', file: 'File name' })
          .setValue(this.plugin.settings.explorerNames)
          .onChange(async (value) => {
            this.plugin.settings.explorerNames = value === 'id' || value === 'file' ? value : 'node';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Type badge colors')
      .setDesc(
        '"Renderer" (default): colour badges from a package\'s vaire-renderer.toml plus the ' +
          "renderer's built-in family table, so colours match the published site. \"Hash\": a " +
          'simple per-type colour with no config needed. "Off": the plain neutral badge.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ renderer: 'Renderer (match published site)', hash: 'Hash (no config)', off: 'Off' })
          .setValue(this.plugin.settings.typeColorSource)
          .onChange(async (value) => {
            this.plugin.settings.typeColorSource = value as VaireSettings['typeColorSource'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Relations footer')
      .setDesc(
        'In reading mode, append References, Backlinks, Supersedes and Loose ends below every Vairë node, like the published site.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.relationsFooter).onChange(async (value) => {
          this.plugin.settings.relationsFooter = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Local graph depth')
      .setDesc('Default outbound-refs depth for the local graph view. Its toolbar can override this per session.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '1': '1', '2': '2', '3': '3' })
          .setValue(String(this.plugin.settings.graphDepth))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 1 && n <= 3) {
              this.plugin.settings.graphDepth = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('Node embeds')
      .setDesc(
        'In reading mode, render ![[type:id]] (and #Heading / @pkg variants) as an inline embed of the referenced node, like Obsidian embeds notes.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.nodeEmbeds).onChange(async (value) => {
          this.plugin.settings.nodeEmbeds = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Health check on load')
      .setDesc(
        'Shortly after the vault is scanned, check every package (index built? up to date? dependencies linked?) ' +
          'and Notice a summary for any package with issues. Always available on demand via the ' +
          '"Check package health" command.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.healthCheckOnLoad).onChange(async (value) => {
          this.plugin.settings.healthCheckOnLoad = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Canvas folder')
      .setDesc(
        '"Export local graph to canvas" writes .canvas files here (created if missing). Avoid a path inside a ' +
          'package directory — the plugin warns but still writes there if it is.',
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.canvasFolder).onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            this.plugin.settings.canvasFolder = trimmed;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Auto-register vault packages in the catalog')
      .setDesc(
        "On load, run `vaire catalog add` for any vault package this machine's catalog doesn't already have a " +
          'sighting for at that path.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRegisterCatalog).onChange(async (value) => {
          this.plugin.settings.autoRegisterCatalog = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Loose-end workbench grouping')
      .setDesc(
        "Default clustering strategy when the workbench opens. 'Exact' only merges identical wording (and never " +
          "crosses type hints); 'Fuzzy' also merges similar wording (token overlap), which can group occurrences " +
          'with different or missing type hints — the workbench itself has a toggle to compare the two.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('exact', 'Exact')
          .addOption('fuzzy', 'Fuzzy')
          .setValue(this.plugin.settings.workbenchGrouping)
          .onChange(async (value) => {
            this.plugin.settings.workbenchGrouping = value === 'fuzzy' ? 'fuzzy' : 'exact';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Explorer: scoped node layout')
      .setDesc(
        "'Nested' (default): a scoped node is listed under its container's row instead of its own type group, " +
          "grouped by type there. 'Flat': every node appears only in its type group, like the published site, " +
          "with a muted \"in <container>\" suffix. The explorer's own toolbar toggle can switch this per session.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ nested: 'Nested (grouped under container)', flat: 'Flat (like the published site)' })
          .setValue(this.plugin.settings.treeScopedLayout)
          .onChange(async (value) => {
            this.plugin.settings.treeScopedLayout = value === 'flat' ? 'flat' : 'nested';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Tab titles')
      .setDesc(
        '"File name": tab headers and the view title show the file basename, as Obsidian normally does. ' +
          '"Node name": the node\'s name replaces the visible title (the basename stays in the DOM, hidden, ' +
          "so title-click-to-rename and tooltips keep working — the file itself is never renamed). \"Both\": " +
          '"Name · basename".',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ file: 'File name', node: 'Node name', both: 'Both' })
          .setValue(this.plugin.settings.tabTitles)
          .onChange(async (value) => {
            this.plugin.settings.tabTitles = value as VaireSettings['tabTitles'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Explorer: group by')
      .setDesc(
        "'Type' (default): package -> type -> nodes. 'Folder': mirrors the package's directory layout, showing " +
          "node names and type badges instead of file names. The explorer's own toolbar toggle can switch this " +
          'per session.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ type: 'Type', folder: 'Folder' })
          .setValue(this.plugin.settings.treeGroupBy)
          .onChange(async (value) => {
            this.plugin.settings.treeGroupBy = value === 'folder' ? 'folder' : 'type';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Scope breadcrumbs')
      .setDesc(
        "For a scoped node, show a breadcrumb trail (package › container › … › this node). \"Node header\": " +
          'inside the reading-mode node header. "View header": in the view header bar next to the title ' +
          '(also covers live preview). "Off": nowhere.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ header: 'Node header', view: 'View header', off: 'Off' })
          .setValue(this.plugin.settings.breadcrumbs)
          .onChange(async (value) => {
            this.plugin.settings.breadcrumbs = value as VaireSettings['breadcrumbs'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Query block source')
      .setDesc(
        "Default backend for ```vaire query blocks when a block doesn't set its own \"source:\" clause. " +
          "'Local' answers instantly from the vault index (metadata changes only, vault packages only). " +
          "'CLI' uses vaire's real search/backlinks/refs/unresolved (includes dependencies, refreshes on " +
          "index rebuild only). 'Auto' picks local for a plain type/where query and cli as soon as search, " +
          'refs-from, backlinks-to or unresolved is used.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ auto: 'Auto', local: 'Local (instant)', cli: 'CLI (search/backlinks/refs)' })
          .setValue(this.plugin.settings.queryBlockSource)
          .onChange(async (value) => {
            this.plugin.settings.queryBlockSource = value as VaireSettings['queryBlockSource'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Node history source')
      .setDesc(
        "The node panel's History section (below Backlinks). 'Releases': which release records " +
          "cite this node (added/changed/retired) — cheap, meaningful, only as granular as " +
          "releases exist. 'Git': every commit that touched this file, from the local git " +
          "repository — granular, but needs git and is noisier. 'Both' (default): both, as two " +
          'sub-sections, to compare side by side.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ both: 'Both (default)', releases: 'Releases only', git: 'Git only' })
          .setValue(this.plugin.settings.historySource)
          .onChange(async (value) => {
            this.plugin.settings.historySource = value as VaireSettings['historySource'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Template source')
      .setDesc(
        '"New Vairë node from template…" and the New-node modal\'s "Use template…" button. "Package templates": ' +
          'only a package\'s own templates/<type>.md files (curated by the owner, travels with the package). ' +
          '"Builtin presets": the plugin\'s shipped presets for every declared type, regardless of what the ' +
          'package curates. "Both" (default): package template first per type, a builtin preset for the rest, ' +
          'each option labeled with its source.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ both: 'Both (default)', package: 'Package templates', builtin: 'Builtin presets' })
          .setValue(this.plugin.settings.templateSource)
          .onChange(async (value) => {
            this.plugin.settings.templateSource = value as VaireSettings['templateSource'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Template folder')
      .setDesc(
        "Vault-relative folder, next to a package's knowledge.toml, holding its <type>.md template files " +
          "(e.g. \"templates\" → templates/decision.md is the decision template).",
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.templateFolder).onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            this.plugin.settings.templateFolder = trimmed;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Dependency view layout')
      .setDesc(
        '"Tree" (default): an indented, collapsible outline mirroring vaire deps\' own nesting — exact and ' +
          'scannable, repeated subtrees collapse to a "see above" link. "Graph": a force-directed node-link ' +
          "diagram of the deduplicated closure — shows the shape of shared dependencies. The view's own " +
          'toolbar toggle can switch this per session.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ tree: 'Tree (outline)', graph: 'Graph (diagram)' })
          .setValue(this.plugin.settings.depViewLayout)
          .onChange(async (value) => {
            this.plugin.settings.depViewLayout = value === 'graph' ? 'graph' : 'tree';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Portable Markdown export mode')
      .setDesc(
        '"Copy node as portable Markdown" uses this directly; "Export node as portable Markdown…" starts on ' +
          'it but can override it per export. "Render": exact vaire render output — every resolvable reference ' +
          'rewritten, including cross-package, but needs an up-to-date index. "Local": transforms the current ' +
          "editor buffer using only this vault's index — instant, includes unsaved edits, but vault-only.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ render: 'Render (vaire render)', local: 'Local (editor buffer)' })
          .setValue(this.plugin.settings.exportMode)
          .onChange(async (value) => {
            this.plugin.settings.exportMode = value === 'local' ? 'local' : 'render';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Cross-package links in exports')
      .setDesc(
        'Render mode only — vaire render\'s cross-package hrefs are real, machine-specific filesystem paths. ' +
          '"Keep relative path": rebased to still resolve from the export\'s new location. "Display text only": ' +
          'drop the link, keep the text. "Name (@pkg/type:id)" (default): replace it with the portable address.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ path: 'Keep relative path', text: 'Display text only', address: 'Name (@pkg/type:id)' })
          .setValue(this.plugin.settings.crossPackageLinks)
          .onChange(async (value) => {
            this.plugin.settings.crossPackageLinks = value as VaireSettings['crossPackageLinks'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Export folder')
      .setDesc(
        '"Export node as portable Markdown…" writes <id>.md files here (created if missing). Avoid a path ' +
          'inside a package directory — the plugin warns but still writes there if it is.',
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.exportFolder).onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed) {
            this.plugin.settings.exportFolder = trimmed;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Export: Relations section')
      .setDesc(
        'Append a "## Relations" list (the frontmatter edges, each resolved like a body reference) at the end ' +
          'of every export, in both modes.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.exportEdgesSection).onChange(async (value) => {
          this.plugin.settings.exportEdgesSection = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Package graph layout')
      .setDesc(
        "Default layout for the whole-package graph view (its own toolbar toggle can switch per session). " +
          "'Force': the seeded force layout over the whole package — organic clusters and hubs, but positions " +
          "carry no fixed meaning and a dense package reads as a hairball. 'Lanes': one vertical lane per type " +
          '(ordered who/what/how/when/why/where, then alphabetically), nodes sorted by degree then name within ' +
          "a lane — stable, meaningful positions (\"where are the decisions?\"), but clusters are invisible and " +
          'cross-lane edges pile up.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ force: 'Force (organic clusters)', lanes: 'Lanes (stable, by type)' })
          .setValue(this.plugin.settings.packageGraphLayout)
          .onChange(async (value) => {
            this.plugin.settings.packageGraphLayout = value === 'lanes' ? 'lanes' : 'force';
            await this.plugin.saveSettings();
          }),
      );
  }

  private async refreshDetected(): Promise<void> {
    if (!this.detectedEl) return;
    this.detectedEl.setText('Detecting vaire binary...');
    const bin = this.plugin.cli.binary();
    const version = await this.plugin.cli.version();
    this.detectedEl.setText(
      version ? `Detected: ${bin} (version ${version})` : `Detected: ${bin} (not runnable — check the path)`,
    );
  }
}
