// Pure helpers for the quick switcher (`FuzzySuggestModal` over every node in every vault
// package, plus up to 5 CLI-backed dependency hits) — no `obsidian` import, so these stay
// unit-testable in plain `bun test`. See DESIGN.md "Suggestions" §2 and the quick-switch
// feature note. `LocalNode`/`PackageInfo`/`Suggestion` are imported as types only (erased at
// build time), matching the convention already used by src/suggest/{link-suggest,resolve-modal}.ts.

import type { LocalNode, PackageInfo } from '../packages';
import type { Suggestion } from '../types';

/** One row in the quick switcher: a vault node (`source: 'local'`) or a CLI-suggested
 *  dependency hit (`source: 'cli'`, always `@pkg/`-prefixed once it survives `mergeCliItems`). */
export interface NodeItem {
  /** Full id to open/insert/copy — includes `@pkg/` for a dependency hit. */
  id: string;
  name: string;
  type: string;
  aliases: string[];
  /** Owning package's display name — package badge + `@pkg` query filtering. */
  pkgName?: string;
  superseded: boolean;
  source: 'local' | 'cli';
  /** Present for `source: 'local'`: the vault node + its owning package, to open the file directly. */
  local?: { node: LocalNode; pkg: PackageInfo };
  /** Present for `source: 'cli'`: the raw suggestion this item was built from. */
  suggestion?: Suggestion;
}

export function localNodeToItem(node: LocalNode, pkg: PackageInfo): NodeItem {
  return {
    id: node.full,
    name: node.name,
    type: node.type,
    aliases: node.aliases,
    pkgName: pkg.name,
    superseded: Boolean(node.supersededBy),
    source: 'local',
    local: { node, pkg },
  };
}

// `Suggestion.id` from the CLI already carries the `@pkg/` prefix when `package` is set
// (verified against the live 0.3.2 binary; see the same note in link-suggest.ts).
export function suggestionToNodeItem(s: Suggestion): NodeItem {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    aliases: [],
    pkgName: s.package,
    superseded: false,
    source: 'cli',
    suggestion: s,
  };
}

export interface ItemSearchSegments {
  /** The full search text, as handed to `prepareFuzzySearch`'s matcher. */
  text: string;
  /** `[start, end)` of `item.name` within `text`. */
  nameRange: [number, number];
  /** `[start, end)` of `item.id` within `text`. */
  idRange: [number, number];
  /** `[start, end)` of the space-joined aliases within `text`, or `null` when there are none. */
  aliasesRange: [number, number] | null;
}

/**
 * Splits the search text (`name  type:id  alias1 alias2` — two spaces between fields, one
 * between aliases) into its field ranges, so a modal can slice a fuzzy match's offsets back
 * onto just the name (for highlighting) or detect a hit inside the aliases (to decide whether
 * to show them at all). The aliases field is omitted entirely when there are none, matching
 * `itemSearchText` below exactly — both are derived from this one function so they can't drift.
 */
export function itemSearchSegments(item: NodeItem): ItemSearchSegments {
  const aliasesText = item.aliases.join(' ');
  const parts = [item.name, item.id];
  if (aliasesText) parts.push(aliasesText);
  const text = parts.join('  ');

  const nameRange: [number, number] = [0, item.name.length];
  const idStart = nameRange[1] + 2;
  const idRange: [number, number] = [idStart, idStart + item.id.length];
  let aliasesRange: [number, number] | null = null;
  if (aliasesText) {
    const aliasesStart = idRange[1] + 2;
    aliasesRange = [aliasesStart, aliasesStart + aliasesText.length];
  }
  return { text, nameRange, idRange, aliasesRange };
}

/** The text a candidate is fuzzy-matched against: `name  type:id  alias1 alias2`. Matching on
 *  `id` (which is `type:id`, optionally `@pkg/`-prefixed) covers both the id and its type. */
export function itemSearchText(item: NodeItem): string {
  return itemSearchSegments(item).text;
}

export interface ParsedQuickQuery {
  /** Set by a leading `type:` prefix (e.g. `decision: caret`), restricting to that type. */
  typeFilter?: string;
  /** Set by a leading `@pkg` prefix, restricting to that package (matched case-insensitively). */
  pkgFilter?: string;
  /** What remains after stripping any recognized prefixes — the text to fuzzy-match on. */
  text: string;
}

const SLUG = '[a-z0-9][a-z0-9-]*';
const PKG_PREFIX_RE = new RegExp(`^@(?<pkg>${SLUG})(?:\\s+(?<rest>.*))?$`);
const TYPE_PREFIX_RE = new RegExp(`^(?<type>${SLUG}):\\s*(?<rest>.*)$`);

