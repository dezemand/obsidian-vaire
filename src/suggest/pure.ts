// Pure helpers for the suggestions pass (`[[` autocomplete, search modal, loose-end
// resolution) — no `obsidian` import, so these stay unit-testable in plain `bun test`.
// Wikilink/loose-end scanning is line-scoped (matching how the editor and `vault.process`
// address text) and reuses the reference grammar in `../ids` rather than re-deriving it.

import { parseRef } from '../ids';

/** A `[[` autocomplete candidate, from the local index or the CLI, ready to render/insert. */
export interface Candidate {
  /** Full id, including any `@pkg/` prefix when the node lives in a dependency. */
  id: string;
  name: string;
  type: string;
  pkg?: string;
  /** `'create'` is the synthetic "Create new node…" item `VaireResolveModal` adds at the top
   *  of its suggestion list — it carries no real id (`id: ''`) and is handled specially by
   *  `onChooseSuggestion` rather than being passed to the caller's `onPick`. */
  source: 'local' | 'cli' | 'create';
  score?: number;
}

export interface TriggerMatch {
  /** Column where the query text starts, i.e. right after the triggering `[[`. */
  startCh: number;
  query: string;
}

// The text up to the cursor must end with an unterminated `[[query`: no `[`, `]`, or `|`
// inside the query. A `|` means the cursor is past the target into display text (a wikilink
// already has its target); `[`/`]` mean the `[[` isn't the nearest one, or it's already closed.
const TRIGGER_RE = /\[\[([^[\]|]*)$/;

/**
 * Whether `[[` autocomplete should fire for the text up to the cursor, and where the query
 * starts. Returns null when there is no open `[[…` at the cursor, or the query starts with
 * `?` (loose ends are typed by hand, not autocompleted).
 */
export function triggerQuery(lineUpToCursor: string): TriggerMatch | null {
  const match = TRIGGER_RE.exec(lineUpToCursor);
  if (!match) return null;
  const query = match[1];
  if (query.startsWith('?')) return null;
  return { startCh: match.index + 2, query };
}

/**
 * Merges local-index and CLI candidates, local results first, deduped by id — a CLI
 * suggestion whose id equals one already present (from the local index, or an earlier CLI
 * entry) is dropped so the live vault entry wins.
 */
export function mergeCandidates(local: Candidate[], cli: Candidate[]): Candidate[] {
  const seen = new Set(local.map((c) => c.id));
  const merged = [...local];
  for (const c of cli) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }
  return merged;
}

/** Text to insert in place of the typed `query` when a candidate is picked (no brackets). */
export function completionInsertText(id: string, name: string, insertDisplay: boolean): string {
  return insertDisplay ? `${id}|${name}` : id;
}

export interface WikilinkOccurrence {
  /** Index of the opening `[` of `[[`. */
  start: number;
  /** Index just past the closing `]]`. */
  end: number;
  /** The text between the brackets, e.g. `?person: someone from ops` or `concept:reference`. */
  inner: string;
}

const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;

/** Every `[[...]]` occurrence on a line, in left-to-right order. */
function wikilinksIn(lineText: string): WikilinkOccurrence[] {
  const occurrences: WikilinkOccurrence[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(lineText))) {
    occurrences.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  return occurrences;
}

function isLooseEnd(occurrence: WikilinkOccurrence): boolean {
  return parseRef(occurrence.inner)?.kind === 'loose';
}

function contains(occurrence: WikilinkOccurrence, ch: number): boolean {
  return ch >= occurrence.start && ch <= occurrence.end;
}

/** The `[[...]]` occurrence (of any kind — id or loose end) containing column `ch`, or null. */
export function findWikilinkAt(lineText: string, ch: number): WikilinkOccurrence | null {
  return wikilinksIn(lineText).find((o) => contains(o, ch)) ?? null;
}

/**
 * The `[[?…]]` loose-end occurrence containing column `ch`. When `ch` is exactly at the end
 * of the line, falls back to the last loose end on the line instead of requiring an exact
 * hit — the common case for a command run right after typing (or clicking) one.
 */
export function findLooseEndAt(lineText: string, ch: number): WikilinkOccurrence | null {
  const looseEnds = wikilinksIn(lineText).filter(isLooseEnd);
  const hit = looseEnds.find((o) => contains(o, ch));
  if (hit) return hit;
  if (ch === lineText.length && looseEnds.length > 0) return looseEnds[looseEnds.length - 1];
  return null;
}

/** The `[[?…]]` occurrence on a line whose descriptor matches `descriptor` (trimmed, exact). */
export function findLooseEndByDescriptor(lineText: string, descriptor: string): WikilinkOccurrence | null {
  const needle = descriptor.trim();
  for (const occurrence of wikilinksIn(lineText)) {
    const ref = parseRef(occurrence.inner);
    if (ref?.kind === 'loose' && ref.descriptor === needle) return occurrence;
  }
  return null;
}

/**
 * Rewrites exactly one loose-end occurrence to `[[<id>|<descriptor>]]`, preserving the
 * original descriptor wording verbatim — additive resolution; nothing else on the line
 * changes.
 */
export function rewriteLooseEnd(lineText: string, occurrence: WikilinkOccurrence, id: string): string {
  const ref = parseRef(occurrence.inner);
  const descriptor = ref?.kind === 'loose' ? ref.descriptor : occurrence.inner.trim();
  const replacement = `[[${id}|${descriptor}]]`;
  return lineText.slice(0, occurrence.start) + replacement + lineText.slice(occurrence.end);
}

// ---- `[[?` loose-end insertion trigger --------------------------------------------------
//
// Two phases of the same `[[?` completion flow (see DESIGN.md "Suggestions" and the
// edge-editor branch notes): while the author is still typing the type hint, offer the
// package's types to complete `[[?<type>: `; once past the `:` and typing the descriptor,
// nudge toward an existing node instead of leaving the loose end. Same "nearest unterminated
// `[[`" trick as `TRIGGER_RE` (a closed wikilink earlier on the line contains a `]` that blocks
// an earlier start position from matching through to `$`).

const LOOSE_TYPE_TRIGGER_RE = /\[\[\?([a-z0-9-]*)$/;
const LOOSE_DESCRIPTOR_TRIGGER_RE = /\[\[\?([a-z0-9][a-z0-9-]*)?:\s*([^[\]|]*)$/;

export type LooseEndTrigger = { typeQuery: string } | { typeHint?: string; descriptor: string };

/**
 * Whether `[[?` completion should fire for the text up to the cursor, and which phase: still
 * typing the type hint (`typeQuery`), or past the `:` and typing the descriptor (`typeHint` +
 * `descriptor`). Returns null when there is no open `[[?…` at the cursor at all.
 */
export function triggerLooseEnd(lineUpToCursor: string): LooseEndTrigger | null {
  const descriptorMatch = LOOSE_DESCRIPTOR_TRIGGER_RE.exec(lineUpToCursor);
  if (descriptorMatch) {
    return { typeHint: descriptorMatch[1] || undefined, descriptor: descriptorMatch[2] };
  }
  const typeMatch = LOOSE_TYPE_TRIGGER_RE.exec(lineUpToCursor);
  if (typeMatch) {
    return { typeQuery: typeMatch[1] };
  }
  return null;
}

/**
 * The package's types whose slug starts with `query` (case-insensitive), plus a trailing
 * `null` standing for "unknown type" (`?`) — always offered, regardless of `query`, since it's
 * the fallback rather than something an author searches for.
 */
export function looseEndTypeChoices(types: string[], query: string): Array<string | null> {
  const needle = query.trim().toLowerCase();
  const matches = types.filter((t) => t.toLowerCase().startsWith(needle));
  return [...matches, null];
}

/** Text to insert right after `[[?` to complete the type hint and its colon, e.g. `person: `
 *  or `: ` for `null` (unknown type) — leaves the cursor right before the closing `]]`. */
export function looseEndTypeInsertText(type: string | null): string {
  return `${type ?? ''}: `;
}

/**
 * Replacement for the `?type: descriptor` portion of a loose end (the text right after `[[`)
 * when the author picks an existing node instead of leaving it loose — the typed descriptor
 * becomes the display text, same convention as `rewriteLooseEnd`.
 */
export function looseEndExistingReplacement(id: string, descriptor: string): string {
  return `${id}|${descriptor.trim()}`;
}
