// Pure tree builder for the Vairë explorer sidebar (feat/type-tree). No `obsidian` import, so
// this stays unit-testable with plain `bun test`. See DESIGN.md-equivalent branch notes in
// BRANCHES.md and src/tree/tree-view.ts, which is the only caller.
//
// The trade-off this branch builds: `scopedLayout` controls how a scoped node (frontmatter
// `scope: <container full id>`) is placed in the tree.
//   - 'nested': a scoped node whose container exists in the same node set is *not* listed in
//     its own type group — it becomes a child of the container's tree row instead, grouped by
//     type under it (e.g. `cli:vaire` -> `command` -> `add`, `backlinks`, …). The container row
//     gets a `count` (its scoped-child count) so the view can show a badge.
//   - 'flat': every node is listed only in its type group (or folder, under `groupBy:
//     'folder'`), like the published site. A scoped node whose container is known carries
//     `scopedInName` (the container's display name) so the view can render a muted "in
//     <container>" suffix.
// Independently, `groupBy` picks the top-level grouping of *non-nested* nodes: 'type' (default)
// or 'folder' (mirrors the package's directory layout). A container's own children are always
// grouped by type regardless of `groupBy`, per the branch's design note.
//
// A scoped node whose container is not present in the given node set (deleted, not yet
// indexed, wrong id, …) always falls back to its own type/folder placement, with
// `missingContainer: true` so the view can render a warning marker — this happens in both
// layouts, since 'nested' has nothing to nest it under.

/** Structural shape of `LocalNode` (src/packages.ts) that tree building needs. */
export interface NodeLike {
  type: string;
  /** Full local id, e.g. `type:id` or `scope/type:id`. */
  full: string;
  name: string;
  aliases: string[];
  /** `ctype:cid` of the container this node is scoped under, if any. */
  scope?: string;
  supersededBy?: string;
  /** Vault-relative file path, used for `groupBy: 'folder'`. */
  path: string;
}

export interface TreeOptions {
  scopedLayout: 'nested' | 'flat';
  groupBy: 'type' | 'folder';
}

export type TreeNodeKind = 'type' | 'folder' | 'node';

export interface TreeNode {
  /** Stable across rebuilds of the same node set + options — safe to use as collapse-state
   *  keys and DOM keys. */
  key: string;
  kind: TreeNodeKind;
  label: string;
  /** kind 'node' only: the node's full id. */
  fullId?: string;
  /** kind 'node': the node's type slug. kind 'type': the type this group holds. */
  type?: string;
  /** kind 'type'/'folder': number of nodes directly grouped here. kind 'node': set (and > 0)
   *  only when this node is a container with nested scoped children in 'nested' layout — the
   *  child-count badge. */
  count?: number;
  /** kind 'node': true when `supersededBy` is set — render faded, sort last. */
  gone?: boolean;
  /** kind 'node': true when `scope` is set but no node with that full id was found in the
   *  given set — the "container missing" fallback. */
  missingContainer?: boolean;
  /** kind 'node', 'flat' layout only: the display name of the (known) container, for the
   *  muted "in <container>" suffix. */
  scopedInName?: string;
  /** kind 'node': lowercased id/full/name/aliases, joined, for `filterTree`. */
  searchText?: string;
  children: TreeNode[];
}

// ---- sorting: active nodes by name (case-insensitive, tie-broken by full id), superseded last ----

function sortNodes<T extends NodeLike>(nodes: T[]): T[] {
  const byName = (a: T, b: T): number => {
    const byN = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return byN !== 0 ? byN : a.full.localeCompare(b.full);
  };
  const active = nodes.filter((n) => !n.supersededBy).sort(byName);
  const gone = nodes.filter((n) => n.supersededBy).sort(byName);
  return [...active, ...gone];
}

function searchTextOf(n: NodeLike): string {
  return [n.full, n.name, ...n.aliases].join('\u0000').toLowerCase();
}

// ---- container children: always grouped by type, regardless of `groupBy` ------------------

function containerChildCount(containerFull: string, allNodes: NodeLike[]): number {
  let count = 0;
  for (const n of allNodes) if (n.scope === containerFull) count++;
  return count;
}

