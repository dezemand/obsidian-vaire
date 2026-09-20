// Pure helpers for the loose-end workbench — no `obsidian` import, so these stay
// unit-testable in plain `bun test`. This is the human UI for the entity-creation pass (see
// `vaire-entity-creation` skill): it takes `cli.unresolved`'s flat list of `[[?...]]`
// occurrences and clusters them into candidate identities for a human to resolve, create, or
// skip. Two clustering strategies are implemented side by side so they can be compared in the
// view (BRANCHES.md-style trade-off, but within one branch this time):
//
// - **exact**: groups occurrences whose normalized descriptor text *and* type hint are
//   identical. Conservative — it never merges two different type hints, so a bulk group
//   action can never accidentally resolve a `?department` occurrence to a `person` id. Its
//   blind spot is wording: "the broker thing" and "broker service thing" are, to a human,
//   obviously the same loose end, but they normalize to different strings and end up in
//   different groups.
// - **fuzzy**: single-link-clusters occurrences whose descriptor token sets are similar
//   enough (Jaccard >= threshold, stop words removed first), *without* gating on type hint.
//   This catches the wording variants exact mode misses, but because a type hint is only a
//   guess (`type_guess` — the CLI's heuristic, not an authored fact), two occurrences of the
//   "same" loose end can carry different or absent hints; fuzzy mode may therefore merge
//   occurrences with different type hints into one group. Rather than silently discard that
//   information, a group carries every distinct type hint it contains (`typeHints`, plural)
//   so the view can show it — the human deciding "Resolve to existing…" / "Create entity…"
//   sees the mix and can judge (or hit Skip) instead of the tool guessing.
//
// Both strategies feed the same `LooseEndGroup` shape and the same `filterGroups`.

import type { LooseEndItem } from '../types';

/** A small stop-word list for `tokenize` — enough to strip the connective glue in a
 *  descriptor phrase ("the broker thing" -> "broker thing") without being a real NLP
 *  pipeline. Not exhaustive; false negatives just mean a token participates in the Jaccard
 *  set instead of being dropped, which only makes fuzzy matching *more* conservative. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'from',
  'with',
  'and',
  'or',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'about',
  'into',
  'than',
  'then',
  'there',
  'here',
  'some',
  'any',
]);

/** Any character that is not a Unicode letter, digit or whitespace — the "punctuation" to
 *  strip when normalizing a descriptor. Replaced with a space (not deleted) so word
 *  boundaries survive punctuation-as-separator ("self-service" -> "self service"). */
const PUNCT_RE = /[^\p{L}\p{N}\s]+/gu;
const WHITESPACE_RE = /\s+/g;

/**
 * Normalizes a descriptor for exact-mode grouping: lowercase, trimmed, punctuation stripped
 * (replaced with a space, so word boundaries are preserved), then runs of whitespace
 * collapsed to one space. `"Someone from Logistics!"` and `"someone from logistics"` both
 * normalize to `"someone from logistics"`.
 */
export function normalizeDescriptor(descriptor: string): string {
  const lowered = descriptor.toLowerCase();
  const depunctuated = lowered.replace(PUNCT_RE, ' ');
  return depunctuated.replace(WHITESPACE_RE, ' ').trim();
}

/**
 * Splits a descriptor into a token set for fuzzy matching: `normalizeDescriptor`, split on
 * whitespace, stop words dropped. Order is not meaningful — callers compare token sets, not
 * sequences.
 */
