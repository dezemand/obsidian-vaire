// Pure per-kind quick-fix logic for `vaire check` findings. No `obsidian` import here, so this
// stays plain-`bun test`-able like the rest of the diagnostics module. See DESIGN.md "CLI
// contract nuances" and `vaire-check-triage` (skill) for the sanctioned fix per kind — this
// module implements exactly the mechanical, additive-only subset of those fixes that can be
// applied without guessing: never invent an id, never delete a node, never silently rewrite a
// decision that needs human judgment (e.g. which duplicate to keep, whether a drifted inline
// mention is structural enough to promote to a frontmatter edge).
//
// **Finding shapes below are verified against the CLI's own source** (`vaire/src/index/check.rs`
// `Violation`/`Warning` enums, serialized `#[serde(tag = "kind", rename_all = "snake_case")]`),
// not just DESIGN.md's "CLI contract nuances" table — that table is accurate for the kinds it
// covers (`dangling_ref`, `drift`, `orphan`, `missing_dependency`) but doesn't enumerate the
// rest, and two of them are easy to get wrong by analogy: **`frontmatter_wikilink` is `{id,
// field, path}` and `unknown_type` is `{id, field, value, path}` — neither carries a `line`**
// (unlike `dangling_ref`/`drift`/`undeclared_import`, which do). `unused_dependency` is
// `{package}`, not `{name}`. The impure layer (`fixes.ts`) locates the actual edited line for
// the no-`line` kinds itself, from `field`/`value` — see `locateFrontmatterFieldLine` below.
//
// `src/diagnostics/fixes.ts` is the impure counterpart: it turns a `FixDescriptor` into an
// actual file edit / CLI call / modal flow, using these pure functions for every text
// transformation so the transformation itself stays unit-tested here.

import { parseRef } from '../ids';
import type { FindingLike } from '../views/pure-pkg';

/** One quick fix offered for a finding. `needs` documents what applying it touches — `'line'`
 * (one line of the finding's own file, via `vault.process`/the live editor), `'file'` (opens
 * something; no edit), `'manifest'` (an edit to `knowledge.toml`), or `'deps'` (a CLI
 * add/pull, which does its own indexing). Purely descriptive metadata for callers/tests; the
 * actual behavior lives in `src/diagnostics/fixes.ts`'s `applyFix`. */
export interface FixDescriptor {
  id: string;
  label: string;
  needs: 'line' | 'file' | 'manifest' | 'deps';
}

/**
 * The quick fixes offered for one `check` finding, keyed by `finding.kind` — see the table in
 * DESIGN.md's "CLI contract nuances" and the `vaire-check-triage` skill for what each kind
 * means. An unrecognized kind (including the ones this feature deliberately doesn't offer a
 * quick fix for — `unreferenceable_id`, `malformed_diagram_ref`, `scoped_type_not_permitted`,
 * each requiring judgment this feature doesn't attempt) gets no fixes: `[]`.
 *
 * `dangling_ref`'s "Create entity…" (only offered when `plugin.hooks.createNode` exists) is
 * *not* included here — it depends on runtime plugin state a pure function can't see. The
 * impure caller appends it itself; see `allFixesFor` in `fixes.ts`.
 */
export function fixesFor(finding: FindingLike): FixDescriptor[] {
  switch (finding.kind) {
    case 'dangling_ref':
      return [
        { id: 'resolve', label: 'Resolve…', needs: 'line' },
        { id: 'loose-end', label: 'Turn into loose end', needs: 'line' },
      ];
    case 'frontmatter_wikilink':
      return [{ id: 'strip-brackets', label: 'Strip brackets', needs: 'line' }];
    case 'unknown_type':
      return [{ id: 'add-type', label: 'Add type to knowledge.toml', needs: 'manifest' }];
    case 'orphan':
      return [
        { id: 'open-node', label: 'Open node', needs: 'file' },
        { id: 'find-references', label: 'Find references…', needs: 'file' },
      ];
    case 'missing_dependency':
      return [
        { id: 'link-from-catalog', label: 'Link from catalog…', needs: 'deps' },
        { id: 'pull', label: 'Pull', needs: 'deps' },
      ];
    case 'drift':
      return [
        { id: 'refresh-display', label: 'Refresh display text', needs: 'line' },
        { id: 'open-target', label: 'Open target', needs: 'file' },
      ];
    case 'unused_dependency':
      return [{ id: 'open-manifest', label: 'Open knowledge.toml', needs: 'manifest' }];
    case 'dependency_version_mismatch':
      return [{ id: 'pull', label: 'Pull', needs: 'deps' }];
    case 'undeclared_import':
      return [{ id: 'declare-dependency', label: 'Declare dependency', needs: 'deps' }];
    case 'duplicate_id':
      return [{ id: 'open-both', label: 'Open both files', needs: 'file' }];
    default:
      return [];
  }
}

