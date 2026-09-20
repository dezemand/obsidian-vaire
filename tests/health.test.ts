import { describe, expect, test } from 'bun:test';
import { assessHealth, missingFromCatalog } from '../src/health/pure';
import type { DepsResult, Sighting, StatusResult } from '../src/types';

// A healthy `status` response, shaped like the DESIGN.md "JSON shapes" sample for `status`.
const HEALTHY_STATUS: StatusResult = {
  repo: '/home/dev/Projects/vaire-all/packages/vaire',
  index_path: '.vaire/index.db',
  schema_version: 7,
  source: 'working-tree',
  last_indexed_commit: 'abc1234',
  commits_behind_head: 0,
  nodes: { total: 160, by_type: { concept: 30 } },
  edges: 2807,
  embeddings: { sections: 812, cached: 812 },
  embed_provider: 'local',
  pending_release: { since: 'v0.3.0', would_be: 'none', added: 0, changed: 0, retired: 0, removed: 0 },
};

// The DESIGN.md sample for a not-yet-built index: `status` tolerates this and exits 0, with
// `schema_version`/`source`/`last_indexed_commit` all `null` (per "CLI contract nuances").
const NOT_BUILT_STATUS: StatusResult = {
  repo: '/abs/pkg',
  index_path: '.vaire/index.db',
  schema_version: null,
  source: null,
  last_indexed_commit: null,
  commits_behind_head: 0,
  nodes: { total: 0, by_type: {} },
  edges: 0,
  embeddings: { sections: 0, cached: 0 },
};

// Reduced version of the acme-platform `deps` sample from DESIGN.md / tests/deps.test.ts:
// one satisfied dependency, one unlinked one, both directly declared (depth 1).
const DEPS_ONE_UNLINKED: DepsResult = {
  name: 'acme-platform',
  version: '1.1.0',
  dependencies: [
    {
      name: 'acme-security',
      constraint: '^1',
      version: '1.2.0',
      resolved: '../../../../.vaire/store/acme-security/1.2.0',
      satisfied: true,
    },
    {
      name: 'acme-org',
      constraint: '^1',
      note:
        "dependency error: dependency 'acme-org' (declared by 'acme-platform') is not linked — run `vaire add acme-org --link <path>` in acme-platform",
    },
  ],
};

// A dependency tree where the *only* unsatisfied row is nested (declared by a dependency, not
// by this package) — depth 2, so it should not produce an actionable health issue.
const DEPS_ONLY_TRANSITIVE_ISSUE: DepsResult = {
  name: 'acme-platform',
  version: '1.1.0',
  dependencies: [
    {
      name: 'acme-security',
      constraint: '^1',
      version: '1.2.0',
      resolved: '../../../../.vaire/store/acme-security/1.2.0',
      satisfied: true,
      dependencies: [
        {
          name: 'acme-org',
          constraint: '^1',
          note: "dependency error: dependency 'acme-org' (declared by 'acme-security') is not linked",
        },
      ],
    },
  ],
};

describe('assessHealth', () => {
  test('healthy status, no deps -> no issues', () => {
    expect(assessHealth({ status: HEALTHY_STATUS })).toEqual([]);
  });

  test('healthy status, all deps satisfied -> no issues', () => {
    const deps: DepsResult = {
      name: 'vaire',
      version: '1.0.0',
      dependencies: [{ name: 'ok-dep', constraint: '^1', version: '1.0.0', resolved: '../ok-dep', satisfied: true }],
    };
    expect(assessHealth({ status: HEALTHY_STATUS, deps })).toEqual([]);
  });

  test('nothing checked yet (no status, no deps, no statusError) -> no issues', () => {
    expect(assessHealth({})).toEqual([]);
  });

  test('schema_version null -> one index_not_built issue, other status checks skipped', () => {
    const issues = assessHealth({ status: NOT_BUILT_STATUS });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'index_not_built', severity: 'error', action: 'rebuild_index' });
  });

  test('statusError.kind === index_not_built -> one index_not_built issue', () => {
    const issues = assessHealth({ statusError: { kind: 'index_not_built', message: "no index for '/abs/pkg'" } });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('index_not_built');
  });

  test('a status error of a different kind produces no index_not_built issue', () => {
    expect(assessHealth({ statusError: { kind: 'no_repo', message: 'not a vaire repo' } })).toEqual([]);
  });

  test('commits_behind_head > 0 -> index_stale issue naming the count', () => {
    const status: StatusResult = { ...HEALTHY_STATUS, commits_behind_head: 3 };
    const issues = assessHealth({ status });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'index_stale', severity: 'warning', action: 'rebuild_index' });
    expect(issues[0].message).toContain('3');
  });

  test('pending_release.would_be !== "none" -> informational pending_release issue', () => {
    const status: StatusResult = {
      ...HEALTHY_STATUS,
      pending_release: { since: 'v0.3.0', would_be: 'minor', added: 2, changed: 1, retired: 0, removed: 0 },
    };
    const issues = assessHealth({ status });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'pending_release', severity: 'info', action: 'open_index' });
  });

  test('embeddings.cached < embeddings.sections -> informational embeddings_stale issue', () => {
    const status: StatusResult = { ...HEALTHY_STATUS, embeddings: { sections: 812, cached: 800 } };
    const issues = assessHealth({ status });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'embeddings_stale', severity: 'info', action: 'open_index' });
    expect(issues[0].message).toContain('800/812');
  });

  test('unlinked dependency -> exactly one issue naming it', () => {
    const issues = assessHealth({ deps: DEPS_ONE_UNLINKED });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'dependency',
      severity: 'warning',
      action: 'link_or_pull',
      depName: 'acme-org',
    });
    expect(issues[0].message).toContain('acme-org');
  });

  test('a transitive (depth > 1) dependency problem is not actionable here -> no issue', () => {
    expect(assessHealth({ deps: DEPS_ONLY_TRANSITIVE_ISSUE })).toEqual([]);
  });

  test('multiple simultaneous problems all surface, status issues before dependency issues', () => {
    const status: StatusResult = { ...HEALTHY_STATUS, commits_behind_head: 1 };
    const issues = assessHealth({ status, deps: DEPS_ONE_UNLINKED });
    expect(issues.map((i) => i.kind)).toEqual(['index_stale', 'dependency']);
  });

  test('deps present but status absent still derives dependency issues', () => {
    const issues = assessHealth({ deps: DEPS_ONE_UNLINKED });
    expect(issues).toHaveLength(1);
    expect(issues[0].depName).toBe('acme-org');
  });
});

describe('missingFromCatalog', () => {
  const sightings: Sighting[] = [
    { path: '/vault/pkg-a', name: 'pkg-a', version: '1.0.0', state: 'live', origin: 'scanned', last_seen: 1 },
    { path: '/elsewhere/pkg-c', name: 'pkg-c', version: '2.0.0', state: 'missing', origin: 'registered', last_seen: 1 },
  ];

  test('a vault root with no sighting at that path is missing', () => {
    expect(missingFromCatalog(['/vault/pkg-a', '/vault/pkg-b'], sightings)).toEqual(['/vault/pkg-b']);
  });

  test('a sighting counts regardless of state (missing is still "known")', () => {
    expect(missingFromCatalog(['/elsewhere/pkg-c'], sightings)).toEqual([]);
  });

  test('no vault roots -> empty', () => {
    expect(missingFromCatalog([], sightings)).toEqual([]);
  });

  test('no sightings -> every root is missing', () => {
    expect(missingFromCatalog(['/vault/pkg-a', '/vault/pkg-b'], [])).toEqual(['/vault/pkg-a', '/vault/pkg-b']);
  });
});
