// JSON shapes returned by `vaire -o json ...`, per DESIGN.md "JSON shapes" (0.3.2 binary).
// Kept as plain data interfaces — no behavior here.

export interface ResolveResult {
  id: string;
  type: string;
  path: string;
  /** Present only for nodes that live in a dependency package. */
  package?: string;
  frontmatter: Record<string, unknown>;
  superseded_by: string | null;
}

export interface RenderResult {
  id: string;
  path: string;
  markdown: string;
}

export interface BacklinkEntry {
  id: string;
  type: string;
  path: string;
  package?: string;
  /** "inline" for a prose reference, otherwise the frontmatter key that declared the edge. */
  ref_type: string;
  line: number;
}

export interface BacklinksResult {
  id: string;
  backlinks: BacklinkEntry[];
}

export interface RefEntry {
  id: string;
  type: string;
  path: string;
  package?: string;
  ref_type: string;
  line: number;
  distance: number;
}

export interface RefsResult {
  id: string;
  depth: number;
  refs: RefEntry[];
}

export interface Anchor {
  heading: string;
  line: number;
  snippet: string;
}

export interface SearchHit {
  id: string;
  type: string;
  path: string;
  package?: string;
  score: number;
  anchors: Anchor[];
}

export interface SearchResult {
  query: string;
  results: SearchHit[];
}

export interface Suggestion {
  id: string;
  type: string;
  name: string;
  path: string;
  package?: string;
  score: number;
}

export interface SuggestResult {
  descriptor: string;
  suggestions: Suggestion[];
  count: number;
}

export interface LooseEndItem {
  record: string;
  path: string;
  type_guess: string | null;
  descriptor: string;
  line: number;
}

export interface UnresolvedResult {
  unresolved: LooseEndItem[];
  count: number;
}

export interface DepNode {
  name: string;
  constraint: string;
  version?: string;
  /** Relative to the owning package dir; absent when the dependency could not be located. */
  resolved?: string;
  satisfied?: boolean;
  note?: string;
  /** Set (true) when this occurrence re-encounters a package already on the current path (a
   *  real dependency cycle, not just a diamond shared by two branches) — the CLI stops
   *  descending at that point, so `dependencies` is omitted here. See DESIGN.md's dependency
   *  graph feature note and `src/depgraph/pure.ts`. */
  cycle?: boolean;
  dependencies?: DepNode[];
}

export interface DepsResult {
  name: string;
  version: string;
  dependencies: DepNode[];
}

export interface StatusResult {
  repo: string;
  index_path: string;
  schema_version: number | null;
  source: 'working-tree' | 'committed' | null;
  last_indexed_commit: string | null;
  commits_behind_head: number;
  nodes: { total: number; by_type: Record<string, number> };
  edges: number;
  embeddings: { sections: number; cached: number };
  embed_provider?: string;
  pending_release?: {
    since: string;
    would_be: 'none' | 'patch' | 'minor' | 'major';
    added: number;
    changed: number;
    retired: number;
    removed: number;
  };
}

/**
 * One `check` finding. The shape varies by `kind` (verified against 0.3.2): `drift`/`dangling_ref`
 * carry `id`|`from`, `to`, `path`, `line`; `orphan` carries `id`, `path`; `missing_dependency`
 * carries `package`, `note` only. Render whichever fields are present.
 */
export interface Finding {
  kind: string;
  id?: string;
  from?: string;
  to?: string;
  package?: string;
  note?: string;
  path?: string;
  line?: number;
  [key: string]: unknown;
}

export interface CheckResult {
  ok: boolean;
  violations: Finding[];
  warnings: Finding[];
}

export interface Sighting {
  path: string;
  name: string;
  version: string;
  state: 'live' | 'missing';
  /** Usually one of `'registered' | 'scanned' | 'ambient'`, but the CLI's set of origins isn't
   *  closed — `(string & {})` keeps those three autocompleting without collapsing the whole
   *  union to plain `string`. */
  origin: 'registered' | 'scanned' | 'ambient' | (string & {});
  last_seen: number;
}

