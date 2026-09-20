# Vairë for Obsidian — design brief

Desktop-only Obsidian plugin that makes a vault containing one or more Vairë knowledge
packages behave like a Vairë corpus: references render as typed links, nodes get a metadata
header, `[[` suggests existing IDs, dependencies are inspectable and fixable, pages in
dependency packages open read-only, and the machine's catalog and registries are browsable.

Everything graph-shaped goes through the installed `vaire` CLI (`-o json`). Everything that
is "which vault file has this id" is answered locally from Obsidian's metadata cache, so the
editor stays snappy.

Non-goals (for now): mobile, editing dependency packages, MCP, backwards compatibility with
older Obsidian or vaire versions. Keep it simple. Ship, then polish.

## Toolchain

- `bun` only (no node/npm on this machine). `bun install`, `bun run build` (esbuild →
  `main.js`, cjs, target es2018, externals `obsidian`, `electron`, `@codemirror/*`,
  `@lezer/*`, node builtins), `bun test` for unit tests, `bun run install:vault` copies
  `main.js manifest.json styles.css` into `<vault>/.obsidian/plugins/vaire/`.
- Obsidian 1.13.x (`obsidian` typings 1.13.1). `manifest.json`: id `vaire`, name `Vairë`,
  `isDesktopOnly: true`, `minAppVersion: "1.7.0"`.
- Test vault: developed against a local vault with several packages side by side, not a git
  repo itself (the packages inside it are). One package (this project's own `vaire` package)
  is indexed with a working tree and no dependencies; another has dependencies linked through
  `.vaire/packages/<name>` symlinks into `~/.vaire/store` plus several *unlinked* ones. None
  of that vault ships with this repo — see README.md "Running the tests" for
  `VAIRE_TEST_REPO`, the environment variable the integration-shaped tests read a real
  package's path from (individually `test.skipIf`/`describe.skipIf`-gated, so `bun test`
  passes with or without it set).

## Vault model

- A **package root** is a directory containing `knowledge.toml`. A vault may contain zero
  or more, at any depth. `PackageRegistry` (src/packages.ts) discovers them from
  `vault.getFiles()` (name === `knowledge.toml`) and keeps them fresh on `create` /
  `delete` / `rename`.
- **A file belongs to the nearest ancestor package root.** Files outside any package are
  ignored by every feature. Every CLI call passes `--repo <absolute package root>`.
- Absolute path of a vault file: `(app.vault.adapter as FileSystemAdapter).getBasePath()`
  joined with `file.path`.

## Reference grammar (src/ids.ts) — pure, unit-tested

Obsidian never allows `:` in note names, so any wikilink target containing `:` is a Vairë
reference. Parse the target text of `[[…]]` (before any `|display`):

| form | parsed |
| --- | --- |
| `type:id` | `{kind:'id', type, id, full:'type:id'}` |
| `container-id/type:local` (scoped; container itself is `ctype:cid`) | `{kind:'id', scope:'ctype:cid', type, id:'local', full:'ctype:cid/type:local'}` |
| `@pkg/type:id`, `@pkg/ctype:cid/type:local` | as above plus `pkg:'pkg'`, `full` keeps the `@pkg/` prefix |
| `?type: descriptor`, `?: descriptor` | `{kind:'loose', typeHint?:'type', descriptor}` |
| anything else | `null` (ordinary Obsidian link, leave alone) |

`display` (after `|`) is carried alongside. Type and id slugs are `[a-z0-9][a-z0-9-]*`;
package names likewise. Be lenient on whitespace around the loose-end descriptor.

Also expose `extractFrontmatterEdges(frontmatter)`: every top-level key whose value (or
list items) parses as a Vairë id or loose end (loose ends in frontmatter are strings
starting with `?`), excluding the bookkeeping keys `id`, `type`, `name`, `aliases`,
`scope`, `updated`, `since`, `superseded_by` (`superseded_by` is surfaced separately).

## CLI adapter (src/cli.ts)