/**
 * Parses a typed `@pkg` package filter (must come first) and/or a `type:` type filter out of
 * a quick-switcher query, e.g. `@acme decision: caret` -> `{pkgFilter:'acme', typeFilter:
 * 'decision', text:'caret'}`. Either, both, or neither may be present; whatever is left after
 * stripping recognized prefixes is `text`, unchanged (not trimmed, so callers see exactly what
 * follows the prefix — trimming is the caller's call to make before fuzzy-matching on it).
 */
export function parseQuickQuery(q: string): ParsedQuickQuery {
  let rest = q;
  let pkgFilter: string | undefined;
  let typeFilter: string | undefined;

  const pkgMatch = PKG_PREFIX_RE.exec(rest);
  if (pkgMatch?.groups) {
    pkgFilter = pkgMatch.groups.pkg;
    rest = pkgMatch.groups.rest ?? '';
  }

  const typeMatch = TYPE_PREFIX_RE.exec(rest);
  if (typeMatch?.groups) {
    typeFilter = typeMatch.groups.type;
    rest = typeMatch.groups.rest;
  }

  return { typeFilter, pkgFilter, text: rest };
}

/**
 * Narrows `items` by a `ParsedQuickQuery`'s `typeFilter` (exact, case-insensitive) and/or
 * `pkgFilter` (case-insensitive, matched as a prefix of the item's package name so `@acme`
 * finds `acme-platform`). Returns `items` itself, unchanged, when neither filter is set —
 * callers that only care about "was anything filtered out" can rely on that as a fast path.
 * This is the hard filter the modal applies *before* fuzzy-matching (or, with no query text,
 * before `sortItems`): a `type:`/`@pkg` prefix restricts the candidate pool rather than being
 * fuzzy-matched itself, which is why `parseQuickQuery` strips it out of `text` in the first
 * place.
 */
export function filterQuickItems(items: NodeItem[], filter: Pick<ParsedQuickQuery, 'typeFilter' | 'pkgFilter'>): NodeItem[] {
  if (!filter.typeFilter && !filter.pkgFilter) return items;
  const type = filter.typeFilter?.toLowerCase();
  const pkg = filter.pkgFilter?.toLowerCase();
  return items.filter((item) => {
    if (type && item.type.toLowerCase() !== type) return false;
    if (pkg && !item.pkgName?.toLowerCase().startsWith(pkg)) return false;
    return true;
  });
}

/**
 * The `[start, end)` pairs of `matches` (as returned by Obsidian's `prepareFuzzySearch`, offsets
 * into the text that was matched — see `itemSearchText`) that fall entirely within `range`.
 * Used to slice a whole-candidate match down to just the name segment (for `renderMatches`
 * highlighting — safe to use unshifted since `itemSearchSegments().nameRange` always starts at
 * 0) or to detect a hit inside the aliases segment (whether to reveal them at all). A pair must
 * be fully contained, not merely overlapping: the two-space field separators in `itemSearchText`
 * mean a genuine match can never straddle a field boundary, but this guards that edge case
 * rather than ever showing a partial/garbled highlight. Returns `[]` for a null `range` (e.g.
 * an item with no aliases, whose `aliasesRange` is `null`).
 */
export function matchesInRange(matches: [number, number][], range: [number, number] | null): [number, number][] {
  if (!range) return [];
  const [start, end] = range;
  return matches.filter(([mStart, mEnd]) => mStart >= start && mEnd <= end);
}

/** Superseded nodes sort last; otherwise case-insensitive name order (ties broken by id). Used
 *  for the "browsing" case (no query text) — see DESIGN.md's "empty query -> sorted by name"
 *  convention elsewhere in the suggestions pass, and `groupNodes` in src/views/pure-pkg.ts for
 *  the same comparator idiom. */
export function sortItems(items: NodeItem[]): NodeItem[] {
  return [...items].sort((a, b) => {
    if (a.superseded !== b.superseded) return a.superseded ? 1 : -1;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

const CLI_APPEND_LIMIT = 5;

/**
 * Appends up to `CLI_APPEND_LIMIT` CLI-suggested items after `local` (already ordered), for
 * the "dependency hits below the local results" section. Only genuine cross-package hits
 * (`id` starting with `@`, i.e. the CLI itself prefixed it with `@pkg/`) are eligible — a CLI
 * suggestion for a node already in `local` (same package, or a vault package the CLI also
 * happens to know about) is redundant and dropped. `local`'s own order is untouched.
 */
export function mergeCliItems(local: NodeItem[], cli: NodeItem[]): NodeItem[] {
  const seen = new Set(local.map((item) => item.id));
  const appended: NodeItem[] = [];
  for (const item of cli) {
    if (!item.id.startsWith('@')) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    appended.push(item);
    if (appended.length >= CLI_APPEND_LIMIT) break;
  }
  return [...local, ...appended];
}
