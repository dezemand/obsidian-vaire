// Pure helpers for the package index view and node panel — no `obsidian` import, so these
// stay unit-testable with plain `bun test`. See DESIGN.md "§6 Package view and node panel"
// and "Rendering conventions" (package index + relations).

/** Structural shape of `LocalNode` (src/packages.ts) that the grouping/filtering logic needs. */
export interface NodeLike {
  type: string;
  id: string;
  /** Full local id, e.g. `type:id` or `scope/type:id`. */
  full: string;
  name: string;
  aliases: string[];
  supersededBy?: string;
}

export interface NodeGroup<T extends NodeLike> {
  type: string;
  count: number;
  nodes: Array<T & { gone: boolean }>;
}

/**
 * Filters `nodes` by an exact type match and/or a case-insensitive substring match on
 * id/full id/name/aliases, then groups the survivors by type and sorts each group's nodes
 * case-insensitively by display name, tie-broken by full id. Groups themselves are sorted by
 * type slug. Superseded nodes (`supersededBy` set) are flagged `gone: true` for styling, not
 * excluded.
 */
export function groupNodes<T extends NodeLike>(
  nodes: T[],
  opts: { type?: string; text?: string } = {},
): Array<NodeGroup<T>> {
  const needle = opts.text?.trim().toLowerCase() || '';
  const filtered = nodes.filter((n) => {
    if (opts.type && n.type !== opts.type) return false;
    if (!needle) return true;
    const haystack = [n.id, n.full, n.name, ...n.aliases].map((s) => s.toLowerCase());
    return haystack.some((s) => s.includes(needle));
  });

  const byType = new Map<string, T[]>();
  for (const node of filtered) {
    const list = byType.get(node.type);
    if (list) list.push(node);
    else byType.set(node.type, [node]);
  }

  const groups: Array<NodeGroup<T>> = [];
  for (const [type, list] of byType) {
    const sorted = [...list].sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (byName !== 0) return byName;
      return a.full.localeCompare(b.full);
    });
    groups.push({
      type,
      count: sorted.length,
      nodes: sorted.map((n) => ({ ...n, gone: Boolean(n.supersededBy) })),
    });
  }
  groups.sort((a, b) => a.type.localeCompare(b.type));
  return groups;
}

/** Loose shape of a `check` finding — the real shape varies by `kind` (see DESIGN.md
 * "CLI contract nuances"); `Finding` in src/types.ts pins fields that aren't actually always
 * present (a foundation-file limitation), so callers cast to this before calling. */
export interface FindingLike {
  kind: string;
  [key: string]: unknown;
}

export interface DescribedFinding {
  title: string;
  detail: string;
  path?: string;
  line?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Turns one `check` finding into a renderable `{title, detail, path?, line?}`, switching on
 * `kind` per DESIGN.md's finding-shape table instead of assuming one uniform shape.
 */
export function describeFinding(f: FindingLike): DescribedFinding {
  const path = str(f.path);
  const line = num(f.line);

  switch (f.kind) {
    case 'missing_dependency':
      return { title: `missing dependency: ${str(f.package) ?? '?'}`, detail: str(f.note) ?? '', path, line };
    case 'dangling_ref':
      return {
        title: 'dangling reference',
        detail: `${str(f.from) ?? '?'} → ${str(f.to) ?? '?'}`,
        path,
        line,
      };
    case 'drift':
      return { title: 'drift', detail: `${str(f.id) ?? '?'} → ${str(f.to) ?? '?'}`, path, line };
    case 'orphan':
      return { title: 'orphan', detail: str(f.id) ?? '?', path, line };
    default: {
      // Covers every other kind, whose real shapes (verified against the CLI's own
      // `Violation`/`Warning` enums, vaire/src/index/check.rs) vary: `unused_dependency` is
      // `{package}`; `undeclared_import` is `{package, from, to, path, line}`;
      // `frontmatter_wikilink`/`unknown_type` are `{id, field, path}`/`{id, field, value, path}`
      // (no `line`); `duplicate_id` is `{id, paths}`. Render whichever of these are present
      // instead of assuming one shape.
      const id = str(f.id) ?? str(f.from);
      const to = str(f.to);
      const field = str(f.field);
      const value = str(f.value);
      const paths = Array.isArray(f.paths) ? f.paths.filter((p): p is string => typeof p === 'string') : undefined;
      const parts = [
        id,
        to ? `→ ${to}` : undefined,
        str(f.package),
        field ? (value ? `field '${field}': '${value}'` : `field '${field}'`) : undefined,
        paths && paths.length > 0 ? `in ${paths.length} files` : undefined,
        str(f.note),
      ].filter((p): p is string => Boolean(p));
      return { title: f.kind, detail: parts.join(' '), path, line };
    }
  }
}

/**
 * The vault-relative path of `filePath` within its package: `filePath` minus `pkgDir + '/'`
 * when `pkgDir` is non-empty (matching what the CLI's `path` fields are relative to).
 */
export function packageRelativePath(filePath: string, pkgDir: string): string {
  if (!pkgDir) return filePath;
  const prefix = `${pkgDir}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

/** The inverse of `packageRelativePath`: a package-relative path back to a vault-relative one. */
export function vaultPathFor(pkgDir: string, relPath: string): string {
  return pkgDir ? `${pkgDir}/${relPath}` : relPath;
}

/** First 7 characters of a commit sha, or `''` for `null`/`undefined`/empty. */
export function shortCommit(sha: string | null | undefined): string {
  if (!sha) return '';
  return sha.slice(0, 7);
}

/**
 * Drops a leading level-1 heading (and any blank lines around it) from a README's Markdown,
 * per DESIGN.md "render it with ... text-with-leading-H1-dropped". Leaves the text alone if
 * it doesn't start with an H1 (after leading blank lines).
 */
export function dropLeadingH1(markdown: string): string {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s+\S/.test(lines[i])) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n');
  }
  return markdown;
}
