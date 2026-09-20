import { describe, expect, test } from 'bun:test';
import { flattenDeps, DepsModel, type DepRow } from '../src/deps';
import type { DepsResult } from '../src/types';

// Based on the acme-platform `deps` sample in DESIGN.md (acme-security resolved & satisfied,
// acme-org unlinked, nested under acme-security too), extended with a version-mismatch row and
// a generic-error row so all four `DepsModel.state()` outcomes are exercised.
const SFL_INFRASTRUCTURE_DEPS: DepsResult = {
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
          note:
            "dependency error: dependency 'acme-org' (declared by 'acme-security') is not linked — run `vaire add acme-org --link <path>` in 1.2.0",
        },
      ],
    },
    {
      name: 'acme-org',
      constraint: '^1',
      note:
        "dependency error: dependency 'acme-org' (declared by 'acme-platform') is not linked — run `vaire add acme-org --link <path>` in acme-platform",
    },
    {
      name: 'acme-ppl',
      constraint: '^1',
      version: '1.4.0',
      resolved: '../../../../.vaire/store/acme-ppl/1.4.0',
      satisfied: false,
      note: "version mismatch: 'acme-ppl' resolved to 1.4.0, which does not satisfy ^1",
    },
    {
      name: 'acme-broken',
      constraint: '^1',
      note: 'dependency error: manifest for acme-broken could not be parsed',
    },
  ],
};

const ABS_ROOT = '/home/dev/Projects/vaire-all/packages/acme-platform';

describe('flattenDeps', () => {
  const rows = flattenDeps(SFL_INFRASTRUCTURE_DEPS, ABS_ROOT);

  test('depth-first order, one row per node at every depth', () => {
    expect(rows.map((r) => r.name)).toEqual(['acme-security', 'acme-org', 'acme-org', 'acme-ppl', 'acme-broken']);
  });

  test('depth and parent are tracked through nesting', () => {
    const [isec, nestedOrg, topOrg, ppl, broken] = rows;
    expect(isec).toMatchObject({ depth: 1, parent: 'acme-platform' });
    expect(nestedOrg).toMatchObject({ depth: 2, parent: 'acme-security' });
    expect(topOrg).toMatchObject({ depth: 1, parent: 'acme-platform' });
    expect(ppl).toMatchObject({ depth: 1, parent: 'acme-platform' });
    expect(broken).toMatchObject({ depth: 1, parent: 'acme-platform' });
  });

  test('resolved is joined onto the root absRoot (not the parent), regardless of depth', () => {
    const [isec, nestedOrg] = rows;
    expect(isec.absRoot).toBe('/home/dev/.vaire/store/acme-security/1.2.0');
    // The nested acme-org has no `resolved` (it's unlinked), so no absRoot either.
    expect(nestedOrg.absRoot).toBeUndefined();
  });

  test('a row with no `satisfied` field defaults to false', () => {
    const topOrg = rows[2];
    expect(topOrg.satisfied).toBe(false);
  });
});

describe('DepsModel.state', () => {
  const rows = flattenDeps(SFL_INFRASTRUCTURE_DEPS, ABS_ROOT);
  const byName = (name: string, depth: number): DepRow => rows.find((r) => r.name === name && r.depth === depth)!;

  // state() doesn't touch `this.rows`/`this.pkg`, so a minimal stand-in package is enough —
  // no need to go through DepsModel.load (and its VaireCli) just to reach this method.
  const model = Object.create(DepsModel.prototype) as DepsModel;

  test('satisfied -> ok', () => {
    expect(model.state(byName('acme-security', 1))).toBe('ok');
  });

  test('note mentions "not linked" -> unlinked', () => {
    expect(model.state(byName('acme-org', 1))).toBe('unlinked');
    expect(model.state(byName('acme-org', 2))).toBe('unlinked');
  });

  test('unsatisfied with a version -> mismatch', () => {
    expect(model.state(byName('acme-ppl', 1))).toBe('mismatch');
  });

  test('unsatisfied, no version, other note -> error', () => {
    expect(model.state(byName('acme-broken', 1))).toBe('error');
  });
});
