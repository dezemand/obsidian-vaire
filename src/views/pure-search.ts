// Pure helpers for the search panel (search-view.ts) — no `obsidian` import, so these stay
// unit-testable with plain `bun test`. See DESIGN.md's search-panel feature spec.

/** One segment of highlighted text: a literal run, flagged whether it matched a query term. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits `text` into segments, marking the parts that case-insensitively match any
 * whitespace-split term from `query` as `hit: true`. Terms are matched longest-first so that
 * when one term is a substring of another (e.g. "net" inside "network"), the longer match
 * wins instead of being fragmented by the shorter one. Empty text or an empty/blank query
 * returns the whole text (if any) as a single non-hit segment.
 */
export function highlightTerms(text: string, query: string): HighlightSegment[] {
  if (!text) return [];

  const terms = [...new Set(query.split(/\s+/).map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (terms.length === 0) return [{ text, hit: false }];

  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), hit: false });
    segments.push({ text: match[0], hit: true });
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1; // guard against zero-length matches looping forever
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), hit: false });
  return segments;
}

/** Distinct `type` values across `hits`, sorted case-insensitively — for the type filter dropdown. */
export function typesInResults(hits: Array<{ type: string }>): string[] {
  return [...new Set(hits.map((h) => h.type))].sort((a, b) => a.localeCompare(b));
}

/**
 * Returns `history` with `q` (trimmed) moved to the front, deduping any earlier occurrence of
 * the same query and capping the result at `max` entries. A blank `q` leaves `history`
 * unchanged (nothing to record).
 */
export function pushHistory(history: string[], q: string, max: number): string[] {
  const trimmed = q.trim();
  if (!trimmed) return history;
  const deduped = history.filter((h) => h !== trimmed);
  return [trimmed, ...deduped].slice(0, Math.max(0, max));
}
