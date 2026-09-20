// Pure helpers for the authoring pass (New Vairë node modal, create-entity-from-loose-end) —
// no `obsidian` import, so these stay unit-testable in plain `bun test`. See DESIGN.md-style
// conventions in ../suggest/pure.ts and ../ids.ts, which this module reuses the id grammar from
// only informally (id slugs here are validated against the same `[a-z0-9][a-z0-9-]*` shape).

/** `[a-z0-9][a-z0-9-]*` — the same slug grammar `../ids.ts` uses for `type`/`id`. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Whether `slug` is a valid id/type slug on its own (no `:`, no `/`, no `@`). */
export function validateSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

const COMBINING_MARKS_RE = /[̀-ͯ]/g;
const NON_SLUG_CHARS_RE = /[^a-z0-9]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;

/**
 * Derives a slug from a free-text name: lowercase, ASCII-fold diacritics (NFKD decompose +
 * drop combining marks), every run of non-alphanumeric characters becomes a single `-`,
 * leading/trailing `-` trimmed. Does not guarantee a non-empty or `validateSlug`-passing
 * result (e.g. a name that is entirely punctuation slugifies to `''`) — callers validate
 * separately.
 */
export function slugify(name: string): string {
  const folded = name.normalize('NFKD').replace(COMBINING_MARKS_RE, '');
  const lowered = folded.toLowerCase();
  const dashed = lowered.replace(NON_SLUG_CHARS_RE, '-');
  return dashed.replace(EDGE_DASHES_RE, '');
}

/**
 * The most common `folder` among existing nodes of a type, used to pre-fill the New Node
 * modal's folder field. Ties break alphabetically (first folder name wins); an empty input
 * (no existing nodes of that type) returns `null` so the caller falls back to
 * `folderFromPattern`.
 */
export function inferFolder(nodesOfType: Array<{ folder: string }>): string | null {
  if (nodesOfType.length === 0) return null;

  const counts = new Map<string, number>();
  for (const node of nodesOfType) {
    counts.set(node.folder, (counts.get(node.folder) ?? 0) + 1);
  }

  const sortedFolders = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  let best: string | null = null;
  let bestCount = -1;
  for (const folder of sortedFolders) {
    const count = counts.get(folder)!;
    if (count > bestCount) {
      best = folder;
      bestCount = count;
    }
  }
  return best;
}

/** Substitutes `{type}` in a folder-pattern setting (default `{type}s`) with the node's type. */
export function folderFromPattern(pattern: string, type: string): string {
  return pattern.split('{type}').join(type);
}

const YAML_SPECIAL_LEADING_RE = /^[!&*?|>%@`"'\-[\]{},:]/;
const YAML_RESERVED_WORD_RE = /^(true|false|null|yes|no|~)$/i;

/** Whether a YAML plain scalar needs double-quoting to round-trip `value` safely. */
function needsYamlQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (value.includes(': ') || value.endsWith(':')) return true;
  if (value.includes(' #')) return true;
  if (YAML_SPECIAL_LEADING_RE.test(value)) return true;
  if (YAML_RESERVED_WORD_RE.test(value)) return true;
  return false;
}

/** Renders `value` as a YAML scalar: bare when safe, double-quoted (with escaping) otherwise.
 *  Exported for reuse by `./rename-pure.ts`, which needs the same quoting rule when hand-
 *  building a tombstone's minimal frontmatter. */
export function yamlScalar(value: string): string {
  if (!needsYamlQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface BuildNodeFileInput {
  /** Bare id slug (no `type:` prefix). */
  id: string;
  type: string;
  name: string;
  /** A container id (`type:id`), when the node is scoped. */
  scope?: string;
  /** `YYYY-MM-DD`, pre-formatted by the caller. */
  today: string;
}

/**
 * Builds the full content of a new node file: frontmatter (`id`, `type`, `name`, `scope`
 * when given, `updated`) followed by a body of exactly `# <name>\n\n` — one H1 matching the
 * `name`, per the vaire-files file shape.
 */
export function buildNodeFile(input: BuildNodeFileInput): string {
  const lines = ['---', `id: ${input.id}`, `type: ${input.type}`, `name: ${yamlScalar(input.name)}`];
  if (input.scope) lines.push(`scope: ${input.scope}`);
  lines.push(`updated: ${input.today}`, '---', `# ${input.name}`, '', '');
  return lines.join('\n');
}
