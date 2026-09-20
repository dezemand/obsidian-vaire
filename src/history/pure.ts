// Pure helpers for the node panel's History section (BRANCHES.md `feat/node-history`): matching
// a release record's frontmatter edges against a node's full id (the "releases" source), parsing
// `git log`/`git show`/`git status` output (the "git" source), and a relative-date formatter
// shared by both. No `obsidian` import, so these stay unit-testable with plain `bun test` — see
// tests/history.test.ts. Mirrors the pattern of src/release/pure.ts and src/views/pure-backlinks.ts:
// the UI in section.ts/diff-modal.ts and the adapter in git.ts are thin, mostly-untested shells
// around these functions.

import { parseRef } from '../ids';

// ---- Releases source: release-record edge matching ----------------------------------------

export type ReleaseTouchKind = 'added' | 'changed' | 'retired';

const TOUCH_KEYS: ReleaseTouchKind[] = ['added', 'changed', 'retired'];

/** Does one frontmatter edge value (a scalar or a list item) refer to `fullId`? A plain string
 *  match handles the common case cheaply; otherwise the value is parsed as a Vairë reference so
 *  an `@pkg/`-qualified entry (`ref.full`) or its unqualified form (`ref.local`) both compare
 *  against `fullId` — a release record only ever lists ids as bare strings (see
 *  concepts/release-record.md), but a qualified form is tolerated either way. */
function refMatches(value: unknown, fullId: string): boolean {
  if (typeof value !== 'string') return false;
  if (value === fullId) return true;
  const ref = parseRef(value);
  if (!ref || ref.kind !== 'id') return false;
  return ref.full === fullId || ref.local === fullId;
}

/**
 * Whether a release record's frontmatter (`added`/`changed`/`retired`) cites `fullId` — this
 * package's own full local id, e.g. `concept:reference` or a scoped `cli:vaire/command:refs` —
 * and under which edge, checked in that fixed order. A record's classifier only ever places one
 * id under one of the three edges, but the order is checked deterministically regardless.
 * Tolerant of a missing frontmatter object, a missing/non-array edge (treated as empty), and a
 * single scalar value instead of a one-element list. Returns `null` when none of the three edges
 * cite `fullId` at all.
 */
export function releaseTouches(
  releaseFrontmatter: Record<string, unknown> | undefined,
  fullId: string,
): ReleaseTouchKind | null {
  if (!releaseFrontmatter) return null;
  for (const key of TOUCH_KEYS) {
    const raw = releaseFrontmatter[key];
    const items = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    if (items.some((item) => refMatches(item, fullId))) return key;
  }
  return null;
}

// ---- Git source: `git log` / `git show` / `git status` parsing -----------------------------

/** One `git log --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s` entry. */
export interface GitLogEntry {
  /** Full commit sha (%H). */
  hash: string;
  /** Abbreviated sha (%h), shown in the row. */
  shortHash: string;
  /** Author name (%an). */
  author: string;
  /** Author date, strict ISO 8601 (%aI) — what `relativeDate` and the diff modal's header read. */
  date: string;
  /** Commit subject line (%s). */
  subject: string;
}

/** The field separator `--format` is built with (ASCII unit separator, 0x1F) — chosen because it
 *  can't appear in a commit subject the way `:`/`,`/`|` sometimes do. Exported so `git.ts` builds
 *  the exact `--format` string this parser expects, in one place. */
export const GIT_LOG_FIELD_SEP = '\x1f';

/**
 * Parses `git log --format=%H<sep>%h<sep>%an<sep>%aI<sep>%s` output (one commit per line) into
 * `GitLogEntry[]`, oldest-line-tolerant: blank lines are skipped, a line with too few fields is
 * dropped rather than throwing, and a subject that happens to contain the separator is
 * reassembled (defensive — %s shouldn't produce one, but the parser doesn't assume it can't).
 */
export function parseGitLog(stdout: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split(GIT_LOG_FIELD_SEP);
    if (parts.length < 5) continue;
    const [hash, shortHash, author, date, ...subjectParts] = parts;
    entries.push({ hash, shortHash, author, date, subject: subjectParts.join(GIT_LOG_FIELD_SEP) });
  }
  return entries;
}

export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const META_PREFIXES = [
  'diff --git',
  'index ',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files',
  'commit ',
  'Author:',
  'Date:',
  'Merge:',
];

function classifyDiffLine(line: string): DiffLineKind {
  // File headers (`--- a/x`, `+++ b/x`) start with the same characters as add/remove lines —
  // check them first so they're never misclassified as content.
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/**
 * Splits `git show --stat --format=... <hash> -- <file>` output (commit header + stat summary +
 * unified diff, in that order) into per-line `{kind, text}` records for coloring in a `pre`
 * block: `add`/`remove` for `+`/`-` content lines, `hunk` for an `@@ ... @@` marker, `meta` for
 * everything else recognizable as ceremony (commit/author/date header, `diff --git`, file-mode
 * lines, the `--- a/x`/`+++ b/x` file headers), and `context` for unified-diff context lines and
 * the stat summary (` file.md | 3 +--` legitimately contains `+`/`-` mid-line, which is exactly
 * why those characters are only classified by *leading* character, not by presence). A single
 * trailing empty line from a trailing `\n` in the source text is dropped so it doesn't render an
 * extra blank row.
 */
export function parseDiff(text: string): DiffLine[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => ({ kind: classifyDiffLine(line), text: line }));
}

/** A short, stable label for `git status --porcelain -- <file>` output on a single path, or
 *  `null` when the file has no uncommitted changes (empty output — the porcelain command was
 *  already scoped to one path). Only the first non-blank line is read since `-- <file>` already
 *  limits the command to at most one entry (a rename shows as a single `R  old -> new` line). */
export function describeWorkingTreeStatus(porcelain: string): string | null {
  const line = porcelain.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const code = line.slice(0, 2);
  if (code.includes('?')) return 'untracked, not committed';
  if (code.includes('A')) return 'added, not committed';
  if (code.includes('D')) return 'deleted, not committed';
  if (code.includes('R')) return 'renamed, not committed';
  if (code.includes('M')) return 'modified, not committed';
  return 'changed, not committed';
}

// ---- Relative dates -------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * A short, GitHub-style relative date ("3 days ago", "just now") for a commit's author date
 * (`%aI`, strict ISO 8601). `now` defaults to the real current time but is a parameter so tests
 * stay deterministic. An unparseable `iso` is returned unchanged rather than throwing; a
 * timestamp after `now` (clock skew) reads as "in the future" rather than a nonsensical negative
 * duration.
 */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const diffSec = Math.round((now.getTime() - then.getTime()) / 1000);
  if (diffSec < 0) return 'in the future';
  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 minute ago';
  if (diffSec < 45 * MINUTE) return `${Math.round(diffSec / MINUTE)} minutes ago`;
  if (diffSec < 90 * MINUTE) return '1 hour ago';
  if (diffSec < 22 * HOUR) return `${Math.round(diffSec / HOUR)} hours ago`;
  if (diffSec < 36 * HOUR) return '1 day ago';
  if (diffSec < 25 * DAY) return `${Math.round(diffSec / DAY)} days ago`;
  if (diffSec < 45 * DAY) return '1 month ago';
  if (diffSec < 320 * DAY) return `${Math.round(diffSec / MONTH)} months ago`;
  if (diffSec < 548 * DAY) return '1 year ago';
  return `${Math.round(diffSec / YEAR)} years ago`;
}
