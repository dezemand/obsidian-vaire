// Vairë reference grammar — pure functions, no `obsidian` import so this stays unit-testable
// in plain `bun test`. See DESIGN.md "Reference grammar".

export interface IdRef {
  kind: 'id';
  pkg?: string;
  /** `ctype:cid` for a scoped record, e.g. `cli:vaire`. */
  scope?: string;
  type: string;
  id: string;
  /** The full address as it should be written inside `[[...]]`, including any `@pkg/` prefix. */
  full: string;
  /** `full` without the `@pkg/` prefix — what the node's own package would call it. */
  local: string;
  display?: string;
}

export interface LooseRef {
  kind: 'loose';
  typeHint?: string;
  descriptor: string;
  /** The target text as written (trimmed), e.g. `?person: someone from logistics`. */
  raw: string;
  display?: string;
}

export type VaireRef = IdRef | LooseRef;

const SLUG = '[a-z0-9][a-z0-9-]*';

// Optional `@pkg/` prefix, optional `ctype:cid/` scope prefix, then the mandatory `type:id`.
const ID_RE = new RegExp(
  `^(?:@(?<pkg>${SLUG})/)?(?:(?<stype>${SLUG}):(?<sid>${SLUG})/)?(?<type>${SLUG}):(?<id>${SLUG})$`,
);

// `?type: descriptor` or `?: descriptor`; lenient on whitespace around the descriptor.
const LOOSE_RE = /^\?\s*(?<typeHint>[a-z0-9][a-z0-9-]*)?\s*:\s*(?<descriptor>.*)$/;

/** Strips a surrounding `[[ ]]` pair if present; otherwise returns the text unchanged. */
export function parseWikilinkText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    return trimmed.slice(2, -2);
  }
  return text;
}

/**
 * Parses the inner text of a `[[...]]` wikilink (i.e. without the surrounding brackets),
 * including an optional `|display` suffix. Returns `null` for anything that is not a
 * Vairë reference — an ordinary Obsidian link, which callers should leave alone.
 */
export function parseRef(target: string): VaireRef | null {
  const pipeIdx = target.indexOf('|');
  const rawTarget = pipeIdx >= 0 ? target.slice(0, pipeIdx) : target;
  const display = pipeIdx >= 0 ? target.slice(pipeIdx + 1).trim() : undefined;
  const trimmedTarget = rawTarget.trim();
  if (!trimmedTarget) return null;

  if (trimmedTarget.startsWith('?')) {
    const looseMatch = LOOSE_RE.exec(trimmedTarget);
    if (!looseMatch) return null;
    const typeHint = looseMatch.groups?.typeHint || undefined;
    const descriptor = (looseMatch.groups?.descriptor ?? '').trim();
    return { kind: 'loose', typeHint, descriptor, raw: trimmedTarget, display };
  }

  const idMatch = ID_RE.exec(trimmedTarget);
  if (!idMatch || !idMatch.groups) return null;
  const { pkg, stype, sid, type, id } = idMatch.groups;
  const scope = stype && sid ? `${stype}:${sid}` : undefined;
  const local = scope ? `${scope}/${type}:${id}` : `${type}:${id}`;
  const full = pkg ? `@${pkg}/${local}` : local;
  return { kind: 'id', pkg, scope, type, id, full, local, display };
}

/** Renders an id ref back to `[[full]]` or `[[full|display]]`. */
export function formatRef(ref: IdRef, display?: string): string {
  return display ? `[[${ref.full}|${display}]]` : `[[${ref.full}]]`;
}

/**
 * The full local ids to try, in order, when resolving `ref` as written *inside* a node whose
 * own scope is `originScope` (its frontmatter `scope: <container-id>`, e.g. `project:atlas`) —
 * mirrors the published renderer's `resolve_address` (scope-first, then global; see
 * renderer-conventions.md §2). Only a bare reference (`ref.scope` unset, i.e. the author wrote
 * `[[type:local]]`, not `[[container-id/type:local]]`) is scope-widened: a reference that
 * already names its own scope explicitly is left as-is. This is the one place the two-step
 * rule is expressed; both `resolveLocalRef` (src/packages.ts, applied against a real
 * `LocalIndex`) and any test build the actual lookup around it.
 */
export function scopeFirstCandidates(ref: IdRef, originScope?: string): string[] {
  if (originScope && !ref.scope) {
    return [`${originScope}/${ref.type}:${ref.id}`, ref.local];
  }
  return [ref.local];
}

// Frontmatter keys that are bookkeeping, not graph edges. `superseded_by` is surfaced
// separately (the tombstone banner), so it is excluded here too.
const BOOKKEEPING_KEYS = new Set([
  'id',
  'type',
  'name',
  'aliases',
  'scope',
  'updated',
  'since',
  'superseded_by',
]);

export interface FrontmatterEdge {
  key: string;
  values: Array<VaireRef | { kind: 'text'; text: string }>;
}

/**
 * Every top-level frontmatter key whose value (or list items) parses as a Vairë id or
 * loose end. Keys with no ref-shaped value at all are dropped entirely. Order follows
 * the object's own key order (i.e. authored order, since JS preserves string-key
 * insertion order).
 */
export function extractFrontmatterEdges(
  frontmatter: Record<string, unknown> | undefined,
): FrontmatterEdge[] {
  if (!frontmatter) return [];
  const edges: FrontmatterEdge[] = [];

  for (const key of Object.keys(frontmatter)) {
    if (BOOKKEEPING_KEYS.has(key)) continue;
    const raw = frontmatter[key];
    const items = Array.isArray(raw) ? raw : [raw];
    const values: FrontmatterEdge['values'] = [];
    let hasRef = false;

    for (const item of items) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'string') {
        const parsed = parseRef(item);
        if (parsed) {
          hasRef = true;
          values.push(parsed);
          continue;
        }
        values.push({ kind: 'text', text: item });
        continue;
      }
      values.push({ kind: 'text', text: String(item) });
    }

    if (hasRef) edges.push({ key, values });
  }

  return edges;
}

/** `frontmatter.name` -> first H1 -> file basename, per the rendering conventions. */
export function displayNameFrom(
  frontmatter: Record<string, unknown> | undefined,
  firstH1: string | undefined,
  basename: string,
): string {
  const fmName = frontmatter?.name;
  if (typeof fmName === 'string' && fmName.trim()) return fmName.trim();
  if (firstH1 && firstH1.trim()) return firstH1.trim();
  return basename;
}

const OK_STATUSES = new Set(['production', 'active', 'live', 'running', 'current']);
const WARN_STATUSES = new Set([
  'decommissioning',
  'deprecated',
  'migrating',
  'draft',
  'planned',
  'proposed',
]);
const OFF_STATUSES = new Set([
  'decommissioned',
  'retired',
  'archived',
  'stopped',
  'gone',
  'superseded',
]);

/** Maps a frontmatter `status:` value to the crumb-line status dot, per the rendering conventions. */
export function statusDot(status: unknown): 'ok' | 'warn' | 'off' | null {
  if (typeof status !== 'string') return null;
  const s = status.trim().toLowerCase();
  if (OK_STATUSES.has(s)) return 'ok';
  if (WARN_STATUSES.has(s)) return 'warn';
  if (OFF_STATUSES.has(s)) return 'off';
  return null;
}

/** Whether a wikilink target (before any `|display`) looks like a Vairë reference at all. */
export function isVaireLinkTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed.includes(':') && !trimmed.startsWith('?')) return false;
  return parseRef(target) !== null;
}
