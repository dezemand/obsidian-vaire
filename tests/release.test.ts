import { describe, expect, test } from 'bun:test';
import { compareVersions, countsOf, describePlan, frontmatterEdgeCount, summaryHints } from '../src/release/pure';
import type { ReleasePlan } from '../src/types';

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0); // numeric, not lexicographic
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  test('tolerates a leading "v" as in a git tag', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v2.0.0', 'v1.0.0')).toBeGreaterThan(0);
  });

  test('missing/non-numeric components read as 0 rather than throwing', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('bogus', '0.0.0')).toBe(0);
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
  });

  test('sorts a changelog descending (newest first)', () => {
    const versions = ['0.2.1', '1.0.0', '0.3.0', '0.2.10'];
    const sorted = [...versions].sort((a, b) => compareVersions(b, a));
    expect(sorted).toEqual(['1.0.0', '0.3.0', '0.2.10', '0.2.1']);
  });
});

describe('countsOf', () => {
  test('counts each list, tolerant of missing fields', () => {
    const plan: ReleasePlan = { added: ['a:1', 'a:2'], changed: ['b:1'] };
    expect(countsOf(plan)).toEqual({ added: 2, changed: 1, retired: 0, removed: 0 });
  });

  test('ignores a non-array value instead of throwing', () => {
    const plan = { added: 'not-an-array' } as unknown as ReleasePlan;
    expect(countsOf(plan).added).toBe(0);
  });
});

describe('frontmatterEdgeCount', () => {
  test('array -> length, absent/non-array -> 0', () => {
    expect(frontmatterEdgeCount(['a:1', 'a:2', 'a:3'])).toBe(3);
    expect(frontmatterEdgeCount(undefined)).toBe(0);
    expect(frontmatterEdgeCount('a:1')).toBe(0); // a lone scalar, not a list
  });
});

describe('describePlan', () => {
  test('status: "nothing" -> Nothing to release', () => {
    const plan: ReleasePlan = {
      package: 'vaire',
      status: 'nothing',
      version: '0.3.0',
      outcome: { kind: 'nothing' },
      added: [],
      changed: [],
      retired: [],
      removed: [],
    };
    const described = describePlan(plan);
    expect(described.title).toBe('Nothing to release');
    expect(described.lines[0]).toContain('0.3.0');
  });

  test('outcome.kind === "nothing" is treated the same even if status is absent', () => {
    const plan: ReleasePlan = { version: '0.3.0', outcome: { kind: 'nothing' } };
    expect(describePlan(plan).title).toBe('Nothing to release');
  });

  test('status: "blocked" explains the --major gate', () => {
    const plan: ReleasePlan = {
      package: 'vaire',
      status: 'blocked',
      version: '0.3.0',
      outcome: { kind: 'bump', bump: 'major' },
      added: [],
      changed: [],
      retired: ['concept:old'],
      removed: [],
    };
    const described = describePlan(plan);
    expect(described.title).toBe('MAJOR release blocked');
    expect(described.lines.some((l) => l.includes('--major'))).toBe(true);
  });

  test('a blocked MAJOR that also needs notes says so', () => {
    const plan: ReleasePlan = { status: 'blocked', version: '1.0.0', notes_required: true };
    const described = describePlan(plan);
    expect(described.lines.some((l) => l.includes('--notes'))).toBe(true);
  });

  test('a planned minor bump reports version, bump and counts', () => {
    const plan: ReleasePlan = {
      package: 'acme-core',
      status: 'planned',
      version: '1.5.0',
      bump: 'minor',
      outcome: { kind: 'bump', bump: 'minor' },
      added: ['system:ingest'],
      changed: ['department:platform'],
      retired: [],
      removed: [],
    };
    const described = describePlan(plan);
    expect(described.title).toBe('Would release v1.5.0 · MINOR');
    expect(described.lines[0]).toBe('+1 added · ~1 changed · ↓0 retired · −0 removed');
  });

  test('a released outcome uses "Released" instead of "Would release"', () => {
    const plan: ReleasePlan = { status: 'released', version: '1.5.0', bump: 'patch' };
    expect(describePlan(plan).title).toBe('Released v1.5.0 · PATCH');
  });

  test('a first release with no prior tag reports INITIAL from outcome.kind', () => {
    const plan: ReleasePlan = { status: 'planned', version: '0.1.0', outcome: { kind: 'initial' } };
    expect(describePlan(plan).title).toBe('Would release v0.1.0 · INITIAL');
  });

  test('a planned MAJOR still owing notes says so in its lines', () => {
    const plan: ReleasePlan = {
      status: 'planned',
      version: '2.0.0',
      bump: 'major',
      outcome: { kind: 'bump', bump: 'major' },
      notes_required: true,
    };
    const described = describePlan(plan);
    expect(described.lines.some((l) => l.includes('still needs invalidated-assumptions notes'))).toBe(true);
  });

  test('a missing version falls back to "?" rather than "vundefined"', () => {
    const plan: ReleasePlan = { status: 'planned' };
    expect(describePlan(plan).title).toContain('v?');
  });
});

describe('summaryHints', () => {
  test('returns exactly three non-empty hints', () => {
    const hints = summaryHints();
    expect(hints.length).toBe(3);
    for (const hint of hints) expect(hint.trim().length).toBeGreaterThan(0);
  });
});
