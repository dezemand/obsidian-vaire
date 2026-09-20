// Pure parser + evaluator helpers for `vaire` query blocks — no `obsidian` import, so this
// stays unit-testable in plain `bun test` (see tests/query.test.ts). DOM-touching code
// (src/query/index.ts) and the two backends (src/query/local.ts, src/query/cli.ts) call into
// these instead of duplicating clause-matching/sorting logic. See DESIGN.md's task brief for
// the block syntax and the local/cli/auto trade-off this implements.
//
// Block grammar: one clause per line, `key: value`. Recognized keys: `type`, `where`
// (repeatable), `backlinks-to`, `refs-from`, `search`, `unresolved`, `sort`, `limit`, `show`,
// `columns`, `source`. Every clause combines with AND. A line that isn't `key: value`, or
// whose value doesn't parse for that key, is collected as an error string (1-indexed line
// number) rather than throwing — the caller renders every error at once.

import { parseRef, type VaireRef } from '../ids';

// ---- query shape -----------------------------------------------------------------------

export type WhereOp = 'eq' | 'neq' | 'exists' | 'contains';

export interface WhereClause {
  key: string;
  op: WhereOp;
  /** Absent only for `exists`. */
  value?: string;
}

export interface SortKey {
  key: string;
  dir: 'asc' | 'desc';
}

export type QueryShow = 'table' | 'list';
export type QuerySourceSetting = 'local' | 'cli' | 'auto';

export interface ParsedQuery {
  type?: string;
  where: WhereClause[];
  /** An id (`type:id`) or the literal `this`, resolved against the block's own node. */
  backlinksTo?: string;
  refsFrom?: string;
  search?: string;
  unresolved?: boolean;
  sort: SortKey[];
  limit?: number;
  show: QueryShow;
  columns?: string[];
  /** Per-block override of the `queryBlockSource` setting; `undefined` means "use the setting". */
  source?: QuerySourceSetting;
}

export function emptyQuery(): ParsedQuery {
  return { where: [], sort: [], show: 'list' };
}

