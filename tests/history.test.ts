import { describe, expect, test } from 'bun:test';
import {
  GIT_LOG_FIELD_SEP,
  describeWorkingTreeStatus,
  parseDiff,
  parseGitLog,
  relativeDate,
  releaseTouches,
} from '../src/history/pure';

// A trimmed-down fixture copied from the real corpus record
// packages/vaire/releases/0-3-0.md's frontmatter — same edge shape (scoped `cli:vaire/command:*`
// ids alongside plain `type:id` ones), just fewer entries so the fixture stays readable.
const RELEASE_0_3_0_FIXTURE: Record<string, unknown> = {
  id: '0-3-0',
  type: 'release',
  name: '0.3.0',
  aliases: ['0.3.0', 'v0.3.0'],
  date: '2026-09-14',
  bump: 'minor',
  generated_summary: true,
  added: [
    'cli:vaire/command:catalog',
    'cli:vaire/command:release',
    'component:catalog',
    'concept:release-record',
    'decision:release-records',
    'document:distribution-spec',
    'skill:vaire-release-summary',
  ],
  changed: [
    'cli:vaire',
    'cli:vaire/command:backlinks',
    'concept:dependency',
    'concept:package',
    'decision:computed-bumps',
    'document:cli-spec',
    'finding:dangling-ref',
  ],
  retired: [],
};

describe('releaseTouches', () => {
  test('finds a plain type:id under "added" (real 0-3-0 record fixture)', () => {
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'concept:release-record')).toBe('added');
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'document:distribution-spec')).toBe('added');
  });

  test('finds a scoped cli:vaire/command:* id under "added" (real edge shape)', () => {
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'cli:vaire/command:catalog')).toBe('added');
  });

  test('finds an id under "changed"', () => {
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'concept:package')).toBe('changed');
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'cli:vaire/command:backlinks')).toBe('changed');
  });

  test('an id cited nowhere returns null', () => {
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'concept:nowhere')).toBeNull();
  });

  test('an empty "retired" list is tolerated (not a match, not a throw)', () => {
    expect(releaseTouches(RELEASE_0_3_0_FIXTURE, 'concept:retired-thing')).toBeNull();
  });

  test('checks added, then changed, then retired, in that order', () => {
    const fixture = { added: ['a:1'], changed: ['a:1'], retired: ['a:1'] };
    expect(releaseTouches(fixture, 'a:1')).toBe('added');
  });

  test('handles a lone scalar edge value, not just a list', () => {
    const fixture = { changed: 'concept:solo' };
    expect(releaseTouches(fixture, 'concept:solo')).toBe('changed');
  });

  test('handles an @pkg/-qualified edge entry, matching the unqualified full id', () => {
    const fixture = { added: ['@acme/concept:widget'] };
    expect(releaseTouches(fixture, 'concept:widget')).toBe('added');
  });

  test('missing frontmatter -> null, not a throw', () => {
    expect(releaseTouches(undefined, 'concept:x')).toBeNull();
  });

  test('a non-reference string in the list is ignored, not a crash', () => {
    const fixture = { added: ['not a reference', 'concept:real'] };
    expect(releaseTouches(fixture, 'concept:real')).toBe('added');
  });
});

describe('parseGitLog', () => {
  const sep = GIT_LOG_FIELD_SEP;

  test('parses multiple commits in order', () => {
    const stdout = [
      `abc123full${sep}abc123${sep}Ada Lovelace${sep}2026-09-10T12:00:00+00:00${sep}Fix the thing`,
      `def456full${sep}def456${sep}Grace Hopper${sep}2026-09-01T08:30:00+00:00${sep}Add the other thing`,
    ].join('\n');
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: 'abc123full',
      shortHash: 'abc123',
      author: 'Ada Lovelace',
      date: '2026-09-10T12:00:00+00:00',
      subject: 'Fix the thing',
    });
    expect(entries[1].author).toBe('Grace Hopper');
  });

  test('empty stdout -> empty array', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('\n\n')).toEqual([]);
  });

  test('tolerates a trailing newline', () => {
    const stdout = `h${sep}h${sep}a${sep}2026-01-01T00:00:00+00:00${sep}subject\n`;
    expect(parseGitLog(stdout)).toHaveLength(1);
  });

  test('drops a malformed line (too few fields) instead of throwing', () => {
    const malformed = ['h', 'h', 'a', '2026-01-01T00:00:00+00:00'].join(sep); // only 4 fields, no subject
    const stdout = [malformed, `h${sep}h${sep}a${sep}2026-01-01T00:00:00+00:00${sep}ok`].join('\n');
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0].subject).toBe('ok');
  });

  test('a subject containing the field separator is reassembled rather than truncated', () => {
    const stdout = `h${sep}h${sep}a${sep}2026-01-01T00:00:00+00:00${sep}part one${sep}part two`;
    expect(parseGitLog(stdout)[0].subject).toBe(`part one${sep}part two`);
  });
});

