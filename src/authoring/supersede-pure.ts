// Pure logic for the supersede (tombstone) workflow — no `obsidian` import, so this stays
// unit-testable in plain `bun test`. See DESIGN.md-equivalent feature brief: superseding a
// node sets `superseded_by: <id>` on the old node (a tombstone, never a deletion), optionally
// merges its name/aliases into the successor, and optionally rewrites references to it that
// live in this package. References keep resolving through the redirect either way — rewriting
// is purely cosmetic. Removing an address later (deleting a tombstone) is a MAJOR release act
// (see the vaire-versioning skill); this module never does that.

/** The bits of a `LocalNode` (src/packages.ts) that alias-merging needs. */
export interface OldNodeAliasSource {
  name: string;
  aliases: string[];
}

/**
 * Returns the successor's new `aliases` list after folding in the old node's own `name` and
 * `aliases` — the merge offered by the "Merge aliases into the successor" checkbox. Dedupes
 * case-insensitively (first-seen casing wins) and drops anything that already equals the
 * successor's own `name`, so the successor never gets itself as an alias. Existing successor
 * aliases keep their original order and come first.
 */
export function mergeAliases(
  successorFrontmatter: Record<string, unknown>,
  oldNode: OldNodeAliasSource,
): string[] {
  const existingRaw = successorFrontmatter.aliases;
  const existing = Array.isArray(existingRaw)
    ? existingRaw.filter((a): a is string => typeof a === 'string')
    : typeof existingRaw === 'string'
      ? [existingRaw]
      : [];
  const successorName = typeof successorFrontmatter.name === 'string' ? successorFrontmatter.name.trim() : undefined;

  const seen = new Set<string>();
  const result: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (successorName && key === successorName.toLowerCase()) return;
    seen.add(key);
    result.push(trimmed);
  };

  for (const a of existing) add(a);
  add(oldNode.name);
  for (const a of oldNode.aliases) add(a);

  return result;
}

const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;

/** Rewrites every `[[old]]` / `[[old|Display]]` wikilink target on the line to `newFull`,
 *  preserving any `|Display` text verbatim. Matches only when the target (before any `|`)
 *  is *exactly* `oldFull` — so `[[@other-pkg/old]]` (a different package's node that happens
 *  to share the same type:id) and `[[old-but-longer]]` (a partial-id substring) are both left
 *  alone. */
function rewriteWikilinks(lineText: string, oldFull: string, newFull: string): string {
  return lineText.replace(WIKILINK_RE, (whole: string, inner: string) => {
    const pipeIdx = inner.indexOf('|');
    const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    if (target !== oldFull) return whole;
    const display = pipeIdx >= 0 ? inner.slice(pipeIdx) : ''; // includes the leading '|'
    return `[[${newFull}${display}]]`;
  });
}

/** `key: <value>` or `- <value>` (optionally quoted), anchored so the value must be the whole
 *  remainder of the line — this is what keeps a prose sentence that merely contains `oldFull`
 *  from being mistaken for a frontmatter scalar. */
const FRONTMATTER_KV_RE = /^(\s*[A-Za-z0-9_-]+:\s+)(['"]?)(.*?)\2\s*$/;
const FRONTMATTER_LIST_ITEM_RE = /^(\s*-\s+)(['"]?)(.*?)\2\s*$/;

/** Rewrites a frontmatter scalar or list-item line whose value is *exactly* `oldFull` (after
 *  stripping matching quotes) to `newFull`, preserving the key/indent/quote style. Leaves the
 *  line alone for any other value, including one that merely starts with or contains `oldFull`
 *  as a substring. */
function rewriteFrontmatterValue(lineText: string, oldFull: string, newFull: string): string {
  for (const re of [FRONTMATTER_KV_RE, FRONTMATTER_LIST_ITEM_RE]) {
    const match = re.exec(lineText);
    if (!match) continue;
    const [, prefix, quote, value] = match;
    if (value !== oldFull) continue;
    return `${prefix}${quote}${newFull}${quote}`;
  }
  return lineText;
}

/**
 * Rewrites one line of a vault file so every reference to `oldFull` now points at `newFull`:
 * prose wikilinks (`[[old]]`, `[[old|Display]]`) and bare frontmatter scalar/list values
 * (`key: old`, `- old`, quoted or not). A line is either shaped one way or the other — YAML
 * frontmatter never contains a `[[...]]` wikilink — so trying both in sequence is safe. Does
 * *not* touch `[[@pkg/old]]` from another package, and does not match on partial-id
 * substrings; both are exact-string comparisons against the full address, not a fuzzy find.
 * Lines with no reference to `oldFull` at all are returned unchanged.
 */
export function rewriteReference(lineText: string, oldFull: string, newFull: string): string {
  const withWikilinks = rewriteWikilinks(lineText, oldFull, newFull);
  if (withWikilinks !== lineText) return withWikilinks;
  return rewriteFrontmatterValue(lineText, oldFull, newFull);
}

export interface SupersedeSummaryInput {
  oldFull: string;
  newFull: string;
  backlinksCount: number;
  aliasesMerged: boolean;
  referencesRewritten: number;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The one-line Notice text summarizing a completed supersede action. */
export function summarizeSupersede(input: SupersedeSummaryInput): string {
  const parts = [`${input.oldFull} → ${input.newFull}`, `${plural(input.backlinksCount, 'backlink')} redirected`];
  if (input.aliasesMerged) parts.push('aliases merged');
  if (input.referencesRewritten > 0) parts.push(`${plural(input.referencesRewritten, 'reference')} rewritten`);
  return parts.join(' · ');
}

/** Today's date as `YYYY-MM-DD`, matching the `updated:` frontmatter convention — a
 *  parameter instead of `new Date()` inline so callers (and tests) can pin the clock. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
