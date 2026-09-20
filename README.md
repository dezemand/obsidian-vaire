# Vairë for Obsidian

Makes a vault containing one or more [Vairë](https://github.com/dezemand/vaire) knowledge
packages behave like a Vairë corpus: references render as typed links, nodes get a metadata
header, `[[` suggests existing ids, dependencies are inspectable and fixable, pages in
dependency packages open read-only, and the machine's catalog and registries are browsable.

Desktop only. Everything graph-shaped goes through the installed `vaire` CLI (`-o json`);
everything that is "which vault file has this id" is answered locally from Obsidian's
metadata cache, so the editor stays snappy.

## Requirements

- The [`vaire`](https://github.com/dezemand/vaire) CLI (0.3.x) installed. It is looked up on
  `PATH` and in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; set an explicit path in
  Settings → Vairë if it lives elsewhere.
- Obsidian 1.7.0 or newer, desktop.
- A vault that contains at least one package root (a directory with `knowledge.toml`), at
  any depth. Files outside a package are left alone.

## Build and install

Only `bun` is needed.

```sh
bun install
bun run build          # esbuild -> main.js, styles/*.css -> styles.css
bun run install:vault  # copies main.js, manifest.json, styles.css into <vault>/.obsidian/plugins/vaire
```

`install:vault` takes the vault path as its first argument, or falls back to the
`OBSIDIAN_VAULT` environment variable; with neither set it prints usage and exits non-zero
rather than guessing a path. It adds `vaire` to the vault's `community-plugins.json`. On a
vault you have never opened before, Obsidian asks you to trust community plugins the first
time; after that, reload the plugin (Settings → Community plugins) whenever you rebuild.
`bun run dev` watches and rebuilds with inline sourcemaps.

## What it does

**Rendering.** In reading mode every `[[type:id]]`, `[[container/type:local]]`,
`[[@pkg/type:id]]` and `[[?type: descriptor]]` becomes a Vairë reference: the display text is
the node's name (unless the author wrote `[[id|Display]]`), the tooltip is the full address,
and the state is visible: external refs carry a `↗` glyph, unlinked dependencies a muted
`@pkg` pill with `⊘`, missing targets a red dashed underline, loose ends a gold `? TYPE`
label. Local links hand off to Obsidian's own navigation and hover preview. Node files get a
header above their `# H1`: type / id crumb with a status dot, the address (click to copy),
scope container, tombstone banner, aliases, and every frontmatter edge as a link. Live
preview decorates the same references and shows the resolved name next to the id.

**Suggestions.** Typing `[[` inside a package offers local nodes instantly and `vaire
suggest` results (including dependency packages) after a short debounce. Picking one inserts
`[[type:id]]` (optionally with `|Name`). Commands: **Search** (hybrid search over the package
and its dependencies), **Link selection** (turn selected text into a reference), **Resolve
loose end at cursor** (rewrite `[[?person: someone]]` to `[[person:jane|someone]]`, keeping
the original wording), **Open node under cursor**.

**New Vairë node** (command *New Vairë node*, available when the active file is in a package
or the vault has exactly one): a modal for type (dropdown of the package's declared types, or
free text when none are declared; defaults to the active node's type), name, an id slug
auto-derived from the name (editable, validated, checked against the package's existing ids),
an optional scope (shown only for types listed in `knowledge.toml`'s
`scoped_types_whitelist`), and a folder — inferred from where existing nodes of that type
already live, falling back to the `{type}s` pattern setting (both strategies ship here; a
setting picks the default so you can compare them). Creates `<folder>/<id>.md` with
frontmatter and a `# Name` body, opens it, and rebuilds the index; never overwrites an
existing file. The suggestion list used by **Link selection** and **Resolve loose end at
cursor** also offers a **Create new node…** entry at the top that opens the same modal
prefilled from the descriptor (and type hint, for a loose end), then rewrites the loose end to
point at the new node exactly like picking an existing one. Command *Create entity from loose
end at cursor* jumps straight to that modal for the loose end under the cursor.

**Rename node id…** (command, and the node panel's Identity section): change a node's id
and/or type. An address *is* its identity — see the vaire-versioning skill — so the modal
previews the backlinks that will be affected (split into in-vault and dependency/other-package
rows, via `vaire backlinks`) and offers two fully-implemented strategies side by side to
compare: **tombstone** (release-safe, default) writes a new file at the same folder with the
old frontmatter (id/type changed, `updated` bumped) and the old body verbatim, and turns the
old file into a minimal redirect (`superseded_by:` set, body replaced by a one-line "Moved to"
note) — the old address keeps resolving, so nothing outside this package needs to change;
**rewrite in place** instead renames the file and changes its id/type directly (via
`fileManager.renameFile`, so Obsidian's own links follow along too) with no tombstone — the old
address disappears, which the modal calls out in red as a MAJOR change for anything outside
this package, listing the backlinks that will dangle. Either way, in-vault references in this
package can be rewritten to the new id (optional and on by default for the tombstone strategy,
since the redirect makes it purely cosmetic; unconditional for rewrite-in-place, since there is
no redirect to fall back on). Rebuilds the index and opens the renamed/new node afterward.
**New Vairë node from template** (command *New Vairë node from template…*, or "Use
template…" in the New-node modal above): pick a template — a package's own
`templates/<type>.md` file, or one of the plugin's builtin presets (`record`, `decision`,
`guide`, and a generic entity) — fill in its placeholders in a modal (name, id, scope and
folder work exactly like the plain New-node modal; any other placeholder the template
declares becomes an extra text field), then create and open the file through the same
collision checks, folder inference and index rebuild. The **Template source** setting
(`package` / `builtin` / `both`, default `both`) controls the trade-off: `package` only
offers a type the package has curated a template for (so the picker is exactly what the
package owner wrote, travels with the package, but a type with no template file isn't
offered at all); `builtin` ignores package templates entirely and offers a preset for every
declared type; `both` prefers the package's own template per type and falls back to a
builtin preset for the rest, labeling each option with its source. **Template folder**
(default `templates`) is the package-relative folder templates live in. A template's
placeholders follow whatever convention the file itself uses — bare `<placeholder>` (the
convention real Vairë packages use: `<yyyy-mm-dd>` always means today's
date, the token used as the whole `name:` value means the node's name wherever it recurs, a
bare `<slug>` outside any field means this node's own id, and any other `<...>` inside a
live field becomes a prompt keyed by that field) as well as the plugin's own `{{id}}`,
`{{name}}`, `{{type}}`, `{{scope}}`, `{{date}}`, `{{today}}`, `{{package}}`, `{{descriptor}}`
(set when the template was opened from a loose end) and free `{{field:Label}}` prompts,
which the builtin presets use. Comments (` # ...`) are never scanned or touched, so a
template's own guidance about optional/example fields survives untouched in the created
file.

**Package index** (command *Open package index*, or the ribbon icon): name, version,
description, index status with **Rebuild index** and **Check**, the package README,
contents grouped by type, the dependency tree with per-dependency actions (**Link from
catalog**, **Link folder**, **Pull**), unresolved loose ends, and check findings, all
clickable.

**Dependency updates and store maintenance** (Updates section of the package index; command
*Check for dependency updates*): **Check for updates** runs `vaire pull --dry-run` and shows
each dependency's current version next to what the registry would fetch, cited changes when the
dry run reports them, and any per-dependency or registry error inline (never a crash — a 403 or
an unreachable registry shows its message next to the dependency it affects). **Update** (per
dependency, after confirmation, or **Update all**) runs the real pull and rebuilds the index.
**Pin**/**Unpin** hold a dependency at its currently-resolved version (`vaire pin
<name>@<version>` / `vaire unpin <name>`); pinned rows show a lock icon, read from
`knowledge.lock` when it exposes pin state and otherwise from what this plugin itself pinned
(noted as such). **Reproduce lockfile** (command *Reproduce lockfile (vaire pull --locked)*)
fetches exactly what `knowledge.lock` records, verified against its checksums. **Clean store…**
previews what `vaire clean --dry-run` would remove (and the space it would free, when reported)
before running the real clean. A **Frozen mode** setting adds `--frozen` to every call (answers
only from the store; a dependency resolving to a working copy is refused). An **update check**
setting controls whether opening a package ever checks for updates on its own: *manual*
(default) never does; *on package open* runs the same dry-run check (cached in memory for 30
minutes per package) and adds an "updates available" line to the health strip — at the cost of a
real network round trip, and possibly a registry auth prompt, each time the cache goes stale.

**Node panel** (command *Open node panel*, right sidebar): identity, edges, references →,
backlinks ← (from `vaire backlinks`), history, supersedes, loose ends and findings for the
active file.

**History** (below Backlinks in the node panel; command *Show node history* opens the panel
and scrolls to it): "how has this node changed?", from up to two sources picked by the
**Node history source** setting (default *both*, shown as two sub-sections). **Releases**:
which release records cite this node — `vaire backlinks <id> --type release`, one row per
release with its version, bump, whether the node was added/changed/retired, and its date;
falls back to scanning the package's own `release`-typed nodes locally if the CLI call
fails. **Git**: every commit that touched the file, via `git log --follow` on the package's
directory (short hash, author, relative date, subject; a working-tree change not yet
committed shows as its own row from `git status --porcelain`); click a commit to see its
stat summary and diff for just this file in a modal. Needs the package to sit inside a git
repository — a muted notice explains when it doesn't.

**Dependency graph** (command *Open dependency view*, or the package index's **Open graph**
button): the active package's whole resolved dependency closure from `vaire deps`, one row per
package name however many parents declare it — constraint(s), resolved version, where it
resolves from (working copy in the vault, linked checkout, store, or unresolved) and its state
(`ok`/`unlinked`/`mismatch`/`error`, plus `cycle` when the CLI marks one), with a version
conflict flagged if the same name resolved to more than one version anywhere in the closure.
Two layouts, switchable from the view's own toolbar or the **Dependency view layout** setting
(default **tree**): an indented, collapsible outline mirroring `vaire deps`' own nesting
(a package already shown once collapses to a "see above" link the next time it's reached), or a
force-directed node-link diagram of the deduplicated closure (arrows point parent → dependency,
unresolved nodes dashed) — trading exact, scannable text for a picture of the shape of shared
dependencies. Clicking a package opens a side panel with its declaring parents, the CLI's note
(if any, e.g. "run `vaire add acme-org --link <path>`"), an **Open package** button (a vault
package opens its package index; a store/linked package opens its README read-only, or the
catalog browser if it has none), and — only for the active package's own direct dependencies,
since `vaire add`/`vaire pull` only ever link into the run root — **Link from catalog…**,
**Link folder…** and **Pull**; a transitive dependency's panel instead names which package(s)
must declare/link it.

**Query blocks.** A fenced ` ```vaire ` code block renders as a live, Dataview-like view over
the graph — a list or table of matching nodes (each name a normal Vairë link), with a muted
footer reporting the match count, the source that answered it, and how long it took. One
clause per line, all combined with AND:

```
type: decision
where: status = active
backlinks-to: concept:reference
refs-from: this
search: "event sourcing"
unresolved: true
sort: name | updated desc
limit: 20
show: table
columns: name, type, status, updated, owner
source: local
```

`this` (in `backlinks-to`/`refs-from`) means the node the block is written in. `where:` (any
number of lines) supports `key = value`, `key != value`, `key exists` and `key contains
value` over frontmatter — list values match any element, reference values compare by full
id. `source: local | cli | auto` (default from the **Query block source** setting, `auto`)
picks the backend per block: `local` answers instantly from the vault index and re-renders on
every metadata change, but only sees vault packages and its `search` is a plain name/alias
substring; `cli` uses `vaire`'s real backlinks/refs/search/unresolved (ranked hybrid search,
dependencies included) and re-renders only after an index rebuild; `auto` uses `local` for a
plain type/where/sort block and switches to `cli` as soon as `search`, `refs-from`,
`backlinks-to` or `unresolved` is used. Put two blocks with the same query side by side, one
pinned to each source, to compare results and latency directly. A block with a bad line
renders the list of parse errors instead of a query.

**External pages.** A reference into a dependency opens a read-only view rendered from the
dependency's files on disk (store or linked checkout), with the same header and link
behavior, a back stack, and a banner naming the package and version. If the dependency's
index is missing, the view offers to build it.

**Catalog and registries** (command *Open catalog and registries*): every package the
machine knows (`vaire catalog list`) with **Browse** (type counts plus search, results open
read-only), **Scan folder…**, **Add current package**, **Forget**; the configured registries
with **Show**, **Add registry…**, **Remove**, and **Add as dependency and pull** for a
package a registry lists.

**Portable Markdown export.** Vairë files are full of `[[type:id]]` links that mean nothing
outside a Vairë-aware tool; three commands turn a node into plain, portable Markdown. **Copy
node as portable Markdown** copies the active node to the clipboard using the current **Export
mode** setting. **Export node as portable Markdown…** opens a modal to pick the mode (and, for
render mode, the cross-package link handling) for *this* export, then writes
`<export folder>/<id>.md` (default `Vairë exports`; a Notice warns, but still writes, if that
folder resolves inside a package). **Copy node citation** copies one line — `Name (type:id,
package@version)` — as plain text. Every export starts with a comment recording how and when it
was made: `<!-- exported from vaire: <id> via render|local on <date> -->`. Two modes, the same
trade-off `feat/export-markdown` was built to compare: **render** (default) asks `vaire render`
for the node's exact portable form — frontmatter kept, every resolvable reference (including
cross-package) rewritten to a plain `[Name](path)` link, loose ends degraded to their plain
descriptor text — but needs an up-to-date index (an uncommitted edit that isn't indexed yet is
missing), and a cross-package href is a real, machine-specific filesystem path, handled per the
**Cross-package links** setting: keep the relative path (rebased to still resolve from the
export's new location), keep only the display text, or replace it with `Name (@pkg/type:id)`
(default). **local** transforms the *current editor buffer* — so unsaved and unindexed edits are
included — using only this vault's index: `[[type:id]]`/`[[type:id|X]]` become
`[X or Name](relative/path.md)`, a dependency reference not also open in this vault becomes
`Name (@pkg/type:id)` when a name is already cached from an earlier CLI resolve this session
(never a fresh call — local mode is instant) else the bare address, and a loose end degrades to
its descriptor text with an "(unresolved)" marker. It's vault-only and not byte-identical to the
CLI, but instant. Both modes can append a "## Relations" list — the frontmatter edges, each
value resolved exactly like a body reference — at the end (**Export: Relations section**
setting, default on).

**Toggle type labels** (command) switches every type label on or off at once.

**Maintenance commands**: Rebuild index (working tree / full), Run check, Copy this node's
id. With *auto-index on save* (default on) the working-tree index is rebuilt a few seconds
after you stop editing, so links and backlinks stay fresh.

**Package graph** (command *Open package graph*, or the **Graph** button in the package
index header): every node of one package and every edge between them, drawn on a single
canvas — built entirely locally (frontmatter edges + the metadata cache's own prose links,
the same source the References→ section uses) and instantly, no CLI calls, smooth on
`packages/vaire`-sized packages (~160 nodes, ~2800 edges) and larger. Toolbar: **Force**/
**Lanes** layout toggle (see below), **Show dependencies** (cross-package references as
muted dashed "ghost" nodes, default off), **Hide superseded** (default on), **Hide
orphans** (default off), colored type-filter chips (click to toggle a type on/off), a text
filter (matches stay full-opacity, everything else dims), a node/edge count, **Fit** (frame
everything) and **Reset** (re-run the layout from scratch and reframe). Node radius scales
with degree (sqrt, so a few hubs don't dwarf everything). Hovering a node highlights its
directly-connected neighborhood and dims the rest; clicking opens it (Cmd/Ctrl for a new
leaf); double-clicking re-centers the view on it instead of opening it. Two layouts, picked
by the **Package graph layout** setting (default `force`, switchable per session from the
toolbar): `force` runs the same seeded `ForceLayout` the local graph uses — now Barnes-Hut
accelerated (θ = 0.9) above 150 nodes so it stays smooth at real package sizes — over the
whole package, which shows organic clusters and hubs but whose positions carry no fixed
meaning (a large package reads as a hairball); `lanes` places one deterministic vertical
lane per type (ordered who/what/how/when/why/where per the type-colors family table, then
alphabetically; nodes within a lane sorted by degree then name), which makes positions
stable and meaningful ("where are the decisions?") at the cost of hiding clusters and
piling up cross-lane edges.

## Settings

| setting | default | meaning |
| --- | --- | --- |
| vaire binary path | auto | explicit path to the CLI; the detected path and version are shown |
| auto-index on save | on | `vaire index --working-tree` after edits, debounced |
| auto-index delay | 2500 ms | the debounce |
| suggest from every catalog package | off | passes `--all` to `vaire suggest` |
| insert display text | off | insert `[[id|Name]]` instead of `[[id]]` |
| suggestion limit | 10 | `--limit` for `vaire suggest` |
| new node folder placement | infer | `infer` uses the most common folder among existing nodes of the chosen type, falling back to the pattern below when there are none; `pattern` always uses it |
| new node folder pattern | `{type}s` | folder for a new node when placement is `pattern`, or `infer` has nothing to infer from; `{type}` is substituted |
| persistent cache (`perf/disk-cache`) | off | `off` / `stale-while-revalidate` / `trust-until-reindex` — see Caveats |
| node history source | both | node panel History section: `releases` (from `vaire backlinks --type release`), `git` (from the local `git log`), or `both` as two sub-sections |
| template source | both | where "New Vairë node from template…" gets its templates: `package` (a package's own `templates/<type>.md` files only), `builtin` (the plugin's shipped presets only), or `both` (package first, builtin for the rest) |
| template folder | `templates` | package-relative folder holding `<type>.md` template files |
| frozen mode | off | adds `--frozen` to every `vaire` call — store-only answers, working-copy dependencies refused |
| dependency update check | manual | `manual`: never checks for updates on its own; `on-open`: also checks (cached 30 min/package) when a package index opens, at the cost of a network round trip (and possibly a registry auth prompt) per stale cache |
| dependency view layout | tree | `tree` (indented, collapsible outline) or `graph` (force-directed diagram) for the dependency graph view; its own toolbar can switch this per session |
| export mode | render | portable Markdown export: `render` (`vaire render`, exact but needs an up-to-date index) or `local` (current editor buffer, instant, vault-only) — see Portable Markdown export |
| cross-package links in exports | address | render mode only: `path` (rebased relative link), `text` (display text only), or `address` (`Name (@pkg/type:id)`) |
| export folder | `Vairë exports` | where "Export node as portable Markdown…" writes `<id>.md` files |
| export: Relations section | on | append a "## Relations" list (frontmatter edges) at the end of every export |
| package graph layout | force | default layout for the whole-package graph view: `force` (organic, seeded/Barnes-Hut-accelerated force layout) or `lanes` (deterministic, one vertical lane per type); its own toolbar can switch this per session |
| file explorer names | node name | what the file explorer shows for a node: its name, its `type:id`, or the file name; hovering shows the file name |
| type labels on links | on | the small type label (e.g. `CONCEPT`) before every Vairë link |
| type labels in the file explorer | on | the type after each node in the file explorer, `pkg` on package roots |
| type labels in tab titles | on | the type next to a node's name in tab headers |

## Caveats

- `vaire status`, `check` and `index` run the CLI's dependency ensure pass and may rewrite
  `knowledge.lock`; that is the CLI's documented behavior, not the plugin's.
- `vaire pull`'s JSON output is not specified by the CLI (DESIGN.md's "CLI contract nuances"
  calls it opaque); `src/updates/pure.ts`'s parser is tolerant of the shape the 0.3.2 binary
  actually prints (captured in `tests/fixtures/`) and falls back to a raw-JSON view for
  anything it doesn't recognize — the same goes for `vaire clean`'s output and for whether
  `knowledge.lock` exposes pin state (its field name isn't documented either; see the Pin/Unpin
  paragraph above).
- There is no registry-wide search in vaire 0.3; **Show** displays what a registry answers.
- Diagrams are left to Obsidian; `vaire/…` shape links inside diagrams are not resolved.
- `perf/disk-cache`: with *Persistent cache* set to anything other than **Off** (Settings →
  Vairë), resolve results and backlink lists are saved to
  `<vault>/.obsidian/plugins/vaire/cache.json` so a restart can render external/cross-package
  links instantly instead of re-spawning `vaire` for the first view of every page — at the
  cost of possibly showing a **stale name or backlink list** until it's revalidated. Under
  *Stale while revalidate* that happens automatically in the background and the affected
  reference redraws itself once the real value comes back; under *Trust until reindex* it
  doesn't happen at all until that package's index changes (a reindex, `vaire index --full`,
  ...) — so a rename that only touches the *referenced* node's frontmatter (not its own index
  entry's neighbors) can look stale in a *referencing* package for longer than you'd expect.
  Deleting `cache.json` (or switching the setting to Off and back) clears it. The status bar's
  tooltip shows live hit/miss/revalidation counts so the two modes — and a cold vs. warm
  start — can be compared directly.

## Development

- `bun run build` / `bun run dev` — production and watch builds.
- `bun run typecheck` — `tsc -noEmit`.
- `bun test` — unit tests for the pure parts (reference grammar, CLI adapter with a fake
  spawner, dependency flattening, suggestion helpers, view helpers), all runnable with no
  setup beyond `bun install`.
- `DESIGN.md` is the design brief and the verified CLI contract the code follows.

### Running the tests

Most of the suite is pure unit tests against fixtures checked into `tests/fixtures/` and needs
nothing else. A handful of tests exercise real integration points — the `vaire` binary, `git`,
and a real package's on-disk index/renderer config — and are skipped unless you point them at
a real Vairë package checkout:

```sh
VAIRE_TEST_REPO=/absolute/path/to/a/vaire/package/root bun test
```

`VAIRE_TEST_REPO` must be a package root (a directory with `knowledge.toml`). Tests that use
it (`tests/*.integration.test.ts`, `tests/families.test.ts`, `tests/views-ext.test.ts`,
`tests/prefetch.test.ts`) are individually gated with `test.skipIf`/`describe.skipIf`, so
`bun test` always passes whether or not the variable is set — with it unset, those specific
tests just don't run. The `cli`/`mcp` integration tests additionally need the `vaire` binary
on `PATH`, and the `history` integration test needs `git`; each is skipped independently when
its own prerequisite is missing.
