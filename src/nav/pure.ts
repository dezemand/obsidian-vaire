// Pure helpers for the navigation pass (feat/tab-titles): tab/view title text and scope
// breadcrumb chains. No `obsidian` import, so this stays unit-testable in plain `bun test`
// (see tests/nav.test.ts) — mirrors the split `src/render/pure.ts` and `src/theme/families.ts`
// already use (DOM-touching code in titles.ts/breadcrumbs.ts calls into these instead of
// duplicating the logic inline). Deliberately takes minimal duck-typed shapes rather than
// importing `LocalNode`/`PackageInfo` from `../packages`, which pulls in `obsidian`.

/** Trade-off setting: what a markdown tab header / view title shows for a Vairë node. */
export type TabTitleMode = 'file' | 'node' | 'both';

/** Trade-off setting: where (if anywhere) the scope breadcrumb trail is shown. */
export type BreadcrumbPlacement = 'header' | 'view' | 'off';

export interface TitleNode {
  name: string;
}

/**
 * The title text a tab header / view title should show for `node` (or `null` when the file
 * isn't a Vairë node — always the basename regardless of `mode`). `'file'` is the plain
 * basename too — DOM code short-circuits before ever needing it, but returning it here keeps
 * the function total rather than partial.
 */
export function titleText(node: TitleNode | null, basename: string, mode: TabTitleMode): string {
  if (!node || mode === 'file') return basename;
  if (mode === 'node') return node.name;
  return `${node.name} · ${basename}`;
}

/**
 * Idempotence key for a decorated title host element (`tabHeaderInnerTitleEl` or a view's
 * `titleEl`), stored in its `data-vaire-title` attribute — mirrors `navDecorationKey` in
 * `src/render/pure.ts`. Re-decoration is skipped whenever this key is unchanged. `null` means
 * "not decorated" (mode is `'file'` or the file isn't a Vairë node); titles.ts treats that as
 * "clear whatever decoration exists, if any" rather than storing the literal string `'null'`.
 */
export function titleKey(node: TitleNode | null, type: string | undefined, basename: string, mode: TabTitleMode): string | null {
  if (!node || mode === 'file') return null;
  return `${mode}|${type ?? ''}|${node.name}|${basename}`;
}

// ---- Scope breadcrumbs --------------------------------------------------------------------

export interface ScopeLookupNode {
  name: string;
  scope?: string;
}

export interface ScopeChainCrumb {
  /** Full local id of this container, e.g. `project:atlas`. */
  id: string;
  /** The container's display name, or `null` when `lookup` couldn't find it (a missing ref). */
  name: string | null;
}

export interface ScopeChainResult {
  /** Outermost container first, the node's immediate container last. Excludes the package
   *  crumb and the node itself — callers prepend/append those. */
  chain: ScopeChainCrumb[];
  /** `true` when climbing the chain revisited an id already seen — the chain is truncated
   *  right before the repeat rather than looping forever. */
  cycle: boolean;
  /** `true` when any crumb in `chain` is a missing ref (`lookup` returned `null` for it). A
   *  missing container has no `scope` of its own to climb further, so it is always the last
   *  entry pushed (though not necessarily the last in `chain` after the outermost-first
   *  reversal — see tests/nav.test.ts). */
  missing: boolean;
}

/**
 * Walks `node`'s `scope` outward — `scope` -> that container's own `scope` -> … — via
 * `lookup`, per DESIGN.md's scope breadcrumb spec: a container may itself be scoped, so this
 * keeps climbing until there's no further `scope`, `lookup` can't find the current id (a
 * missing/dangling container ref), the chain revisits an id already seen (`cycle`), or
 * `maxDepth` containers have been collected (whichever comes first).
 */
export function scopeChain(
  node: { scope?: string },
  lookup: (id: string) => ScopeLookupNode | null,
  maxDepth = 8,
): ScopeChainResult {
  const collected: ScopeChainCrumb[] = []; // innermost (node's direct container) first
  const seen = new Set<string>();
  let cycle = false;
  let missing = false;
  let current = node.scope;

  while (current && collected.length < maxDepth) {
    if (seen.has(current)) {
      cycle = true;
      break;
    }
    seen.add(current);

    const found = lookup(current);
    if (!found) {
      collected.push({ id: current, name: null });
      missing = true;
      break; // no `.scope` to climb further without a resolved container
    }
    collected.push({ id: current, name: found.name });
    current = found.scope;
  }

  collected.reverse(); // outermost first
  return { chain: collected, cycle, missing };
}