// ---- parsing ----------------------------------------------------------------------------

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseBool(raw: string): boolean | null {
  const v = unquote(raw).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * One `where:` clause value, e.g. `status = active`, `owner != person:bob`, `aliases exists`,
 * `name contains reference`. Tried in an order that can't misfire on each other: `exists` and
 * `contains` are keyword-anchored, `!=` is checked before the bare `=` (which would otherwise
 * never actually match a `!=` line — the `!` sits right after the required whitespace before
 * the `=` — but checking first keeps the branches obviously independent).
 */
export function parseWhereClause(raw: string): WhereClause | null {
  const trimmed = raw.trim();
  let m = /^(\S+)\s+exists$/i.exec(trimmed);
  if (m) return { key: m[1], op: 'exists' };
  m = /^(\S+)\s*!=\s*(.+)$/.exec(trimmed);
  if (m) return { key: m[1], op: 'neq', value: unquote(m[2]) };
  m = /^(\S+)\s+contains\s+(.+)$/i.exec(trimmed);
  if (m) return { key: m[1], op: 'contains', value: unquote(m[2]) };
  m = /^(\S+)\s*=\s*(.+)$/.exec(trimmed);
  if (m) return { key: m[1], op: 'eq', value: unquote(m[2]) };
  return null;
}

/** `name | updated desc` -> `[{key:'name',dir:'asc'}, {key:'updated',dir:'desc'}]`. */
export function parseSortValue(raw: string): SortKey[] | null {
  const parts = raw
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const keys: SortKey[] = [];
  for (const part of parts) {
    const m = /^(\S+)(?:\s+(asc|desc))?$/i.exec(part);
    if (!m) return null;
    keys.push({ key: m[1], dir: (m[2]?.toLowerCase() as 'asc' | 'desc' | undefined) ?? 'asc' });
  }
  return keys;
}

export interface ParseResult {
  query: ParsedQuery;
  errors: string[];
}

export function parseQuery(text: string): ParseResult {
  const errors: string[] = [];
  const query = emptyQuery();

  text.split('\n').forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const lineNo = idx + 1;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) {
      errors.push(`line ${lineNo}: expected "key: value", got "${line}"`);
      return;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const rawValue = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'type':
        if (!rawValue) errors.push(`line ${lineNo}: "type" needs a value`);
        else query.type = unquote(rawValue);
        break;

      case 'where': {
        if (!rawValue) {
          errors.push(`line ${lineNo}: "where" needs a value`);
          break;
        }
        const clause = parseWhereClause(rawValue);
        if (!clause) errors.push(`line ${lineNo}: could not parse where clause "${rawValue}"`);
        else query.where.push(clause);
        break;
      }

      case 'backlinks-to':
        if (!rawValue) errors.push(`line ${lineNo}: "backlinks-to" needs a value`);
        else query.backlinksTo = unquote(rawValue);
        break;

      case 'refs-from':
        if (!rawValue) errors.push(`line ${lineNo}: "refs-from" needs a value`);
        else query.refsFrom = unquote(rawValue);
        break;

      case 'search':
        if (!rawValue) errors.push(`line ${lineNo}: "search" needs a value`);
        else query.search = unquote(rawValue);
        break;

      case 'unresolved': {
        const b = parseBool(rawValue);
        if (b === null) errors.push(`line ${lineNo}: "unresolved" must be true or false`);
        else query.unresolved = b;
        break;
      }

      case 'sort': {
        if (!rawValue) {
          errors.push(`line ${lineNo}: "sort" needs a value`);
          break;
        }
        const keys = parseSortValue(rawValue);
        if (!keys) errors.push(`line ${lineNo}: could not parse sort "${rawValue}"`);
        else query.sort = keys;
        break;
      }

      case 'limit': {
        const n = Number(unquote(rawValue));
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          errors.push(`line ${lineNo}: "limit" must be a positive integer`);
        } else {
          query.limit = n;
        }
        break;
      }

      case 'show': {
        const v = unquote(rawValue).toLowerCase();
        if (v !== 'table' && v !== 'list') errors.push(`line ${lineNo}: "show" must be "table" or "list"`);
        else query.show = v;
        break;
      }

      case 'columns': {
        const cols = rawValue
          .split(',')
          .map((c) => unquote(c.trim()))
          .filter(Boolean);
        if (cols.length === 0) errors.push(`line ${lineNo}: "columns" needs at least one column`);
        else query.columns = cols;
        break;
      }

      case 'source': {
        const v = unquote(rawValue).toLowerCase();
        if (v !== 'local' && v !== 'cli' && v !== 'auto') {
          errors.push(`line ${lineNo}: "source" must be local, cli, or auto`);
        } else {
          query.source = v;
        }
        break;
      }

      default:
        errors.push(`line ${lineNo}: unknown clause "${key}"`);
    }
  });

  return { query, errors };
}

// ---- `where:` matching --------------------------------------------------------------------

/** Ref values compare by full id; everything else compares as trimmed, case-insensitive text. */
function itemEquals(item: unknown, value: string): boolean {
  if (typeof item === 'string') {
    const ref = parseRef(item);
    if (ref && ref.kind === 'id') return ref.full === value.trim();
    return item.trim().toLowerCase() === value.trim().toLowerCase();
  }
  return String(item).trim().toLowerCase() === value.trim().toLowerCase();
}

function itemContains(item: unknown, value: string): boolean {
  const s = typeof item === 'string' ? item : String(item);
  return s.toLowerCase().includes(value.toLowerCase());
}

/**
 * `key = value`, `key != value`, `key exists`, `key contains value` over one node's
 * frontmatter. A list value matches `eq`/`neq`/`contains` if any element does; a ref-shaped
 * string value is compared by its full id (`ref value comparison`), never its raw text.
 */
export function matchesWhere(frontmatter: Record<string, unknown> | undefined, clause: WhereClause): boolean {
  const fm = frontmatter ?? {};
  const present = Object.prototype.hasOwnProperty.call(fm, clause.key) && fm[clause.key] != null;

  if (clause.op === 'exists') return present;
  if (!present) return clause.op === 'neq'; // a missing key satisfies "!=" (nothing equals value) but not "=" / "contains"

  const raw = fm[clause.key];
  const items = Array.isArray(raw) ? raw : [raw];
  switch (clause.op) {
    case 'eq':
      return items.some((i) => itemEquals(i, clause.value ?? ''));
    case 'neq':
      return !items.some((i) => itemEquals(i, clause.value ?? ''));
    case 'contains':
      return items.some((i) => itemContains(i, clause.value ?? ''));
    default:
      return false;
  }
}

// ---- sorting ------------------------------------------------------------------------------