function buildContainerChildren(containerFull: string, allNodes: NodeLike[], opts: TreeOptions): TreeNode[] {
  const scoped = allNodes.filter((n) => n.scope === containerFull);
  if (scoped.length === 0) return [];

  const byType = new Map<string, NodeLike[]>();
  for (const n of scoped) {
    const list = byType.get(n.type);
    if (list) list.push(n);
    else byType.set(n.type, [n]);
  }
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b));

  return types.map((type) => {
    const list = sortNodes(byType.get(type) as NodeLike[]);
    return {
      key: `container:${containerFull}/type:${type}`,
      kind: 'type' as const,
      label: type,
      type,
      count: list.length,
      children: list.map((n) => leafFor(n, allNodes, opts, undefined)),
    };
  });
}

// ---- one node's leaf, with container children attached when it is itself a container -------

function leafFor(
  n: NodeLike,
  allNodes: NodeLike[],
  opts: TreeOptions,
  nodesByFull: Map<string, NodeLike> | undefined,
): TreeNode {
  const byFull = nodesByFull ?? indexByFull(allNodes);
  const containerExists = n.scope ? byFull.has(n.scope) : false;
  const missingContainer = Boolean(n.scope) && !containerExists;
  const scopedInName =
    opts.scopedLayout === 'flat' && n.scope && containerExists ? (byFull.get(n.scope) as NodeLike).name : undefined;

  const leaf: TreeNode = {
    key: `node:${n.full}`,
    kind: 'node',
    label: n.name,
    fullId: n.full,
    type: n.type,
    gone: Boolean(n.supersededBy),
    missingContainer,
    scopedInName,
    searchText: searchTextOf(n),
    children: [],
  };

  if (opts.scopedLayout === 'nested') {
    const childCount = containerChildCount(n.full, allNodes);
    if (childCount > 0) {
      leaf.count = childCount;
      leaf.children = buildContainerChildren(n.full, allNodes, opts);
    }
  }

  return leaf;
}

function indexByFull(nodes: NodeLike[]): Map<string, NodeLike> {
  return new Map(nodes.map((n) => [n.full, n]));
}

/** Whether `n` gets its own top-level slot (type or folder group) rather than being nested
 *  under its container's row — see the module doc comment. */
function isTopLevel(n: NodeLike, opts: TreeOptions, nodesByFull: Map<string, NodeLike>): boolean {
  if (!n.scope) return true;
  if (opts.scopedLayout === 'nested' && nodesByFull.has(n.scope)) return false;
  return true;
}

// ---- top-level grouping: by type -----------------------------------------------------------

function groupByType(topLevel: NodeLike[], allNodes: NodeLike[], opts: TreeOptions, nodesByFull: Map<string, NodeLike>): TreeNode[] {
  const byType = new Map<string, NodeLike[]>();
  for (const n of topLevel) {
    const list = byType.get(n.type);
    if (list) list.push(n);
    else byType.set(n.type, [n]);
  }
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b));
  return types.map((type) => {
    const list = sortNodes(byType.get(type) as NodeLike[]);
    return {
      key: `type:${type}`,
      kind: 'type' as const,
      label: type,
      type,
      count: list.length,
      children: list.map((n) => leafFor(n, allNodes, opts, nodesByFull)),
    };
  });
}

// ---- top-level grouping: by folder (mirrors the package's directory layout) ----------------

