// Pure frontmatter-editing helpers for the authoring pass (Add alias / Add edge in the node
// panel) — no `obsidian` import, so these stay unit-testable in plain `bun test`. The view/
// command layer calls these inside `app.fileManager.processFrontMatter`, which hands them the
// live frontmatter object to mutate in place.
//
// Every function here is additive-only, per the contributor rules in the vaire-contributing
// and vaire-files skills: never rewrite or remove an existing value, only add one. There is
// deliberately no `removeAlias`/`removeEdge` here — see the tooltip next to the node panel's
// Edges header for why.

import { extractFrontmatterEdges } from '../ids';

export interface EditResult {
  /** Whether the frontmatter object was actually mutated (false for a no-op duplicate). */
  changed: boolean;
}

/**
 * Appends `alias` to `fm.aliases`, skipping a case-insensitive duplicate. Creates the list if
 * `aliases` is absent; upgrades a scalar `aliases: Foo` to a two-item list `[Foo, alias]` (same
 * scalar->list promotion as `addEdge`). Existing entries are never modified or reordered, only
 * appended to — so a malformed existing entry (non-string, say) is left exactly as it was.
 */
export function addAlias(fm: Record<string, unknown>, alias: string): EditResult {
  const trimmed = alias.trim();
  if (!trimmed) return { changed: false };
  const needle = trimmed.toLowerCase();

  const existing = fm.aliases;
  if (Array.isArray(existing)) {
    const isDuplicate = existing.some((a) => typeof a === 'string' && a.toLowerCase() === needle);
    if (isDuplicate) return { changed: false };
    fm.aliases = [...existing, trimmed];
    return { changed: true };
  }
  if (typeof existing === 'string') {
    if (existing.toLowerCase() === needle) return { changed: false };
    fm.aliases = [existing, trimmed];
    return { changed: true };
  }
  fm.aliases = [trimmed];
  return { changed: true };
}

/**
 * Sets/extends frontmatter key `key` to include `value` (a bare reference string, e.g.
 * `type:id` or `?type: descriptor`):
 *
 * - key absent -> set as a scalar.
 * - key holds a scalar -> upgrade to a two-item list `[old, new]`.
 * - key already a list -> append `value` (skipping an exact duplicate).
 *
 * Every other key in `fm` is left untouched. Returns whether anything changed.
 */
export function addEdge(fm: Record<string, unknown>, key: string, value: string): EditResult {
  const trimmedKey = key.trim();
  const trimmedValue = value.trim();
  if (!trimmedKey || !trimmedValue) return { changed: false };

  const existing = fm[trimmedKey];
  if (existing === undefined || existing === null) {
    fm[trimmedKey] = trimmedValue;
    return { changed: true };
  }
  if (Array.isArray(existing)) {
    const isDuplicate = existing.some((v) => v === trimmedValue);
    if (isDuplicate) return { changed: false };
    fm[trimmedKey] = [...existing, trimmedValue];
    return { changed: true };
  }
  fm[trimmedKey] = [existing, trimmedValue];
  return { changed: true };
}

export interface FrontmatterLike {
  frontmatter: Record<string, unknown>;
}

/**
 * Frontmatter keys already used as graph edges by any of `nodes` (typically every node of one
 * type in a package), deduped and sorted — backs the Add Edge modal's key datalist, so authors
 * reuse an existing field name (`participants`, `references`, …) instead of inventing a new one
 * for the same relationship. Takes plain `{ frontmatter }` objects (e.g. `LocalNode`) rather
 * than importing the `obsidian`-dependent type itself, to keep this module import-free.
 */
export function edgeKeysForType(nodes: FrontmatterLike[]): string[] {
  const keys = new Set<string>();
  for (const node of nodes) {
    for (const edge of extractFrontmatterEdges(node.frontmatter)) keys.add(edge.key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * `?<type>: <descriptor>` (or `?: <descriptor>` with no type hint) — the bare frontmatter form
 * of an unresolved reference (see the vaire-files skill: quoted by the YAML serializer for the
 * leading `?`, which `processFrontMatter` handles for us; this just builds the text itself).
 */
export function looseEndText(typeHint: string | undefined, descriptor: string): string {
  const type = typeHint?.trim() ?? '';
  return `?${type}: ${descriptor.trim()}`;
}

/** `YYYY-MM-DD` for `date` (default now), in local time — the `updated:` bump on an edit. */
export function todayIso(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