// ---- line transforms -------------------------------------------------------------------

interface WikilinkOccurrence {
  start: number;
  end: number;
  inner: string;
}

const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;

function wikilinksIn(lineText: string): WikilinkOccurrence[] {
  const occurrences: WikilinkOccurrence[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(lineText))) {
    occurrences.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  return occurrences;
}

/** The `[[...]]` occurrence on `lineText` whose target (before any `|display`) parses to the
 * same full address as `to` — the reference a `dangling_ref`/`drift` finding's `to` names. */
function findRefOccurrence(lineText: string, to: string): WikilinkOccurrence | null {
  for (const occurrence of wikilinksIn(lineText)) {
    const ref = parseRef(occurrence.inner);
    if (ref?.kind === 'id' && ref.full === to) return occurrence;
  }
  return null;
}

/** `type:id` -> `id words` (hyphens to spaces) — the fallback descriptor text for
 * `toLooseEndOnLine` when the wikilink carried no `|display` to preserve instead. */
function idToWords(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .join(' ');
}

/**
 * `dangling_ref`'s "Resolve…" fix: rewrites the one `[[to]]` / `[[to|x]]` occurrence on the
 * line to point at `pickedId`, keeping the original wording (`x`, or `to` itself when there was
 * no `|display`) as the new display text — `[[to]]`/`[[to|x]]` -> `[[pickedId|x or to]]`. A
 * no-op (line returned unchanged) when `to` isn't actually referenced on this line (stale
 * finding after an intervening edit) — the caller treats "unchanged" as "nothing to apply".
 */
export function rewriteRefOnLine(lineText: string, to: string, pickedId: string): string {
  const occurrence = findRefOccurrence(lineText, to);
  if (!occurrence) return lineText;
  const ref = parseRef(occurrence.inner);
  const display = ref?.kind === 'id' && ref.display ? ref.display : to;
  const replacement = `[[${pickedId}|${display}]]`;
  return lineText.slice(0, occurrence.start) + replacement + lineText.slice(occurrence.end);
}

/**
 * `dangling_ref`'s "Turn into loose end" fix — the sanctioned "don't guess" move when the
 * target truly doesn't exist: `[[to]]` -> `[[?<type>: <id words>]]`. When the occurrence
 * carried a `|display`, that wording is preserved as the descriptor instead of the derived "id
 * words" (it's the author's own text, strictly more informative than a mangled slug). A no-op
 * when `to` isn't referenced on this line.
 */
export function toLooseEndOnLine(lineText: string, to: string): string {
  const occurrence = findRefOccurrence(lineText, to);
  if (!occurrence) return lineText;
  const ref = parseRef(to);
  if (!ref || ref.kind !== 'id') return lineText;
  const occurrenceRef = parseRef(occurrence.inner);
  const descriptor =
    occurrenceRef?.kind === 'id' && occurrenceRef.display ? occurrenceRef.display : idToWords(ref.id);
  const replacement = `[[?${ref.type}: ${descriptor}]]`;
  return lineText.slice(0, occurrence.start) + replacement + lineText.slice(occurrence.end);
}

/**
 * `drift`'s "Refresh display text" fix: if the `[[to]]`/`[[to|Display]]` occurrence on the line
 * carries a `|Display` that no longer matches `currentName` (the target's current name, looked
 * up from the local index by the caller), replaces just the display text. No-op when the
 * occurrence has no display at all, when the display already matches, or when `to` isn't
 * referenced on this line — refreshing is never inventing text, only correcting stale text that
 * was once authored.
 */
export function refreshDisplayOnLine(lineText: string, to: string, currentName: string): string {
  const occurrence = findRefOccurrence(lineText, to);
  if (!occurrence) return lineText;
  const ref = parseRef(occurrence.inner);
  if (ref?.kind !== 'id' || !ref.display || ref.display === currentName) return lineText;
  const replacement = `[[${to}|${currentName}]]`;
  return lineText.slice(0, occurrence.start) + replacement + lineText.slice(occurrence.end);
}

const BRACKETED_RE = /\[\[([^[\]]+)\]\]/;

/**
 * `frontmatter_wikilink`'s "Strip brackets" fix: unwraps the first `[[...]]` on the line,
 * quoting the bare value when it starts with `@` (a `@pkg/...` reference — YAML reserves a
 * leading `@` on a plain scalar), per the skill's `owner: department:hr` / quoted-`@pkg/...`
 * examples. A no-op when the line has no bracketed value at all.
 */
export function stripFrontmatterBrackets(lineText: string): string {
  const match = BRACKETED_RE.exec(lineText);
  if (!match) return lineText;
  const target = match[1].trim();
  const replacement = target.startsWith('@') ? `"${target}"` : target;
  return lineText.slice(0, match.index) + replacement + lineText.slice(match.index + match[0].length);
}