interface FolderBucket {
  children: Map<string, FolderBucket>;
  nodes: NodeLike[];
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function bucketFor(nodes: NodeLike[]): FolderBucket {
  const root: FolderBucket = { children: new Map(), nodes: [] };
  for (const n of nodes) {
    const dir = dirOf(n.path);
    const segments = dir ? dir.split('/') : [];
    let cur = root;
    for (const seg of segments) {
      let next = cur.children.get(seg);
      if (!next) {
        next = { children: new Map(), nodes: [] };
        cur.children.set(seg, next);
      }
      cur = next;
    }
    cur.nodes.push(n);
  }
  return root;
}

function realizeFolder(
  bucket: FolderBucket,
  keyPath: string,
  label: string,
  allNodes: NodeLike[],
  opts: TreeOptions,
  nodesByFull: Map<string, NodeLike>,
): TreeNode {
  const subfolders = [...bucket.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const children: TreeNode[] = [];
  let count = 0;
  for (const [seg, sub] of subfolders) {
    const childKeyPath = keyPath ? `${keyPath}/${seg}` : seg;
    const node = realizeFolder(sub, childKeyPath, seg, allNodes, opts, nodesByFull);
    count += node.count ?? 0;
    children.push(node);
  }
  const leaves = sortNodes(bucket.nodes).map((n) => leafFor(n, allNodes, opts, nodesByFull));
  count += leaves.length;
  children.push(...leaves);
  return { key: `folder:${keyPath}`, kind: 'folder', label, count, children };
}

function groupByFolder(topLevel: NodeLike[], allNodes: NodeLike[], opts: TreeOptions, nodesByFull: Map<string, NodeLike>): TreeNode[] {
  const root = bucketFor(topLevel);
  const result: TreeNode[] = [];
  const subfolders = [...root.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [seg, sub] of subfolders) {
    result.push(realizeFolder(sub, seg, seg, allNodes, opts, nodesByFull));
  }
  const leaves = sortNodes(root.nodes).map((n) => leafFor(n, allNodes, opts, nodesByFull));
  result.push(...leaves);
  return result;
}

/**
 * Builds the tree for one package's node set: top-level groups (by type or by folder per
 * `opts.groupBy`), each holding its nodes (sorted by name, superseded last); scoped nodes are
 * placed per `opts.scopedLayout` (see the module doc comment above). Pass `nodes` = every
 * `LocalNode` of one package (mapped to `NodeLike`) — the caller (`src/tree/tree-view.ts`)
 * wraps the result in a package-level row per package, which is outside this pure module's
 * concern.
 */
export function buildTree(nodes: NodeLike[], opts: TreeOptions): TreeNode[] {
  const nodesByFull = indexByFull(nodes);
  const topLevel = nodes.filter((n) => isTopLevel(n, opts, nodesByFull));
  return opts.groupBy === 'folder'
    ? groupByFolder(topLevel, nodes, opts, nodesByFull)
    : groupByType(topLevel, nodes, opts, nodesByFull);
}

// ---- filterTree: prune to matching node rows + their ancestors, and report which keys ------
// ---- (the ancestors) should be force-expanded to reveal them -------------------------------

export interface FilterResult {
  tree: TreeNode[];
  /** Keys of every group row (type/folder, and container-child type subgroups) that contains
   *  at least one match — the view force-expands these regardless of stored collapse state. */
  expandKeys: Set<string>;
}

function nodeMatches(n: TreeNode, needle: string): boolean {
  return n.kind === 'node' && !!n.searchText && n.searchText.includes(needle);
}

function filterNode(n: TreeNode, needle: string, expandKeys: Set<string>): TreeNode | null {
  if (n.kind === 'node') {
    // A container row (has children) survives if it matches itself OR any descendant matches.
    if (n.children.length === 0) return nodeMatches(n, needle) ? n : null;
    const filteredChildren = n.children
      .map((c) => filterNode(c, needle, expandKeys))
      .filter((c): c is TreeNode => c !== null);
    if (nodeMatches(n, needle)) {
      // Keep the whole subtree (unfiltered) since the container itself matched, but still
      // expand toward it if any child also happened to match.
      if (filteredChildren.length > 0) expandKeys.add(n.key);
      return n;
    }
    if (filteredChildren.length === 0) return null;
    expandKeys.add(n.key);
    return { ...n, children: filteredChildren };
  }

  const filteredChildren = n.children.map((c) => filterNode(c, needle, expandKeys)).filter((c): c is TreeNode => c !== null);
  if (filteredChildren.length === 0) return null;
  expandKeys.add(n.key);
  return { ...n, children: filteredChildren };
}

/**
 * Filters `tree` to node rows whose id/full id/name/alias contain `text` (case-insensitive),
 * keeping every ancestor group needed to reach a match and pruning everything else. An empty
 * (or all-whitespace) `text` is a no-op: the original `tree` is returned unchanged with no
 * keys to force-expand.
 */
export function filterTree(tree: TreeNode[], text: string): FilterResult {
  const needle = text.trim().toLowerCase();
  if (!needle) return { tree, expandKeys: new Set() };
  const expandKeys = new Set<string>();
  const filtered = tree.map((n) => filterNode(n, needle, expandKeys)).filter((n): n is TreeNode => n !== null);
  return { tree: filtered, expandKeys };
}

/**
 * The path of keys from a root entry of `tree` down to (and including) the row keyed `key`, or
 * `null` if not found. Used to expand every ancestor of the active file's node and scroll it
 * into view.
 */
export function pathToNode(tree: TreeNode[], key: string): string[] | null {
  for (const n of tree) {
    if (n.key === key) return [n.key];
    const sub = pathToNode(n.children, key);
    if (sub) return [n.key, ...sub];
  }
  return null;
}
