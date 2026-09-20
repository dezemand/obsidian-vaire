# Feature branches

Every feature after the initial plugin lands on its own branch off `main`. Where a feature
has a real design trade-off, each alternative is a separate branch so they can be compared
in Obsidian. To try a branch: `git checkout <branch> && bun install && bun run build && bun
run install:vault`, then reload the plugin in Obsidian.

Status legend: ⏳ in progress · ✅ built and tested (unit + typecheck) · 🔀 merged into main.

Merged into main: variants are switchable via settings (`livePreviewInlineNames`, `externalRenderMode`, `checkMode`, …).

## Wave 1

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/lp-inline-names` | live preview shows the node **name in place of** `type:id` when the cursor is elsewhere (replace decoration) | vs. `main`, which keeps the raw id and appends the name as a muted suffix. Compare editing feel and how obvious the underlying id stays. |
| 🔀 `feat/relations-footer` | reading mode appends **References →, Backlinks ←, Supersedes, Loose ends** below the document, like the published site | vs. sidebar-only relations (node panel on `main`). Compare noise vs. discoverability. |
| 🔀 `feat/properties-links` | Obsidian's **Properties** panel values that are Vairë refs become clickable resolved links | vs. raw text + the node header. |
| 🔀 `feat/hover-preview` | hovering a Vairë link (external, unlinked, live preview) shows a **popover** with type, name, aliases and the first paragraph | vs. no preview for non-local links. |
| 🔀 `feat/new-node` | **New Vairë node** command (type picker, slug, name, folder inferred from existing nodes of that type) and **Create entity from loose end** | folder placement: inferred vs. a pattern setting (both in this branch; compare defaults). |
| 🔀 `feat/check-diagnostics` | `vaire check` findings shown **inline in the editor** (underlines + gutter tooltips) with a setting to run check automatically after auto-index | on-demand vs. automatic check cost. |

## Wave 2

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `perf/refs-prefetch` | per-page **batched resolution**: one `vaire refs` + one `vaire render` per document instead of one `vaire resolve` per external link; adds a status-bar CLI activity counter | vs. `main`'s per-link memoized `resolve`. Compare spawn counts on a link-heavy page and first-paint latency. |
| 🔀 `feat/ext-render-mode` | external read-only pages rendered from **`vaire render` output** (names already resolved, links pre-rewritten) | vs. `main`'s raw file + post processor. Compare fidelity of names/links and speed. |
| 🔀 `feat/local-graph` | a **local graph** view of the active node (refs depth 2 + backlinks) drawn with a small force layout | vs. nothing (Obsidian's graph can't see Vairë links). |
| 🔀 `feat/rendering-fidelity` | **scope-first** resolution of bare ids inside scoped nodes, and clickable `vaire/…` shape links in rendered **Mermaid** diagrams | correctness features, single way. |
| 🔀 `feat/backlinks-context` | backlinks with **context snippets** (the referencing line) in the node panel, and a dedicated **Vairë backlinks** view resembling Obsidian's | vs. bare id rows on `main`. |
| 🔀 `feat/release-ui` | **release** section in the package index: pending release from `status`, `vaire release --dry-run` plan, cut a release with a summary, changelog from release records | exposes maintainer actions in the UI; compare against CLI-only. |

## Wave 3

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/node-embeds` | `![[type:id]]` / `![[@pkg/type:id]]` **transclusion**: the node body rendered inline with a title bar; `#Heading` sections; nested embeds depth-limited | vs. no embeds. |
| 🔀 `feat/edge-editor` | **Add alias / Add edge** from the node panel (additive frontmatter edits), `[[?` **loose-end suggester** (type picker + "use existing node" nudges), Insert loose end command | authoring helpers; additive-only by design. |
| 🔀 `feat/search-panel` | persistent **search panel** with scope (package / deps / all), type and container filters, anchors with highlighted snippets, history | vs. the search modal on `main`. |
| 🔀 `feat/supersede-flow` | **Supersede this node with…**: tombstone via `superseded_by`, optional alias merge, optional reference rewrite, backlink preview, MAJOR warning | reference rewrite on vs. off (both offered; default off). |
| 🔀 `feat/canvas-export` (from `feat/local-graph`) | **export the local graph to an Obsidian Canvas** file (file cards for vault nodes, text cards for dependencies) | vs. the live canvas view. |