export interface CatalogList {
  catalog: string;
  sightings: Sighting[];
}

export interface RegistryEntry {
  name: string;
  url: string;
  kind: string;
  priority: number;
  search_by_default: boolean;
}

export interface RegistryList {
  catalog: string;
  registries: RegistryEntry[];
}

/** `registry show <name>` — exact shape is uncertain beyond the packages list, so stay loose. */
export interface RegistryShow extends Record<string, unknown> {
  packages?: Array<{ name: string; versions?: unknown[] }>;
}

export interface VaireErrorEnvelope {
  error: {
    code: number;
    kind: string;
    message: string;
  };
}

/**
 * `vaire release [--dry-run]` JSON (registry.md §3.1, DESIGN.md release-ui addendum). Kept
 * loose (`[key: string]: unknown`) since the shape may grow (e.g. `advisories`) — only the
 * fields the UI actually reads are pinned. `status` is `nothing` (no-op), `planned`
 * (`--dry-run`), `blocked` (a MAJOR the classifier refuses without `--major`, exit 7), or
 * `released` (a real run that committed and tagged). `outcome.kind` is `nothing`, `initial`
 * (no prior tag), or `bump` (with `outcome.bump` set).
 */
export interface ReleasePlan {
  package?: string;
  status?: 'nothing' | 'planned' | 'blocked' | 'released';
  version?: string;
  bump?: 'major' | 'minor' | 'patch';
  outcome?: { kind: string; bump?: 'major' | 'minor' | 'patch' };
  added?: string[];
  changed?: string[];
  retired?: string[];
  removed?: string[];
  tag?: string;
  record?: string;
  commit?: string;
  warnings?: number;
  summary?: boolean;
  notes_required?: boolean;
  advisories?: Array<{ id: string; inbound: number }>;
  [key: string]: unknown;
}

/** `vaire pack` JSON (registry.md's wire contract / DESIGN.md release-ui addendum) — loosely
 * typed for the same reason as `ReleasePlan`. */
export interface PackResult {
  name?: string;
  version?: string;
  commit?: string;
  artifact?: string;
  sha256?: string;
  size_bytes?: number;
  entries?: number;
  nodes?: number;
  embeddings?: number;
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * `vaire pull [--dry-run] [--locked]` JSON — DESIGN.md "CLI contract nuances" calls the shape
 * undocumented and says to treat it as opaque; this is what the 0.3.2 binary actually printed
 * when captured for `feat/dep-updates` (see tests/fixtures/pull-dry-run-*.json), kept loose
 * (`[key: string]: unknown`) for the same reason as `ReleasePlan`/`PackResult`. `src/updates/
 * pure.ts`'s `parsePullDryRun` is the tolerant reader — it does not assume any of these fields
 * are present, and falls back to `raw` for a shape it doesn't recognize at all.
 */
export interface PullResult {
  store?: string;
  pulled?: Array<{ package?: string; name?: string; version?: string; registry?: string; path?: string } | string>;
  already?: Array<{ package?: string; name?: string; version?: string } | string>;
  failed?: Array<{ package?: string; name?: string; reason?: string; message?: string } | string>;
  dry_run?: boolean;
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * `vaire clean [--dry-run]` JSON — same undocumented-shape caveat as `PullResult`; captured
 * from the 0.3.2 binary (tests/fixtures/clean-dry-run.json). `src/updates/pure.ts`'s
 * `parseCleanDryRun` is the tolerant reader.
 */
export interface CleanResult {
  store?: string;
  removed?: Array<{ package?: string; name?: string; version?: string; size?: number; bytes?: number } | string>;
  kept?: number;
  dry_run?: boolean;
  warnings?: string[];
  [key: string]: unknown;
}