describe('parseDiff', () => {
  const sample = [
    'commit abc123def456',
    'Author: Ada Lovelace <ada@example.com>',
    'Date:   2026-09-10T12:00:00+00:00',
    '',
    '    Fix the thing',
    '',
    ' concepts/loose-end.md | 3 ++-',
    ' 1 file changed, 2 insertions(+), 1 deletion(-)',
    '',
    'diff --git a/concepts/loose-end.md b/concepts/loose-end.md',
    'index 1111111..2222222 100644',
    '--- a/concepts/loose-end.md',
    '+++ b/concepts/loose-end.md',
    '@@ -1,3 +1,4 @@',
    ' unchanged line',
    '-removed line',
    '+added line one',
    '+added line two',
    '',
  ].join('\n');

  const lines = parseDiff(sample);

  test('classifies commit header lines as meta', () => {
    expect(lines[0]).toEqual({ kind: 'meta', text: 'commit abc123def456' });
    expect(lines[1].kind).toBe('meta');
    expect(lines[2].kind).toBe('meta');
  });

  test('a diffstat summary line with embedded +/- is context, not add/remove (leading-char rule)', () => {
    const statLine = lines.find((l) => l.text.includes('loose-end.md | 3'));
    expect(statLine?.kind).toBe('context');
  });

  test('classifies diff --git / index / file-header lines as meta', () => {
    expect(lines.find((l) => l.text.startsWith('diff --git'))?.kind).toBe('meta');
    expect(lines.find((l) => l.text.startsWith('index '))?.kind).toBe('meta');
    expect(lines.find((l) => l.text === '--- a/concepts/loose-end.md')?.kind).toBe('meta');
    expect(lines.find((l) => l.text === '+++ b/concepts/loose-end.md')?.kind).toBe('meta');
  });

  test('classifies the @@ hunk marker as hunk', () => {
    expect(lines.find((l) => l.text.startsWith('@@'))?.kind).toBe('hunk');
  });

  test('classifies content lines as add/remove/context by leading character', () => {
    expect(lines.find((l) => l.text === ' unchanged line')?.kind).toBe('context');
    expect(lines.find((l) => l.text === '-removed line')?.kind).toBe('remove');
    expect(lines.find((l) => l.text === '+added line one')?.kind).toBe('add');
    expect(lines.find((l) => l.text === '+added line two')?.kind).toBe('add');
  });

  test('drops a single trailing empty line from a trailing newline in the source', () => {
    expect(lines[lines.length - 1].text).not.toBe('');
  });

  test('empty input -> empty array', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('relativeDate', () => {
  const now = new Date('2026-09-16T12:00:00Z');

  test('a few seconds ago reads as "just now"', () => {
    expect(relativeDate('2026-09-16T11:59:50Z', now)).toBe('just now');
  });

  test('minutes ago', () => {
    expect(relativeDate('2026-09-16T11:55:00Z', now)).toBe('5 minutes ago');
  });

  test('about an hour ago', () => {
    expect(relativeDate('2026-09-16T11:00:00Z', now)).toBe('1 hour ago');
  });

  test('hours ago', () => {
    expect(relativeDate('2026-09-16T06:00:00Z', now)).toBe('6 hours ago');
  });

  test('about a day ago', () => {
    expect(relativeDate('2026-09-15T12:30:00Z', now)).toBe('1 day ago');
  });

  test('days ago', () => {
    expect(relativeDate('2026-09-10T12:00:00Z', now)).toBe('6 days ago');
  });

  test('about a month ago', () => {
    expect(relativeDate('2026-08-15T12:00:00Z', now)).toBe('1 month ago');
  });

  test('months ago', () => {
    expect(relativeDate('2026-06-16T12:00:00Z', now)).toBe('3 months ago');
  });

  test('about a year ago', () => {
    expect(relativeDate('2025-09-16T12:00:00Z', now)).toBe('1 year ago');
  });

  test('years ago', () => {
    expect(relativeDate('2022-09-16T12:00:00Z', now)).toBe('4 years ago');
  });

  test('a timestamp after "now" reads as "in the future" rather than a negative duration', () => {
    expect(relativeDate('2026-09-17T12:00:00Z', now)).toBe('in the future');
  });

  test('an unparseable date is returned unchanged', () => {
    expect(relativeDate('not-a-date', now)).toBe('not-a-date');
  });
});

describe('describeWorkingTreeStatus', () => {
  test('empty porcelain output -> null (clean)', () => {
    expect(describeWorkingTreeStatus('')).toBeNull();
    expect(describeWorkingTreeStatus('\n')).toBeNull();
  });

  test('modified, staged or not', () => {
    expect(describeWorkingTreeStatus(' M concepts/loose-end.md')).toBe('modified, not committed');
    expect(describeWorkingTreeStatus('M  concepts/loose-end.md')).toBe('modified, not committed');
  });

  test('untracked', () => {
    expect(describeWorkingTreeStatus('?? concepts/new.md')).toBe('untracked, not committed');
  });

  test('added, deleted, renamed', () => {
    expect(describeWorkingTreeStatus('A  concepts/new.md')).toBe('added, not committed');
    expect(describeWorkingTreeStatus(' D concepts/gone.md')).toBe('deleted, not committed');
    expect(describeWorkingTreeStatus('R  old.md -> new.md')).toBe('renamed, not committed');
  });
});