/** The shape both backends produce: one row, ready to render via `createRefElement`. */
export interface QueryNode {
  ref: VaireRef;
  /** Best-known display name — used for the `name` sort key and as a fallback while the row's
   *  own link settles; the rendered link always re-resolves its own name independently. */
  name: string;
  frontmatter: Record<string, unknown>;
}

function sortValueOf(node: QueryNode, key: string): unknown {
  if (key === 'name') return node.name;
  if (key === 'type') return node.ref.kind === 'id' ? node.ref.type : node.ref.typeHint;
  return node.frontmatter[key];
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = Array.isArray(a) ? a.join(', ') : String(a);
  const bs = Array.isArray(b) ? b.join(', ') : String(b);
  return as.localeCompare(bs, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Multi-key sort (`sort: name | updated desc`): keys are applied in order, first
 * non-equal comparison wins. A missing value sorts last **regardless of direction** — `desc`
 * only reverses the ordering among the values that are actually present. Falls back to
 * `full` id for full determinism when every key ties (including the no-keys case, which
 * sorts by display name then full id).
 */
export function sortNodes<T extends QueryNode>(nodes: T[], keys: SortKey[]): T[] {
  const effectiveKeys: SortKey[] = keys.length > 0 ? keys : [{ key: 'name', dir: 'asc' }];
  return [...nodes].sort((a, b) => {
    for (const k of effectiveKeys) {
      const av = sortValueOf(a, k.key);
      const bv = sortValueOf(b, k.key);
      const aMissing = isMissing(av);
      const bMissing = isMissing(bv);
      if (aMissing && bMissing) continue;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const cmp = compareValues(av, bv);
      if (cmp !== 0) return k.dir === 'desc' ? -cmp : cmp;
    }
    const aFull = a.ref.kind === 'id' ? a.ref.full : a.ref.raw;
    const bFull = b.ref.kind === 'id' ? b.ref.full : b.ref.raw;
    return aFull.localeCompare(bFull);
  });
}

// ---- type/where/sort/limit, shared by both backends --------------------------------------

/**
 * Applies `type`/`where` (AND), then `sort`, then `limit` — everything both backends need to
 * do to their own already-gathered candidate set (per DESIGN.md's task brief: "then
 * filtered/sorted locally" for the CLI backend; the local backend's own candidate gathering
 * already applies `type` for efficiency, but running it again here is harmless).
 */
export function finalizeResults(nodes: QueryNode[], query: ParsedQuery): QueryNode[] {
  const filtered = nodes.filter((n) => {
    if (query.type) {
      if (n.ref.kind !== 'id' || n.ref.type !== query.type) return false;
    }
    return query.where.every((clause) => matchesWhere(n.frontmatter, clause));
  });
  const sorted = sortNodes(filtered, query.sort);
  return typeof query.limit === 'number' ? sorted.slice(0, query.limit) : sorted;
}

// ---- `this` resolution ---------------------------------------------------------------------

/**
 * Resolves a `backlinks-to`/`refs-from` value: the literal `this` becomes `thisFull` (the full
 * id of the node the block is written in, if any), anything else is used as-is. `null` means
 * "no target" (e.g. `this` written in a block that isn't itself inside a node) — the caller
 * should return zero matches rather than querying with an empty id.
 */
export function resolveTargetRef(value: string, thisFull: string | undefined): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'this') return thisFull ?? null;
  return trimmed || null;
}

// ---- source selection -----------------------------------------------------------------------

/**
 * `local` for a pure type/where/sort block, `cli` as soon as `search`/`refs-from`/
 * `backlinks-to`/`unresolved` appear (DESIGN.md's `auto` rule) — unless the block itself sets
 * `source:`, which always wins over the plugin-wide `queryBlockSource` setting.
 */
export function pickSource(query: ParsedQuery, setting: QuerySourceSetting): 'local' | 'cli' {
  const effective = query.source ?? setting;
  if (effective !== 'auto') return effective;
  const needsCli = Boolean(query.search || query.refsFrom || query.backlinksTo || query.unresolved);
  return needsCli ? 'cli' : 'local';
}

// ---- columns ------------------------------------------------------------------------------

export const DEFAULT_COLUMNS = ['name', 'type'];

/** The `columns:` clause, or a sensible default (`name`, `type`) when the block doesn't set one. */
export function columnsFor(query: ParsedQuery): string[] {
  return query.columns && query.columns.length > 0 ? query.columns : DEFAULT_COLUMNS;
}
