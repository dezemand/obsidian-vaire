// Pure helpers for the hover-preview feature — no `obsidian` import, so these stay
// unit-testable in plain `bun test` (see tests/preview.test.ts). DOM/CLI/vault-touching code
// (preview-data.ts, hover-preview.ts) calls into these instead of duplicating string logic
// or cache bookkeeping inline. See DESIGN.md "Phase 2 ownership" (the `pure.ts` /
// `pure-ext.ts` split this branch follows) and BRANCHES.md's `feat/hover-preview` entry.

/** A frontmatter-edge value reduced to plain display text (no links) for the popover body. */
export interface PlainEdge {
  key: string;
  values: string[];
}

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^#{1,6}(?:\s|$)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

/**
 * The first paragraph of a node body, as plain text: skips leading headings (the title H1
 * included — there's no special case for it, any heading before real paragraph text is
 * skipped the same way), fenced code blocks and blank lines; bullet/numbered list items and
 * blockquote lines have their markers stripped and are folded into the paragraph they open;
 * `[[...]]` wikilinks collapse to their display text (or bare target when there is no
 * `|display`) and `**bold**`/`*italic*`/`` `code` `` markers are stripped. Truncated to
 * `maxLen` characters (default ~400) with a trailing `…`.
 */
export function firstParagraph(body: string, maxLen = 400): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const collected: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (trimmed === '') {
      if (collected.length > 0) break; // blank line ends the paragraph we were building
      continue; // still skipping leading blank lines
    }
    if (HEADING_RE.test(trimmed)) {
      if (collected.length > 0) break; // a heading ends the paragraph we were building
      continue; // skip headings before any paragraph text was found
    }

    const listMatch = LIST_ITEM_RE.exec(line);
    const quoteMatch = BLOCKQUOTE_RE.exec(trimmed);
    collected.push(listMatch ? listMatch[1] : quoteMatch ? quoteMatch[1] : trimmed);
  }

  const plain = toPlainText(collected.join(' ').trim());
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

function toPlainText(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[target|display]] -> display
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[target]] -> target
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
    .replace(/__([^_]+)__/g, '$1') // __bold__
    .replace(/\*([^*]+)\*/g, '$1') // *italic*
    .replace(/_([^_]+)_/g, '$1') // _italic_
    .replace(/`([^`]+)`/g, '$1') // `code`
    .replace(/\s+/g, ' ')
    .trim();
}

/** Frontmatter `aliases` (string or string[]) reduced to a plain string array. */
export function aliasesFrom(frontmatter: Record<string, unknown> | undefined): string[] {
  const raw = frontmatter?.aliases;
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

/** `frontmatter[key]` when it is a non-empty string, trimmed; otherwise `undefined`. */
export function scalarField(frontmatter: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = frontmatter?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ---- TTL cache (generic; used to memoize previewFor per `repo id`) -----------------------

export interface TtlCache<T> {
  /** Returns the cached value for `key` if still fresh, else calls `compute`, caches, and returns it. */
  get(key: string, compute: () => Promise<T>): Promise<T>;
  /** Drops every entry (e.g. on `index-rebuilt`). */
  clear(): void;
}

/**
 * A tiny promise-memoizing cache with a fixed TTL. `now` is injectable so behavior around
 * expiry is deterministic in tests; defaults to `Date.now`. A rejected `compute()` is evicted
 * immediately (rather than cached for the full TTL) so a transient failure doesn't wedge a key.
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now): TtlCache<T> {
  const store = new Map<string, { expires: number; promise: Promise<T> }>();

  return {
    get(key, compute) {
      const cached = store.get(key);
      const nowMs = now();
      if (cached && cached.expires > nowMs) return cached.promise;

      const promise = compute();
      store.set(key, { expires: nowMs + ttlMs, promise });
      promise.catch(() => {
        if (store.get(key)?.promise === promise) store.delete(key);
      });
      return promise;
    },
    clear() {
      store.clear();
    },
  };
}