export function tokenize(descriptor: string): string[] {
  const normalized = normalizeDescriptor(descriptor);
  if (!normalized) return [];
  return normalized.split(' ').filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/**
 * Jaccard similarity of two token sets: `|intersection| / |union|`, in `[0, 1]`. Either side
 * empty (e.g. a descriptor that normalizes to nothing but stop words) returns `0` rather than
 * treating "nothing meaningful" as a match — two unrelated loose ends that both happen to
 * strip down to nothing should not cluster together.
 */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Token-set Jaccard threshold for fuzzy grouping, per the entity-creation pass's "plausibly
 *  the same descriptor" bar. Exported so the view (and tests) don't hardcode a magic number. */
export const DEFAULT_FUZZY_THRESHOLD = 0.6;

export interface LooseEndGroup {
  /** Deterministic id for this exact cluster of occurrences (sorted `record#line` pairs,
   *  joined) — stable across re-renders as long as the underlying `unresolved` data and
   *  grouping strategy haven't changed, so the view can track per-group session state
   *  (Skip) by key instead of object identity. */
  key: string;
  /** Every distinct `type_guess` this group's occurrences carry, `null` standing for "no
   *  hint", sorted with named hints first (alphabetically) and `null` last. Exact-mode
   *  groups always have exactly one entry (type hint is part of the grouping key); a fuzzy
   *  group may have more than one — see the module doc comment. */
  typeHints: Array<string | null>;
  /** Distinct surface-form descriptors in this group, most-frequent first (ties broken by
   *  first occurrence). What `labelFor` picks its answer from. */
  descriptors: string[];
  /** `labelFor(occurrences)` — the group's display label. */
  label: string;
  count: number;
  /** Every occurrence in the group, sorted by path then line for stable display. */
  occurrences: LooseEndItem[];
}

/** The most frequent descriptor among a group's occurrences (ties broken by which one
 *  appeared first) — used as the group's label, and as the prefill for "Resolve to
 *  existing…" / "Create entity…" / `cli.suggest`. */
export function labelFor(occurrences: LooseEndItem[]): string {
  const counts = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  occurrences.forEach((item, index) => {
    counts.set(item.descriptor, (counts.get(item.descriptor) ?? 0) + 1);
    if (!firstIndex.has(item.descriptor)) firstIndex.set(item.descriptor, index);
  });

  let best: string | null = null;
  let bestCount = -1;
  let bestFirst = Infinity;
  for (const [descriptor, count] of counts) {
    const first = firstIndex.get(descriptor) ?? Infinity;
    if (count > bestCount || (count === bestCount && first < bestFirst)) {
      best = descriptor;
      bestCount = count;
      bestFirst = first;
    }
  }
  return best ?? '';
}

function distinctTypeHints(occurrences: LooseEndItem[]): Array<string | null> {
  const set = new Set(occurrences.map((item) => item.type_guess ?? null));
  const named = [...set].filter((hint): hint is string => hint !== null).sort((a, b) => a.localeCompare(b));
  return set.has(null) ? [...named, null] : named;
}

function distinctDescriptors(occurrences: LooseEndItem[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const item of occurrences) {
    if (!counts.has(item.descriptor)) order.push(item.descriptor);
    counts.set(item.descriptor, (counts.get(item.descriptor) ?? 0) + 1);
  }
  return [...order].sort((a, b) => {
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return byCount !== 0 ? byCount : order.indexOf(a) - order.indexOf(b);
  });
}

function groupKey(occurrences: LooseEndItem[]): string {
  return occurrences
    .map((item) => `${item.record}${item.line}`)
    .sort()
    .join('');
}

/** Turns raw occurrence clusters into displayable, sorted `LooseEndGroup`s. Shared by
 *  `groupExact` and `groupFuzzy` so both strategies produce the exact same group shape. */
function buildGroups(clusters: LooseEndItem[][]): LooseEndGroup[] {
  const groups = clusters.map((occurrences): LooseEndGroup => {
    const sorted = [...occurrences].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return {
      key: groupKey(sorted),
      typeHints: distinctTypeHints(sorted),
      descriptors: distinctDescriptors(sorted),
      label: labelFor(sorted),
      count: sorted.length,
      occurrences: sorted,
    };
  });
  groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return groups;
}

/**
 * Exact grouping: bucket occurrences by `(type_guess, normalizeDescriptor(descriptor))`.
 * Type hint is part of the key, so two occurrences with the same wording but different type
 * hints — including one with a hint and one without — always land in different groups.
 */
export function groupExact(items: LooseEndItem[]): LooseEndGroup[] {
  const buckets = new Map<string, LooseEndItem[]>();
  for (const item of items) {
    const key = `${item.type_guess ?? ''}\u0000${normalizeDescriptor(item.descriptor)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return buildGroups([...buckets.values()]);
}

/**
 * Fuzzy grouping: single-link-clusters occurrences by descriptor token-set Jaccard similarity
 * (>= `threshold`), via union-find over every pair. "Single-link" means transitivity through
 * a chain counts — if A matches B and B matches C, A/B/C end up in one group even if A and C
 * alone would fall under the threshold. Does not gate on type hint (see the module doc
 * comment); a resulting group's `typeHints` may therefore have more than one entry.
 */
export function groupFuzzy(items: LooseEndItem[], threshold: number): LooseEndGroup[] {
  const n = items.length;
  const tokensByIndex = items.map((item) => tokenize(item.descriptor));

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccard(tokensByIndex[i], tokensByIndex[j]) >= threshold) union(i, j);
    }
  }

  const clusters = new Map<number, LooseEndItem[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(items[i]);
    else clusters.set(root, [items[i]]);
  }
  return buildGroups([...clusters.values()]);
}

/**
 * Filters groups by an exact type-hint match (`opts.type`, matched against any of a group's
 * `typeHints`) and/or a case-insensitive substring match on the label, every descriptor
 * variant, and every occurrence's record id and path.
 */
export function filterGroups(groups: LooseEndGroup[], opts: { text?: string; type?: string } = {}): LooseEndGroup[] {
  const needle = opts.text?.trim().toLowerCase() || '';
  return groups.filter((group) => {
    if (opts.type && !group.typeHints.includes(opts.type)) return false;
    if (!needle) return true;
    const haystack = [
      group.label,
      ...group.descriptors,
      ...group.occurrences.flatMap((o) => [o.record, o.path]),
    ].map((s) => s.toLowerCase());
    return haystack.some((s) => s.includes(needle));
  });
}