```ts
class VaireCli {
  constructor(getSettings: () => VaireSettings)
  binary(): string          // settings.binaryPath || auto-detect
  run<T>(args: string[], opts?: { repo?: string; cwd?: string; timeoutMs?: number }): Promise<T>
  // typed wrappers, all return the parsed JSON shapes in src/types.ts:
  resolve(repo, id) / render(repo, id) / backlinks(repo, id) / refs(repo, id, depth?)
  search(repo, query, {limit?, type?, all?, local?}) / suggest(repo, descriptor, {limit?, type?, all?, local?})
  unresolved(repo) / deps(repo) / status(repo) / check(repo, {workingTree?, strict?})
  index(repo, {workingTree?, full?}) / add(repo, name, {link?}) / pull(repo, name?, {registry?, dryRun?})
  catalogList() / catalogAdd(path) / catalogRm(nameOrPath) / catalogScan(dir)
  registryList() / registryShow(name) / registryAdd(name, url) / registryRm(name)
}
```

- Spawn with `child_process.execFile(binary, ['-o','json','--no-color','-q', ...args])`,
  `maxBuffer: 64 MiB`, cwd = repo when given. Never use a shell.
- **GUI apps on macOS have a minimal PATH.** Auto-detect: if `settings.binaryPath` is set
  use it; else try `vaire` on PATH, then `~/.local/bin/vaire`, `/opt/homebrew/bin/vaire`,
  `/usr/local/bin/vaire`. Also prepend those dirs to `PATH` in the child env. Cache the
  detected path; expose `cli.available(): Promise<boolean>` and a version check
  (`vaire --version`).
- Errors: non-zero exit with stdout `{"error":{"code","kind","message"}}` → throw
  `VaireError { code, kind, message }`. Known kinds include `no_repo`, `index_not_built`,
  `id_not_found`, `registry`, `dependency`. Exit code 4 = repo/index problem, 5 = not
  found. If stdout is not JSON, throw `VaireError` with kind `spawn` and stderr as message.
- `vaire` may print progress on stderr even with `-q`; ignore stderr on success.
- Concurrency: at most 4 in flight; queue the rest. Read calls that are identical and in
  flight share one promise.

## JSON shapes (src/types.ts) — from the 0.3.2 binary

```jsonc
// resolve <id>            (path is relative to the package that owns the node;
//                          `package` is present only for nodes in a dependency)
{"id":"concept:reference","type":"concept","path":"concepts/reference.md",
 "package":"acme-security"?, "frontmatter":{...}, "superseded_by":null|"type:id"}
// render <id>
{"id":"…","path":"…","markdown":"---\n…frontmatter…\n---\n# …body with links as [Name](./rel.md)"}
// backlinks <id>
{"id":"…","backlinks":[{"id":"…","type":"…","path":"…","package"?:"…","ref_type":"inline"|"<frontmatter-key>","line":154}]}
// refs <id>
{"id":"…","depth":1,"refs":[{"id":"…","type":"…","path":"…","ref_type":"…","line":66,"distance":1}]}
// search <query>          (score desc; anchors give heading/line/snippet)
{"query":"…","results":[{"id":"…","type":"…","path":"…","package"?:"…","score":0.27,
  "anchors":[{"heading":"","line":9,"snippet":"…"}]}]}
// suggest <descriptor>    (names included — ids are the thing to insert)
{"descriptor":"…","suggestions":[{"id":"…","type":"…","name":"…","path":"…","package"?:"…","score":2.5}],"count":5}
// unresolved
{"unresolved":[{"record":"decision:x","path":"decisions/x.md","type_guess":"document"|null,"descriptor":"…","line":7}],"count":1}
// deps                    (resolved is relative to the package dir; a dep that cannot be
//                          located has `note` and no version/resolved)
{"name":"acme-platform","version":"1.1.0","dependencies":[
  {"name":"acme-security","constraint":"^1","version":"1.2.0","resolved":"../../../../.vaire/store/acme-security/1.2.0","satisfied":true,"dependencies":[…]},
  {"name":"acme-org","constraint":"^1","note":"dependency error: dependency 'acme-org' (declared by 'acme-platform') is not linked — run `vaire add acme-org --link <path>` in acme-platform"}]}
// status
{"repo":"/abs","index_path":".vaire/index.db","schema_version":7|null,"source":"working-tree"|"committed"|null,
 "last_indexed_commit":"sha"|null,"commits_behind_head":0,"nodes":{"total":160,"by_type":{"concept":30}},
 "edges":2807,"embeddings":{"sections":812,"cached":812},"embed_provider":"…",
 "pending_release":{"since":"v0.3.0","would_be":"none"|"patch"|"minor"|"major","added":0,"changed":0,"retired":0,"removed":0}}
// check
{"ok":true,"violations":[{"kind":"dangling_ref","id":"…","to":"…","path":"…","line":18}],
 "warnings":[{"kind":"drift","id":"…","to":"…","path":"…","line":18}]}
// catalog list
{"catalog":"~/.vaire/catalog.db","sightings":[{"path":"/abs","name":"vaire","version":"0.3.0","state":"live"|"missing","origin":"ambient"|"explicit","last_seen":1789504443}]}
// registry list
{"catalog":"…","registries":[{"name":"acme","url":"https://…","kind":"static","priority":0,"search_by_default":true}]}
// registry show <name>   → see scratchpad cli-contract.md; unreachable → error kind "registry"
// error envelope
{"error":{"code":5,"kind":"id_not_found","message":"no node with id 'concept:nope'"}}
```