## Wave 4

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/quick-fixes` | **quick fixes** for `vaire check` findings as editor lint actions, package-view buttons and a command, following the check-triage skill (resolve, turn into loose end, strip brackets, add type to manifest, link/pull dependency, refresh display text, declare dependency) | never deletes or guesses ids by design. |
| 🔀 `feat/explorer-badges` | **type badges** in the file explorer, `pkg` badge on package roots, superseded rows struck through | `explorerNames`: file basename vs node name. |
| 🔀 `feat/quick-switcher` | **Quick switch to node** (Mod+Shift+O) over every vault node, `type:` and `@pkg` filters, dependency hits from `vaire suggest`; **Insert link to node…** | `quickSwitchIncludeDependencies`: local-only (instant) vs local + CLI. |
| 🔀 `feat/type-colors` | **colored type badges** everywhere | `typeColorSource`: `renderer` (matches the published site via `vaire-renderer.toml` families) vs `hash` (no config) vs `off`. |
| 🔀 `feat/package-health` | **health strip** and on-load notices (index missing or stale, unlinked deps, uncached embeddings, pending release), **catalog auto-registration**, **Initialize a Vairë package here…** | on-load check cost vs silence (`healthCheckOnLoad`, `autoRegisterCatalog`). |
| 🔀 `feat/unresolved-workbench` | **loose-end workbench**: grouped `[[?…]]`, resolve a whole group, create an entity for it, inline suggestions | `workbenchGrouping`: exact vs fuzzy. |

## Wave 5

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/type-tree` | **Vairë explorer** sidebar: package → type (or folder) → nodes, filterable, with the active file's node highlighted and revealed | `treeScopedLayout`: scoped nodes **nested** under their container's row (grouped by type, with a child-count badge) vs. **flat** like the published site (muted "in `<container>`" suffix); independently, `treeGroupBy`: **type**-first vs. **folder**-first browsing (mirrors the package's directory layout, node names + type badges instead of file names). Both switchable from the explorer's own toolbar as well as Settings. |
| 🔀 `feat/tab-titles` | markdown **tab headers and the view title show the node's name** (plus a small type badge) instead of the file basename; **scope breadcrumbs** (`package › container › … › this node`) for a scoped node | `tabTitles`: file name / node name / both. `breadcrumbs`: node header / view header / off. |
| 🔀 `feat/query-blocks` | live **`vaire` query blocks**: a fenced ` ```vaire ` code block (`type`/`where`/`backlinks-to`/`refs-from`/`search`/`unresolved`/`sort`/`limit`/`show`/`columns`) renders a list or table over the graph, with a footer reporting match count, source and latency | `source: local \| cli \| auto` per block (default from setting `queryBlockSource`, `auto`): `local` (`LocalIndex` + metadata cache, instant, vault packages only, plain substring `search`) vs. `cli` (`vaire` backlinks/refs/search/unresolved, includes dependencies, refreshes on index rebuild only) — put two blocks with the same query side by side, one pinned to each, to compare results and latency directly. |
| 🔀 `feat/rename-id` | **Rename node id…**: new id/type, backlinks preview (in-vault vs. dependency/other-package), two fully-implemented strategies side by side — **tombstone** (writes the new file, turns the old one into a minimal redirect, old address keeps resolving) vs. **rewrite in place** (renames the file, changes id/type, old address disappears — MAJOR for anything outside this package) | both strategies are offered every time, not a setting — compare release-safety vs. a clean address with no leftover tombstone. |
| 🔀 `perf/mcp-transport` | **persistent transport**: one long-lived `vaire mcp --repo <root>` per package for the eight read commands (JSON-RPC over stdio), idle shutdown, restart on reindex, fallback to spawn after repeated crashes | `cliTransport`: spawn per call vs persistent MCP; status bar tooltip shows call counts and p50/p95 latency per transport. Catalog-wide `--all` searches still spawn (the MCP tools don't expose it). |
| 🔀 `perf/disk-cache` | **persistent resolve/backlinks cache**: `vaire resolve`/`vaire backlinks` results saved to `<vault>/.obsidian/plugins/vaire/cache.json` so a restart renders external/cross-package links instantly instead of paying a fresh CLI spawn for the first view of every page | `persistentCache`: `off` (current behavior, in-session memo only) / `stale-while-revalidate` (serve cached immediately, refresh in the background, redraw on-screen refs in place if it changed) / `trust-until-reindex` (serve cached with no revalidation as long as the package's index fingerprint hasn't moved — fastest, but a name can go stale until the package is reindexed). Compare cold-start vs. warm-start spawn counts in the status bar tooltip, and how quickly a renamed node's old name disappears from other pages under each mode. |

## Wave 6

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/node-history` | node panel **History** section (below Backlinks; command "Show node history"): "how has this node changed?" | `historySource`: `releases` (semantic, corpus-native — which release records cite this node, from `vaire backlinks --type release`; cheap, meaningful, only as granular as releases exist) vs. `git` (granular, file-level — every commit that touched the file, via local `git log`/`git show`, including uncommitted working-tree changes; needs a git repo, noisier) vs. `both` (default, as two sub-sections, to compare side by side) |
| 🔀 `feat/record-templates` | **New Vairë node from template**: pick a template (package or builtin), fill its placeholders in a modal, create + open the file through the same collision checks and folder inference as `feat/new-node`; also offered from the New-node modal itself ("Use template…") | `templateSource`: `package` (only a package's own curated `templates/<type>.md`, travels with the package but nothing for an uncurated type) vs. `builtin` (the plugin's shipped presets — `record`, `decision`, `guide`, generic entity — for every declared type, always available but not owner-curated) vs. `both` (default: package template per type where curated, builtin preset for the rest, each option labeled with its source) |
| 🔀 `feat/dep-updates` | **dependency updates and store maintenance** in the package index's Updates section: **Check for updates** (`vaire pull --dry-run`, current → available per dependency, cited changes when reported, registry errors inline), **Update** (per dependency / all), **Pin**/**Unpin** (lock icon on pinned rows), **Reproduce lockfile** (`vaire pull --locked`), **Clean store…** (`vaire clean --dry-run` preview, then the real clean); a **Frozen mode** setting (`--frozen` on every call) | `updateCheck`: `manual` (never touches the network on its own) vs. `on-open` (checks once per 30 min per package when the package index opens, surfacing an "updates available" health-strip issue) — the network-and-auth-prompt cost of passive freshness vs. an explicit button. |
| 🔀 `feat/dep-graph` | **dependency graph view**: the active package's deduplicated `vaire deps` closure — name, constraint(s), resolved version, where it resolves from (working copy / linked checkout / store / unresolved), state (ok/unlinked/mismatch/error/cycle) with version-conflict flagging; click a package for its declaring parents, the CLI's note, **Open package**, and (direct dependencies only) **Link from catalog…**/**Link folder…**/**Pull** reused from the package view | `depViewLayout: 'tree' | 'graph'`: an indented, collapsible outline mirroring the CLI's own nesting (repeated subtrees collapse to a "see above" link) — exact, scannable, text-first — vs. a force-directed node-link diagram of the closure (arrows parent → dependency, unresolved dashed) — shows the shape of shared dependencies at the cost of being less scannable. Switchable from the view's own toolbar as well as Settings. |
| 🔀 `chore/smoke-test` | **plugin load smoke test** (the whole plugin loads and unloads against a fake `obsidian` runtime: no duplicate command ids or view types, settings tab renders, every cleanup runs) and the **rename self-reference fix** | hardening, single way. |

## Wave 7

| branch | feature | trade-off / what to compare |
| --- | --- | --- |
| 🔀 `feat/export-markdown` | **portable Markdown export**: "Copy node as portable Markdown" (clipboard), "Export node as portable Markdown…" (writes `<exportFolder>/<id>.md`, warns if that folder is inside a package), "Copy node citation" (`Name (type:id, package@version)`, plain text) — every `[[type:id]]` becomes a plain link or descriptor text, prefixed with an `<!-- exported from vaire: … -->` comment recording how | `exportMode`: `render` (one `vaire render` call — the CLI's exact portable form, every resolvable reference including cross-package rewritten to `[Name](path)`, loose ends degraded to plain descriptor text — but needs an up-to-date index, and a cross-package href is a machine-specific filesystem path, handled per `crossPackageLinks`: keep the relative path (rebased to the export's new location) / display text only / `Name (@pkg/type:id)`) vs. `local` (transforms the *current editor buffer* using only the vault's `LocalIndex` — instant, includes unsaved and unindexed edits, an unresolved dependency reference falls back to a name already cached from an earlier CLI resolve this session or else its bare address, never a fresh CLI call — but vault-only and not byte-identical to the CLI). Selectable per export in the export modal as well as Settings; both modes can append a "## Relations" section from the frontmatter edges (`exportEdgesSection`, default on). |
| 🔀 `feat/package-graph` | **whole-package graph**: every node of the active vault package and every edge between them, built locally and instantly (frontmatter edges + the metadata cache's own prose links, no CLI calls) on one canvas, with type-filter chips, a text filter, "Hide superseded"/"Hide orphans"/"Show dependencies" (cross-package refs as ghost nodes) toggles, degree-scaled node radius, hover-neighborhood highlight, click to open, double-click to re-center; `ForceLayout`'s repulsion gained a Barnes-Hut quadtree approximation (`src/graph/quadtree.ts`, θ = 0.9 above 150 nodes, exact below) so it stays smooth at whole-package sizes | `packageGraphLayout`: `force` (the same seeded, now Barnes-Hut-accelerated `ForceLayout` over the whole package — organic clusters and hubs, but positions carry no fixed meaning and a dense package reads as a hairball) vs. `lanes` (one deterministic vertical lane per type, ordered who/what/how/when/why/where then alphabetically, nodes sorted by degree then name within a lane — stable, meaningful positions, "where are the decisions?", but clusters are invisible and cross-lane edges pile up); both offered from the view's own toolbar as well as Settings |

## Comparing variants on `main`

Every trade-off above that merged into `main` is a setting, so variants compare without switching branches:

| setting | variants | branch that introduced it |
| --- | --- | --- |
| `livePreviewInlineNames` | inline name replaces the id / id with name suffix | `feat/lp-inline-names` |
| `prefetchMode` | per-document `refs`+`render` / per-link `resolve` (status bar shows CLI call counts) | `perf/refs-prefetch` |
| `cliTransport` | `spawn` (one `vaire` process per read call) / `mcp` (persistent per-package `vaire mcp` server for the eight read commands; status bar shows spawn vs MCP call counts and p50/p95 latency) | `perf/mcp-transport` |
| `externalRenderMode` | `vaire render` output / raw file + post processor | `feat/ext-render-mode` |
| `checkMode` | automatic after auto-index / manual | `feat/check-diagnostics` |
| `hoverPreview` | always / with modifier / off | `feat/hover-preview` |
| `relationsFooter`, `propertiesLinks`, `nodeEmbeds` | on / off | wave 1 and 3 |
| `newNodePlacement` | infer folder / pattern | `feat/new-node` |
| `explorerNames` | node name (default) / node id (`type:id`) / file name | `feat/explorer-badges` |
| `quickSwitchIncludeDependencies` | local + CLI / local only | `feat/quick-switcher` |
| `typeColorSource` | renderer / hash / off | `feat/type-colors` |
| `workbenchGrouping` | exact / fuzzy | `feat/unresolved-workbench` |
| `treeScopedLayout` | scoped nodes nested under their container / flat by type | `feat/type-tree` |
| `treeGroupBy` | type first / folder first | `feat/type-tree` |
| `tabTitles` | node name / file name / both | `feat/tab-titles` |
| `breadcrumbs` | in the node header / in the view header / off | `feat/tab-titles` |
| `queryBlockSource` (and per-block `source:`) | local index / CLI / auto | `feat/query-blocks` |
| `persistentCache` | off / stale-while-revalidate / trust until reindex | `perf/disk-cache` |
| Rename strategy (chosen per rename in the modal) | tombstone / rewrite in place | `feat/rename-id` |
| `historySource` | releases / git / both | `feat/node-history` |
| `templateSource` | package templates only / builtin presets only / both (package first, builtin fallback) | `feat/record-templates` |
| `updateCheck` | manual / on package open | `feat/dep-updates` |
| `exportMode` (also selectable per export in the export modal) | `render` (`vaire render`'s exact portable form; cross-package hrefs handled per `crossPackageLinks`) / `local` (current editor buffer via the vault index only; instant, unsaved edits included) | `feat/export-markdown` |
| `crossPackageLinks` (render mode only) | keep the relative path / display text only / `Name (@pkg/type:id)` | `feat/export-markdown` |
| `depViewLayout` | indented tree / node-link graph | `feat/dep-graph` |
| `packageGraphLayout` | force (organic, Barnes-Hut-accelerated) / lanes (deterministic, one lane per type) | `feat/package-graph` |