// ---- manifest transform ----------------------------------------------------------------

/**
 * `unknown_type`'s "Add type to knowledge.toml" fix: appends `"<type>"` to the manifest's
 * `types = [...]` array, preserving every other line (formatting, comments) verbatim — both
 * the single-line (`types = ["a", "b"]`) and the common multi-line-with-trailing-comments shape
 * (see `packages/vaire/knowledge.toml`) are handled. A no-op (text returned unchanged) when
 * `type` is already declared, or when no `types = [` array can be found at all (a manifest this
 * malformed needs a human, not a quick fix).
 */
export function addTypeToManifest(tomlText: string, type: string): string {
  const lines = tomlText.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*types\s*=\s*\[/.test(l));
  if (startIdx === -1) return tomlText;

  const quoted = [`"${type}"`, `'${type}'`];
  const startLine = lines[startIdx];

  if (startLine.includes(']')) {
    // Single-line array: `types = ["a", "b"]`, optionally with a trailing `# comment`.
    const closeIdx = startLine.indexOf(']');
    const before = startLine.slice(0, closeIdx);
    if (quoted.some((q) => before.includes(q))) return tomlText;
    const after = startLine.slice(closeIdx);
    const trimmedBefore = before.replace(/\s+$/, '');
    const hasExistingEntry = !/\[\s*$/.test(trimmedBefore);
    const insertion = hasExistingEntry ? `, "${type}"` : `"${type}"`;
    lines[startIdx] = `${trimmedBefore}${insertion}${after}`;
    return lines.join('\n');
  }

  // Multi-line array: find its closing `]` line.
  let closeIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*\]/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return tomlText;

  const body = lines.slice(startIdx + 1, closeIdx).join('\n');
  if (quoted.some((q) => body.includes(q))) return tomlText;

  let lastItemIdx = -1;
  for (let i = closeIdx - 1; i > startIdx; i--) {
    if (lines[i].trim() !== '') {
      lastItemIdx = i;
      break;
    }
  }
  const indent = lastItemIdx >= 0 ? (/^(\s*)/.exec(lines[lastItemIdx])?.[1] ?? '  ') : '  ';

  if (lastItemIdx >= 0) {
    const line = lines[lastItemIdx];
    const commentIdx = line.indexOf('#');
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : '';
    const trimmedCode = codePart.replace(/\s+$/, '');
    if (trimmedCode !== '' && !trimmedCode.endsWith(',')) {
      const pad = codePart.slice(trimmedCode.length) || ' ';
      lines[lastItemIdx] = `${trimmedCode},${pad}${commentPart}`;
    }
  }

  lines.splice(closeIdx, 0, `${indent}"${type}",`);
  return lines.join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- locating a line when the finding doesn't carry one --------------------------------

/**
 * `frontmatter_wikilink`'s (and, defensively, `unknown_type`'s) missing `line`: scans `field`
 * within the file's frontmatter block (between the first two `---` delimiter lines) for a
 * top-level `field: ...` key and returns its 1-based line number — matching `Finding.line`'s
 * own convention so the impure caller can feed it straight into the same `vault.process`/live-
 * editor line machinery it uses for kinds that do carry a `line`. Frontmatter keys in this
 * corpus are always flat scalars/arrays (see `vaire-files` skill) so a simple `^field\s*:`
 * match per line is exact, not a heuristic. Returns `null` when there's no frontmatter block,
 * no closing `---`, or no line starting with that key (the finding is stale — already fixed,
 * or the field was renamed/removed since the check ran).
 */
export function locateFrontmatterFieldLine(fileText: string, field: string): number | null {
  const lines = fileText.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const keyRe = new RegExp(`^${escapeRegExp(field)}\\s*:`);
  for (let i = 1; i < end; i++) {
    if (keyRe.test(lines[i])) return i + 1; // 1-based
  }
  return null;
}

/**
 * `unused_dependency`'s "Open knowledge.toml at the dependency line" fix: the 1-based line
 * number of `name`'s entry (`name = "^1"`, optionally trailing-commented) inside the
 * manifest's `[dependencies]` table, or `null` when the table or the entry can't be found
 * (stale finding, or a manifest shape too unusual to locate mechanically — falls back to just
 * opening the file with no line).
 */
export function findManifestDependencyLine(tomlText: string, name: string): number | null {
  const lines = tomlText.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*\[dependencies\]\s*$/.test(l));
  if (startIdx === -1) return null;

  const keyRe = new RegExp(`^\\s*${escapeRegExp(name)}\\s*=`);
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // next table — out of [dependencies]
    if (keyRe.test(lines[i])) return i + 1; // 1-based
  }
  return null;
}