Flags that matter: `suggest`/`search` take `--type`, `--limit`, `--local`, `--all`
(`--all` = every package in the catalog); `search --scope <container>`; `backlinks
--type/--limit`; `refs --depth`; `unresolved --all-packages`; `index --working-tree |
--full`; `check --strict | --working-tree`; `add <name> [--link <path>]`; `pull [name]
[--registry r] [--dry-run]`.

The dependency root for package `pkg` seen from package root `R`: the realpath of
`R/.vaire/packages/pkg` if it exists, else `R` joined with the `resolved` field from `deps`
(first occurrence, depth-first), else the catalog sighting with that name and
`state: "live"`. `DepsModel.rootOf(pkg)` in src/deps.ts implements exactly this order.

## Local index (src/packages.ts)

For each package root, `LocalIndex` maps the full id → `{ file: TFile, type, id, scope?,
name, aliases[] }`, built from `metadataCache.getFileCache(file).frontmatter` for every
markdown file under the root (`id` + `type` present ⇒ node; `scope: container` ⇒ full id is
`container/type:id`). Display name: `frontmatter.name` → first level-1 heading → file
basename. Rebuild the entry on `metadataCache.on('changed')`, drop on delete, move on
rename. Also expose `nodesByType()` and `all()` for the package view, and `findByAlias`.

Local lookups never touch the CLI. The CLI is used for: anything `@pkg/…`, suggest,
search, backlinks, unresolved, deps, status, check, index, add, pull, catalog, registry.

## Features

### 1. Rendering (src/render/)

**Reading mode** (`registerMarkdownPostProcessor`): for every `a.internal-link` in the
rendered section whose `data-href` parses as a Vairë ref:

- id refs: add classes `vaire-link vaire-type-<type>` (+ `vaire-link-external` for `@pkg`,
  `vaire-link-missing` when unresolvable), `data-vaire-ref="<full id>"`. If the link had
  no `|display`, replace the text with the node's display name. Tooltip (`title` /
  `aria-label`): `type:id · Name` (+ ` · @pkg`). Local nodes: set `data-href` and `href` to
  the vault path of the target file so Obsidian's own click + hover preview work. External
  nodes: intercept click → open in the external read-only view (§4). Missing: keep text,
  intercept click → Notice "not found".
- loose ends: replace the anchor with `<span class="vaire-loose-end" data-vaire-descriptor
  data-vaire-type-hint>` showing `?type: descriptor` verbatim, tooltip "Unresolved
  reference — click to resolve"; click → the resolve-loose-end flow (§2).
