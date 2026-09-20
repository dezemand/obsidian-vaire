// Pure helpers for backlink context: locating the `[[…]]` hit in a referencing line, grouping
// backlink rows by the node that made them, and filtering by search text. No `obsidian` import,
// so this stays unit-testable with plain `bun test`. See BRANCHES.md "feat/backlinks-context"
// and DESIGN.md "§6 Package view and node panel" / "Relations (NodeView) — Backlinks ←".

import { parseRef } from '../ids';

const MAX_SNIPPET_LEN = 160;
// `[^\]]` (rather than `[^[\]]`) deliberately tolerates a stray `]` inside a malformed display
// text without losing the match entirely — good enough for a read-only snippet.
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export interface LineSnippet {
  before: string;
  /** The matched `[[...]]` (brackets included), or `null` when nothing in the line resolves to the target id. */
  hit: string | null;
  after: string;
}

/**
 * One backlink row enriched with the referencing line's context and the referencing node's
 * display name. Produced by `loadBacklinkContexts` (src/views/backlinks-data.ts); this module
 * only consumes the shape, so it stays free of `obsidian`/`fs` imports.
 */
export interface BacklinkContext {
  /** The referencing node's own id (package-local — never carries an `@pkg/` prefix). */
  id: string;
  type: string;
  /** Relative to `path`'s own package root (the referencing file's package, per `package`). */
  path: string;
  /** Set when the referencing file lives in a dependency package, not the backlinked node's own. */
  package?: string;
  /** `"inline"` for a prose reference, otherwise the frontmatter key that declared the edge. */
  ref_type: string;
  /** 1-based, as reported by `vaire backlinks`. */
  line: number;
  /** Best-effort display name of the referencing node (falls back to `id`). */
  name: string;
  snippet: LineSnippet | null;
}

function capLine(s: string): string {
  return s.length <= MAX_SNIPPET_LEN ? s : `${s.slice(0, MAX_SNIPPET_LEN - 1)}…`;
}

/**
 * Trims `before`/`after` context around an already-located `hit` so the whole snippet stays
 * within `MAX_SNIPPET_LEN` characters, keeping `hit` intact and splitting the remaining budget
 * evenly (preferring `before` by one character on an odd split).
 */
function capAroundHit(before: string, hit: string, after: string): { before: string; after: string } {
  const budget = MAX_SNIPPET_LEN - hit.length;
  if (budget <= 0) return { before: '', after: '' };
  if (before.length + after.length <= budget) return { before, after };

  let beforeBudget = Math.min(before.length, Math.ceil(budget / 2));
  const afterBudget = Math.min(after.length, budget - beforeBudget);
  beforeBudget = Math.min(before.length, budget - afterBudget);

  const cappedBefore = before.length <= beforeBudget ? before : `…${before.slice(before.length - beforeBudget + 1)}`;
  const cappedAfter = after.length <= afterBudget ? after : `${after.slice(0, Math.max(0, afterBudget - 1))}…`;
  return { before: cappedBefore, after: cappedAfter };
}

/**
 * Locates, within `lineText`, the `[[...]]` wikilink whose parsed target (before any `|display`,
 * comparing both the parsed ref's `local` and `full` so a cross-package `@pkg/...` link written
 * from a dependency resolves too) matches `targetId`, and splits the trimmed line around it
 * (`before`/`hit`/`after`), capped to `MAX_SNIPPET_LEN` characters total.
 *
 * Returns `null` only when `lineText` is blank. When no link in the line resolves to `targetId`
 * — notably a frontmatter flow-list line such as `documented_in: [document:design-spec, …]`,
 * which carries bare ids with no `[[...]]` syntax at all — returns the trimmed/capped line as
 * `before` with `hit: null`, so the caller still has something to show.
 */
export function snippetForLine(lineText: string, targetId: string): LineSnippet | null {
  const trimmed = lineText.trim();
  if (!trimmed) return null;

  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(trimmed)) !== null) {
    const inner = match[1];
    const pipeIdx = inner.indexOf('|');
    const targetText = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    const ref = parseRef(targetText);
    if (ref && ref.kind === 'id' && (ref.local === targetId || ref.full === targetId)) {
      const hit = match[0];
      const before = trimmed.slice(0, match.index);
      const after = trimmed.slice(match.index + hit.length);
      const capped = capAroundHit(before, hit, after);
      return { before: capped.before, hit, after: capped.after };
    }
  }

  return { before: capLine(trimmed), hit: null, after: '' };
}

/** One group of `groupByNode`'s result: every context row from the same referencing node. */
export interface NodeGroup {
  id: string;
  type: string;
  path: string;
  package?: string;
  name: string;
  count: number;
  rows: BacklinkContext[];
}

/**
 * Groups backlink contexts by the referencing node (`package ?? ''` plus `id`, so a same-named
 * id in a different package is never merged), sorted by name (case-insensitive, tie-broken by
 * id) with each group's own rows sorted by line number.
 */
export function groupByNode(contexts: BacklinkContext[]): NodeGroup[] {
  const groups = new Map<string, NodeGroup>();
  for (const ctx of contexts) {
    const key = `${ctx.package ?? ''}\u0000${ctx.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { id: ctx.id, type: ctx.type, path: ctx.path, package: ctx.package, name: ctx.name, count: 0, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(ctx);
    group.count++;
  }

  const result = [...groups.values()];
  for (const group of result) group.rows.sort((a, b) => a.line - b.line);
  result.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
  return result;
}

/**
 * Case-insensitive substring filter over backlink contexts: matches the referencing node's
 * name/id/type/path, the ref_type badge, or the snippet text (hit + surrounding context).
 */
export function filterContexts(contexts: BacklinkContext[], query: string): BacklinkContext[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return contexts;
  return contexts.filter((ctx) => {
    const snippetText = ctx.snippet ? `${ctx.snippet.before} ${ctx.snippet.hit ?? ''} ${ctx.snippet.after}` : '';
    const haystack = [ctx.name, ctx.id, ctx.type, ctx.ref_type, ctx.path, snippetText].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}