- Resolution order: `LocalIndex` (same package) → for `@pkg` refs `cli.resolve(repo, id)`
  (memoized per repo+id, cleared on index rebuild) → missing.
- The section's package root comes from `ctx.sourcePath`, or, when rendering inside the
  external view, from the nearest ancestor element with `data-vaire-repo`.

**Node header** (same post processor): when the section contains an `h1` and the file is
a node, insert `div.vaire-node-header` before the `h1`: type badge, `type:id` (click
copies), aliases as chips, `updated`/`since` if present, a `superseded_by` banner with a
link when set, then one row per frontmatter edge (key → resolved links, loose ends styled
as above). Obsidian's Properties panel still shows raw values; that's fine.

**Live preview** (`registerEditorExtension`): a ViewPlugin that finds `[[…]]` in the
visible ranges whose target parses as a Vairë ref and adds a mark decoration with class
`vaire-lp-link vaire-type-<t>` / `vaire-lp-loose` and attribute `data-vaire-name` (the
resolved display name, from LocalIndex only). CSS shows the name as a subtle suffix
(`::after { content: attr(data-vaire-name) }`) when the cursor is not on the line.

**Click interception**: one capture-phase `click` listener on `document` (registered with
`plugin.registerDomEvent`). If the target is a `.cm-hmd-internal-link`/`.cm-underline` in
live preview or an `a.internal-link` in reading mode whose href parses as a Vairë ref, and
the ref is not a local node already rewritten to a vault path: preventDefault +
stopPropagation and route through `openRef(ref, fromRepo)` (src/navigate.ts). This is what
stops Obsidian from creating a new note named `type:id`.

`openRef(ref, repo, { newLeaf? })`: local → `workspace.getLeaf(newLeaf).openFile(file)`;
external → external view; loose → resolve flow; missing → Notice.

### 2. Suggestions (src/suggest/)

- `VaireLinkSuggest extends EditorSuggest<Candidate>` registered via
  `registerEditorSuggest`. `onTrigger`: only in files inside a package; the text before the
  cursor on the line matches `/\[\[([^\[\]|]*)$/`; the query must not start with `?`
  (loose ends are typed by hand). `getSuggestions` (async): instant local matches from
  `LocalIndex` (prefix/substring on id, name, aliases; up to 8) merged with `cli.suggest
  (repo, query, {limit: settings.suggestLimit, all: settings.suggestAll})` (debounced
  250 ms; ignore stale responses), deduped by id, local first. Empty query → local nodes
  sorted by name (first 20). `renderSuggestion`: name (bold), `type:id`, package badge for
  external. `selectSuggestion`: replace the range `[[<query>` with `[[<id>` (+ `|<name>` when
  `settings.insertDisplayText`) and add `]]` unless the two chars after the cursor already
  are `]]`.
- `SearchModal extends SuggestModal<SearchResult>` (command "Vairë: search"): async over
  `cli.search(repo, q, {limit: 20})`; each row shows name-or-id, type, package, first anchor
  snippet; Enter → `openRef`. Shift+Enter → new leaf.
- Resolve a loose end: command "Vairë: resolve loose end at cursor" and the click on a
  rendered loose end. Finds the `[[?…]]` under the cursor (or the one clicked, located by
  descriptor text + line), opens a `SuggestModal` prefilled with the descriptor (type
  filter = the hint when present), and on pick rewrites that single occurrence to
  `[[<id>|<descriptor>]]` — additive resolution, original wording preserved.
- Command "Vairë: link selection": with a selection, open the same modal with the selected
  text as descriptor; on pick replace the selection with `[[<id>|<selection>]]`.

### 3. Dependencies (src/deps.ts + package view)

`DepsModel.load(repo)` runs `cli.deps` and flattens the tree into rows `{name, constraint,
version?, resolved?, absRoot?, satisfied, note?, depth, parent}`. `rootOf(pkg)` per the
order above. State per row: `ok` (satisfied), `unlinked` (note contains "not linked"),
`mismatch` (satisfied false with a version), `error` (other note).

Actions (buttons in the package view, each followed by reload + Notice):
- **Link from catalog…**: `cli.catalogList()` filtered by name and `state: live` → pick →
  `cli.add(repo, name, {link: path})`.
- **Link folder…**: prompt modal for an absolute path → `cli.add(repo, name, {link})`.
- **Pull**: `cli.pull(repo, name)`; on registry errors show the message.
- **Rebuild index** (`cli.index(repo, {workingTree: true})`) after any of the above.

### 4. External read-only pages (src/views/external-view.ts)

`ExternalNodeView extends ItemView` (type `vaire-external`), opened in the main area.
State: `{ repo: absRoot of the owning package, id, pkg, version? }`. On set state:
`cli.resolve(repo, id)` (repo is the dependency's root, so pass the *unprefixed* id), read
`<repo>/<path>` from disk with `fs`, strip frontmatter, render a header (package name +
version, `type:id`, name, aliases, edges) and the body with `MarkdownRenderer.render(app,
body, el, '', this)`. Wrap the content in an element with `data-vaire-repo="<repo>"` so the
reading-mode post processor resolves links against that package (local ids there resolve via
`cli.resolve(repo, id)` since there is no LocalIndex for a non-vault root; memoize). Links
navigate within the same view (keep a small back stack; a "Back" button). Show a "Read-only ·
@pkg 1.2.0" banner. Also used to open any node of any catalog package (catalog view §5).
Display text: `getDisplayText()` = name.

### 5. Catalog and registries (src/views/catalog-view.ts)

`CatalogView extends ItemView` (type `vaire-catalog`), main area, two sections:

- **Catalog** (`cli.catalogList()`): table name · version · state · origin · path ·
  last seen. Row actions: **Browse** (opens a `PackageBrowser` pane: `cli.status(root)`
  by-type counts, a search box over `cli.search(root, q, {local:true})`, results open in the
  external view; for vault packages just open the package view), **Forget** (`catalog rm`).
  Header actions: **Scan folder…** (prompt → `catalog scan`), **Add current package**.
- **Registries** (`cli.registryList()`): table name · url · kind · priority · search by
  default. Row actions: **Show** (`registry show` → render what it returns: packages and
  versions; unreachable → inline error), **Remove**. Header: **Add registry…** (name + url
  or directory). For a package listed by a registry, when the active file's package exists:
  **Add as dependency** = `cli.add(repo, name)` then `cli.pull(repo, name)` then reindex.

### 6. Package view and node panel

- `PackageView extends ItemView` (type `vaire-package`, main area; command "Vairë: open
  package index"): header (name, version, description from `knowledge.toml` — parse with
  `smol-toml`), index status line from `cli.status` (source, nodes, edges, pending release
  summary; button **Rebuild index**, button **Check**), **Types** (from `knowledge.toml
  types` + counts) filtering a **Nodes** table (from `LocalIndex`: name, `type:id`, file;
  text filter; click opens the file; scoped nodes grouped under their container),
  **Dependencies** (§3), **Unresolved** (`cli.unresolved` list: descriptor, record, line;
  click opens the file at the line), **Check findings** (after Check: kind, id, to, path,
  line; click opens the file at the line).
- `NodeView extends ItemView` (type `vaire-node`, right sidebar; command "Vairë: open node
  panel"): follows the active file. Identity (type badge, full id, name, aliases, updated,
  superseded_by), **Edges** (frontmatter edges resolved to links), **Backlinks**
  (`cli.backlinks`, grouped by type, each with ref_type and line), **Loose ends in this
  file** (from `cli.unresolved` filtered by path), **Findings for this file** (last check).
  Refresh on `file-open` and after index rebuild.

### 7. Commands, settings, lifecycle (src/main.ts, src/settings.ts)

Commands: open package index; open node panel; open catalog & registries; search; link
selection; resolve loose end at cursor; rebuild index (working tree); rebuild index (full);
check; open node under cursor; copy this node's id.

Settings tab: binary path (text; empty = auto; shows detected path and version), auto-index
on save (toggle, default on) + delay ms (default 2500), suggest from every catalog package
(`--all`, default off), insert display text on link insert (default off), suggestion limit
(default 10).

Auto-index: on `vault.on('modify')` of a markdown file inside a package, debounce per
package → `cli.index(root, {workingTree:true})`; on success clear resolve memos and emit
`plugin.events.trigger('index-rebuilt', root)` so views refresh; on failure a Notice with
the message (once per distinct message).

On load: detect the binary; if missing, a persistent Notice with the install hint and a
settings link, and every CLI-backed feature degrades (rendering still works from
LocalIndex). Never block `onload` on the CLI.

## Styling (styles.css)

Use Obsidian CSS variables only. `.vaire-link` inherits link styling plus a small type
prefix badge (`::before { content: attr(data-vaire-type) }`, uppercase, muted, 0.7em).
`.vaire-link-external` gets a dotted underline; `.vaire-link-missing` uses
`--text-error`; `.vaire-loose-end` uses `--text-warning` with a dashed underline. Header,
tables and badges are plain flex/grid with `--background-secondary` and
`--background-modifier-border`. No global element selectors.

## Tests

- `bun test` unit tests under `tests/`: ids (every grammar row above, plus `|display`,
  whitespace, rejections), frontmatter edge extraction, `VaireCli` argument building and
  error-envelope parsing with a fake spawner, `DepsModel` flattening and state
  classification from the sample `deps` JSON, display-name fallback.
- `tests/cli.integration.test.ts`: skipped unless `vaire` is found and `VAIRE_TEST_REPO` is
  set; runs `status`, `resolve concept:reference`, `suggest "loose end"`,
  `search "reference graph"`, `deps` against the `vaire` package at `VAIRE_TEST_REPO` and
  asserts the shapes (see README.md "Running the tests").
- Manual: `bun run install:vault`, reload Obsidian on a vault containing that package, walk
  through each feature.

## Module map

```
src/main.ts            plugin class: wires everything, commands, events, auto-index
src/settings.ts        VaireSettings, defaults, VaireSettingTab
src/types.ts           JSON shapes above
src/cli.ts             VaireCli, VaireError, binary detection
src/ids.ts             parseRef, formatRef, extractFrontmatterEdges, displayName, scopeFirstCandidates
src/packages.ts        PackageRegistry (roots), LocalIndex, packageFor(file), resolveLocalRef
src/deps.ts            DepsModel
src/navigate.ts        openRef, openFileAtLine
src/render/reading.ts  post processor (links + node header); exports resolveRepo/resolveOriginScope
src/render/live.ts     CM6 extension
src/render/click.ts    capture-phase click router
src/render/diagrams.ts post processor: clickable `vaire/…` shape links in rendered Mermaid SVGs
src/suggest/link-suggest.ts, search-modal.ts, resolve-modal.ts
src/views/package-view.ts, node-view.ts, external-view.ts, catalog-view.ts
src/ui/prompt-modal.ts  small text-prompt modal used by several actions
styles.css, manifest.json, versions.json, esbuild.config.mjs, package.json, tsconfig.json
scripts/install-vault.ts
tests/*.test.ts
```

## Rendering conventions (taken from vaire-renderer, the reference implementation)

The full report is in the scratchpad file `renderer-conventions.md`. What we mirror:

- **Node header** (in reading mode, before the body's H1; the H1 itself is kept since it
  is the document): a *crumb line* `type / id` in monospace with a **status dot** when a
  `status:` field exists (`dot-ok`: production, active, live, running, current;
  `dot-warn`: decommissioning, deprecated, migrating, draft, planned, proposed; `dot-off`:
  decommissioned, retired, archived, stopped, gone, superseded); the full address
  (`scope/type:id` for scoped nodes) with a copy-on-click; an `in {container link}` line
  for scoped nodes; a **superseded banner** ("This node is a tombstone — references
  redirect to {link}") when `superseded_by` is set; aliases as chips; then the frontmatter
  edges as `key → value(s)` rows **in authored order**, list values stacked one per line,
  every value rendered exactly like a prose reference. Keys hidden as bookkeeping: `id`,
  `type`, `name`, `aliases`, `superseded_by`, `scope`. Non-reference scalars are left to
  Obsidian's Properties panel (do not duplicate them), except `status`, `updated`, `since`
  which are shown compactly on the crumb line.
- **Reference styling** (CSS classes on the rendered element):
  - internal `vaire-link vaire-type-<type>`: colored like a normal link, underline on
    hover, tooltip = full address.
  - external `vaire-link vaire-link-external`: same plus a trailing `↗` glyph and a small
    `@pkg` pill; when the owning package is *not linked/resolvable*, class
    `vaire-link-unlinked`: muted, dashed underline, `⊘` glyph, tooltip "@pkg/… lives in
    package 'pkg', which is not linked here".
  - missing `vaire-link-missing`: `--text-error` color, dashed underline, tooltip "not
    found in this package: <address>".
  - loose end `vaire-loose-end`: `--text-warning`-ish gold, italic, dotted underline,
    prefixed by a tiny uppercase label `? TYPE` (or `? ?` when no hint), tooltip
    "unresolved reference — not a tracked node yet (click to resolve)".
  - display text = author's `|Display` if given, else the target's display name, else the
    bare address.
- **Package index** (PackageView): package name, version, description, then the package
  README rendered (leading H1 dropped), then **Contents** grouped by type, each group
  headed by the raw type slug with a count, nodes sorted case-insensitively by display
  name (tie-break address), each row = display-name link + `code` address; superseded
  nodes struck through and faded. Scoped nodes are *not* nested (they appear in their
  type group; their header shows the container). Side panel: package (name, version,
  node count), types legend with counts, dependencies (name, constraint, state).
- **Relations** (NodeView): **References →** (outgoing, frontmatter first then prose
  order, deduped; missing targets kept visible), **Backlinks ←** (sorted by address),
  **Supersedes** (nodes whose `superseded_by` points here — derive from LocalIndex),
  **Loose ends** in this node.
- Type badges are always the raw type slug. No per-type labels.
- **Scope-first resolution** (`feat/rendering-fidelity`): a bare `[[type:local]]` written
  inside a scoped node (frontmatter `scope: <container-id>`) resolves against
  `<scope>/type:local` first, falling back to the global `type:local` — mirrors the
  published renderer's `resolve_address` (renderer-conventions.md §2). One helper,
  `scopeFirstCandidates` (src/ids.ts, pure) + `resolveLocalRef` (src/packages.ts, applies it
  to a real `LocalIndex`), used by `createRefElement`/`openRef`/live preview/the click
  router/"Open node under cursor". A reference that already names its own scope explicitly
  (`[[container-id/type:local]]`) is not further widened. Applies the same way to a `@pkg/…`
  reference whose package also happens to be indexed in this vault.
- **Diagrams** (`feat/rendering-fidelity`): Obsidian renders ```mermaid fences natively into
  an `<svg>`; `src/render/diagrams.ts` waits for that SVG (MutationObserver, 10s timeout)
  and rewrites its own `<a href="vaire/…">`/`xlink:href` shape-link anchors in place — valid
  target (`vaire/type:id`, per renderer-conventions.md §5B) → `vaire-dref vaire-type-<t>`,
  `href` removed, click opens the node via `openRef`; missing/invalid → `vaire-dref-off`
  with an explanatory title. PlantUML is not rendered natively by Obsidian, so its diagram
  links are out of scope.

## CLI contract nuances (verified against 0.3.2; full report in scratchpad `cli-contract.md`)

- **Argument-parsing errors bypass the JSON envelope**: unknown flag → exit 2, empty
  stdout, plain text on stderr. `VaireCli.run` must treat "non-zero exit + non-JSON stdout"
  as `VaireError{kind:'spawn'|'usage', message: stderr}`.
- Exit codes: 0 ok · 1 generic (incl. `index_locked`, `registry`) · 2 usage · 3 index
  corrupt (`index --full` fixes) · 4 `no_repo`/`index_not_built`/`dependency` · 5
  `id_not_found` · 6 `check` found violations (JSON still printed, unwrapped!) · 7 release
  gated. So for `check`, exit 6 is a *normal outcome*: parse stdout as `CheckResult`.
- `check` finding shapes vary by `kind`: `missing_dependency` is `{kind, package, note}`;
  `dangling_ref` is `{kind, from, to, path, line}`; `drift` is `{kind, id, to, path, line}`;
  `orphan` is `{kind, id, path}`. Type `Finding` as `{kind: string; [k: string]: unknown}`
  and render whichever of `id/from/to/package/note/path/line` are present.
- `deps.resolved` is relative to the run root, which is always the package root we pass as
  cwd/`--repo`. Prefer the realpath of `<root>/.vaire/packages/<name>` for locating a
  dependency; fall back to `resolved`.
- `resolve/search/suggest/backlinks/refs` results in a dependency carry `package: "<name>"`
  and a `path` relative to *that* package's root.
- **Rootless reads work**: outside any package, `vaire resolve @pkg/type:id`, `search --all`,
  `suggest --all` answer from the catalog's live sightings. To read any catalog package
  directly, pass `--repo <sighting path>` (needs that package's index to exist; if
  `index_not_built`, offer "Build index" there).
- `vaire pull` JSON output shape is undocumented: treat the result as opaque; success = exit
  0. Errors come back as `{kind:'registry'|'dependency', message}` — show the message.
- `status`, `check` and `index` run vaire's dependency "ensure pass" and may rewrite
  `knowledge.lock`. That is vaire's documented behavior; the plugin does not try to prevent
  it (note it in README).
- `registry show <name>` returns the registry descriptor plus enumerated packages/releases
  when reachable; the shape is not pinned down, so render it generically: known scalar
  fields as rows, `packages` (array of objects with `name` and per-release entries) as a
  table when present, else a pretty-printed JSON block. There is no cross-registry search
  command in 0.3.x.
- Catalog `origin` values: `registered` | `scanned` | `ambient`; `state`: `live` | `missing`.

## Phase 2 ownership (parallel passes; nobody edits another pass's files)

| pass | owns | registers via |
| --- | --- | --- |
| rendering | `src/render/{index,reading,header,live,click,ref-el}.ts`, `styles/20-render.css`, `tests/render*.test.ts` | `registerRendering` |
| suggestions | `src/suggest/{index,link-suggest,search-modal,resolve-modal}.ts`, `styles/30-suggest.css`, `tests/suggest*.test.ts`; sets `plugin.hooks.resolveLooseEnd` | `registerSuggestions` |
| package + node views | `src/views/{package-node,package-view,node-view}.ts`, `styles/40-views.css` | `registerPackageAndNodeViews` |
| external + catalog views | `src/views/{external-catalog,external-view,catalog-view}.ts`, `styles/50-external-catalog.css`; sets `plugin.hooks.openExternal` | `registerExternalAndCatalogViews` |

Shared contracts:
- `createRefElement(plugin, ref, {repo, display?, reuse?, newLeaf?})` in `src/render/ref-el.ts`
  is the only way a reference becomes a DOM element (views import it; the rendering pass
  implements it).
- The external view renders with `MarkdownRenderer.render(app, body, container, sourcePath,
  component)` where `container` carries `data-vaire-repo="<absRoot>"` and `sourcePath` is
  `__vaire_external__/<encodeURIComponent(absRoot)>/<path-in-package>`. The reading-mode post
  processor determines the resolution root by: vault package of `ctx.sourcePath` → nearest
  `[data-vaire-repo]` ancestor of `el` → the `__vaire_external__` prefix of `ctx.sourcePath`.
- `styles.css` is generated by the build from `styles/*.css` (name order); never edit it.
- Commands are added inside each pass's `register*` function; `main.ts` is frozen.
