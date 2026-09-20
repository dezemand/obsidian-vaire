import { describe, expect, test } from 'bun:test';
import {
  columnsFor,
  matchesWhere,
  parseQuery,
  parseSortValue,
  parseWhereClause,
  pickSource,
  resolveTargetRef,
  sortNodes,
  type ParsedQuery,
  type QueryNode,
} from '../src/query/pure';
import type { IdRef, LooseRef } from '../src/ids';

function idRef(full: string, type: string, id: string): IdRef {
  return { kind: 'id', type, id, full, local: full };
}

function node(full: string, type: string, name: string, frontmatter: Record<string, unknown> = {}): QueryNode {
  return { ref: idRef(full, type, full.split(':')[1] ?? full), name, frontmatter };
}

// ---- parseQuery -----------------------------------------------------------------------------

describe('parseQuery', () => {
  test('parses every clause from the task brief example', () => {
    const text = [
      'type: decision',
      'where: status = active',
      'backlinks-to: concept:reference',
      'refs-from: this',
      'search: "event sourcing"',
      'unresolved: true',
      'sort: name | updated desc',
      'limit: 20',
      'show: table',
      'columns: name, type, status, updated, owner',
      'source: local',
    ].join('\n');

    const { query, errors } = parseQuery(text);
    expect(errors).toEqual([]);
    expect(query.type).toBe('decision');
    expect(query.where).toEqual([{ key: 'status', op: 'eq', value: 'active' }]);
    expect(query.backlinksTo).toBe('concept:reference');
    expect(query.refsFrom).toBe('this');
    expect(query.search).toBe('event sourcing'); // quotes stripped
    expect(query.unresolved).toBe(true);
    expect(query.sort).toEqual([
      { key: 'name', dir: 'asc' },
      { key: 'updated', dir: 'desc' },
    ]);
    expect(query.limit).toBe(20);
    expect(query.show).toBe('table');
    expect(query.columns).toEqual(['name', 'type', 'status', 'updated', 'owner']);
    expect(query.source).toBe('local');
  });

  test('defaults: no where/sort clauses, show=list, source unset', () => {
    const { query, errors } = parseQuery('type: decision');
    expect(errors).toEqual([]);
    expect(query.where).toEqual([]);
    expect(query.sort).toEqual([]);
    expect(query.show).toBe('list');
    expect(query.source).toBeUndefined();
    expect(query.columns).toBeUndefined();
  });

  test('multiple where: lines all collected, AND semantics left to the evaluator', () => {
    const { query, errors } = parseQuery('where: status = active\nwhere: owner exists');
    expect(errors).toEqual([]);
    expect(query.where).toEqual([
      { key: 'status', op: 'eq', value: 'active' },
      { key: 'owner', op: 'exists' },
    ]);
  });

  test('single-quoted values are also unquoted', () => {
    const { query } = parseQuery("search: 'event sourcing'");
    expect(query.search).toBe('event sourcing');
  });

  test('blank lines and #-comments are ignored', () => {
    const { query, errors } = parseQuery('\n# a comment\ntype: decision\n\n');
    expect(errors).toEqual([]);
    expect(query.type).toBe('decision');
  });

  test('a line with no colon is a parse error', () => {
    const { errors } = parseQuery('this is not a clause');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('line 1');
  });

  test('an unknown clause key is a parse error', () => {
    const { errors } = parseQuery('frobnicate: yes');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('unknown clause "frobnicate"');
  });

  test('a malformed where: value is a parse error', () => {
    const { errors } = parseQuery('where: just some words');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('where clause');
  });

  test('an out-of-range limit is a parse error', () => {
    expect(parseQuery('limit: 0').errors.length).toBe(1);
    expect(parseQuery('limit: -3').errors.length).toBe(1);
    expect(parseQuery('limit: abc').errors.length).toBe(1);
    expect(parseQuery('limit: 3.5').errors.length).toBe(1);
  });

  test('an invalid show/source value is a parse error', () => {
    expect(parseQuery('show: grid').errors.length).toBe(1);
    expect(parseQuery('source: remote').errors.length).toBe(1);
  });

  test('an invalid unresolved value is a parse error', () => {
    expect(parseQuery('unresolved: yes').errors.length).toBe(1);
  });

  test('several bad lines each produce their own error, in line order', () => {
    const { errors } = parseQuery('bogus\ntype: decision\nlimit: nope');
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('line 1');
    expect(errors[1]).toContain('line 3');
  });
});

describe('parseWhereClause / parseSortValue', () => {
  test('recognizes =, !=, exists, contains', () => {
    expect(parseWhereClause('status = active')).toEqual({ key: 'status', op: 'eq', value: 'active' });
    expect(parseWhereClause('status != active')).toEqual({ key: 'status', op: 'neq', value: 'active' });
    expect(parseWhereClause('owner exists')).toEqual({ key: 'owner', op: 'exists' });
    expect(parseWhereClause('name contains reference')).toEqual({
      key: 'name',
      op: 'contains',
      value: 'reference',
    });
  });

  test('unparseable where text returns null', () => {
    expect(parseWhereClause('just some words')).toBeNull();
  });

  test('sort keys default to asc, "desc" is case-insensitive', () => {
    expect(parseSortValue('name | updated desc | score DESC')).toEqual([
      { key: 'name', dir: 'asc' },
      { key: 'updated', dir: 'desc' },
      { key: 'score', dir: 'desc' },
    ]);
  });
});

// ---- matchesWhere -----------------------------------------------------------------------------

describe('matchesWhere', () => {
  test('eq / neq on a plain scalar', () => {
    expect(matchesWhere({ status: 'active' }, { key: 'status', op: 'eq', value: 'active' })).toBe(true);
    expect(matchesWhere({ status: 'active' }, { key: 'status', op: 'eq', value: 'Active' })).toBe(true); // case-insensitive
    expect(matchesWhere({ status: 'draft' }, { key: 'status', op: 'eq', value: 'active' })).toBe(false);
    expect(matchesWhere({ status: 'draft' }, { key: 'status', op: 'neq', value: 'active' })).toBe(true);
  });

  test('a missing key: != is true, = and contains are false, exists is false', () => {
    expect(matchesWhere({}, { key: 'owner', op: 'neq', value: 'anyone' })).toBe(true);
    expect(matchesWhere({}, { key: 'owner', op: 'eq', value: 'anyone' })).toBe(false);
    expect(matchesWhere({}, { key: 'owner', op: 'contains', value: 'any' })).toBe(false);
    expect(matchesWhere({}, { key: 'owner', op: 'exists' })).toBe(false);
  });

  test('exists is true for any present, non-null value including an empty list', () => {
    expect(matchesWhere({ tags: [] }, { key: 'tags', op: 'exists' })).toBe(true);
    expect(matchesWhere({ tags: null }, { key: 'tags', op: 'exists' })).toBe(false);
  });

  test('a list value matches eq/neq/contains if any element does', () => {
    const fm = { related: ['concept:a', 'concept:b'] };
    expect(matchesWhere(fm, { key: 'related', op: 'eq', value: 'concept:b' })).toBe(true);
    expect(matchesWhere(fm, { key: 'related', op: 'eq', value: 'concept:c' })).toBe(false);
    expect(matchesWhere(fm, { key: 'related', op: 'neq', value: 'concept:c' })).toBe(true);
    expect(matchesWhere({ tags: ['alpha', 'beta'] }, { key: 'tags', op: 'contains', value: 'et' })).toBe(true);
  });

  test('a ref-shaped value compares by its full id, not its raw text', () => {
    // `owner` is a scoped/external-looking ref; comparing against the same full id matches
    // even though the raw string carries a `@pkg/` prefix a plain string compare wouldn't expect.
    const fm = { owner: '@acme-security/person:alice' };
    expect(matchesWhere(fm, { key: 'owner', op: 'eq', value: '@acme-security/person:alice' })).toBe(true);
    expect(matchesWhere(fm, { key: 'owner', op: 'eq', value: 'person:alice' })).toBe(false);
  });

  test('contains is a case-insensitive substring test', () => {
    expect(matchesWhere({ name: 'Event Sourcing' }, { key: 'name', op: 'contains', value: 'sourcing' })).toBe(true);
    expect(matchesWhere({ name: 'Event Sourcing' }, { key: 'name', op: 'contains', value: 'nope' })).toBe(false);
  });
});

// ---- sortNodes ----------------------------------------------------------------------------

describe('sortNodes', () => {
  test('no sort keys: falls back to name, then full id', () => {
    const nodes = [node('decision:b', 'decision', 'Bravo'), node('decision:a', 'decision', 'Alpha')];
    expect(sortNodes(nodes, []).map((n) => n.name)).toEqual(['Alpha', 'Bravo']);
  });

  test('a single ascending key', () => {
    const nodes = [
      node('decision:a', 'decision', 'A', { updated: '2024-01-01' }),
      node('decision:b', 'decision', 'B', { updated: '2023-01-01' }),
    ];
    expect(sortNodes(nodes, [{ key: 'updated', dir: 'asc' }]).map((n) => n.name)).toEqual(['B', 'A']);
  });

  test('desc reverses the direction', () => {
    const nodes = [
      node('decision:a', 'decision', 'A', { updated: '2024-01-01' }),
      node('decision:b', 'decision', 'B', { updated: '2023-01-01' }),
    ];
    expect(sortNodes(nodes, [{ key: 'updated', dir: 'desc' }]).map((n) => n.name)).toEqual(['A', 'B']);
  });

  test('multiple keys: the first tie-breaks into the second', () => {
    const nodes = [
      node('decision:a', 'decision', 'A', { status: 'active', updated: '2024-01-01' }),
      node('decision:b', 'decision', 'B', { status: 'active', updated: '2023-01-01' }),
      node('decision:c', 'decision', 'C', { status: 'draft', updated: '2025-01-01' }),
    ];
    const sorted = sortNodes(nodes, [
      { key: 'status', dir: 'asc' },
      { key: 'updated', dir: 'desc' },
    ]);
    expect(sorted.map((n) => n.name)).toEqual(['A', 'B', 'C']); // active(A,B by updated desc), then draft(C)
  });

  test('missing values sort last regardless of direction', () => {
    const nodes = [
      node('decision:a', 'decision', 'A', { updated: '2024-01-01' }),
      node('decision:b', 'decision', 'B', {}), // no `updated`
      node('decision:c', 'decision', 'C', { updated: '2023-01-01' }),
    ];
    expect(sortNodes(nodes, [{ key: 'updated', dir: 'asc' }]).map((n) => n.name)).toEqual(['C', 'A', 'B']);
    expect(sortNodes(nodes, [{ key: 'updated', dir: 'desc' }]).map((n) => n.name)).toEqual(['A', 'C', 'B']);
  });

  test('numeric values sort numerically, not lexicographically', () => {
    const nodes = [
      node('decision:a', 'decision', 'A', { score: 9 }),
      node('decision:b', 'decision', 'B', { score: 10 }),
      node('decision:c', 'decision', 'C', { score: 2 }),
    ];
    expect(sortNodes(nodes, [{ key: 'score', dir: 'asc' }]).map((n) => n.name)).toEqual(['C', 'A', 'B']);
  });

  test('sorting by "name" and "type" reads the ref, not frontmatter', () => {
    const looseNode: QueryNode = {
      ref: { kind: 'loose', typeHint: 'person', descriptor: 'someone', raw: '?person: someone' } as LooseRef,
      name: 'someone',
      frontmatter: {},
    };
    const idNode = node('person:alice', 'person', 'Alice');
    const sorted = sortNodes([looseNode, idNode], [{ key: 'name', dir: 'asc' }]);
    expect(sorted.map((n) => n.name)).toEqual(['Alice', 'someone']);
  });
});

// ---- pickSource -----------------------------------------------------------------------------

describe('pickSource', () => {
  const base: ParsedQuery = { where: [], sort: [], show: 'list' };

  test('a pure type/where/sort block: local under every setting except an explicit cli setting', () => {
    const q: ParsedQuery = { ...base, type: 'decision', where: [{ key: 'status', op: 'eq', value: 'active' }] };
    expect(pickSource(q, 'auto')).toBe('local');
    expect(pickSource(q, 'local')).toBe('local');
    expect(pickSource(q, 'cli')).toBe('cli');
  });

  test('auto picks cli as soon as search/refs-from/backlinks-to/unresolved appear', () => {
    expect(pickSource({ ...base, search: 'x' }, 'auto')).toBe('cli');
    expect(pickSource({ ...base, refsFrom: 'this' }, 'auto')).toBe('cli');
    expect(pickSource({ ...base, backlinksTo: 'concept:a' }, 'auto')).toBe('cli');
    expect(pickSource({ ...base, unresolved: true }, 'auto')).toBe('cli');
  });

  test("a block's own source: clause always wins over the setting", () => {
    const q: ParsedQuery = { ...base, search: 'x', source: 'local' };
    expect(pickSource(q, 'cli')).toBe('local');
    expect(pickSource(q, 'auto')).toBe('local');
  });
});

// ---- resolveTargetRef -----------------------------------------------------------------------

describe('resolveTargetRef', () => {
  test('"this" resolves to the block\'s own node id', () => {
    expect(resolveTargetRef('this', 'decision:x')).toBe('decision:x');
    expect(resolveTargetRef('This', 'decision:x')).toBe('decision:x'); // case-insensitive
  });

  test('"this" with no containing node resolves to null', () => {
    expect(resolveTargetRef('this', undefined)).toBeNull();
  });

  test('any other value passes through unchanged', () => {
    expect(resolveTargetRef('concept:reference', 'decision:x')).toBe('concept:reference');
  });
});

// ---- columnsFor -----------------------------------------------------------------------------

describe('columnsFor', () => {
  test('defaults to name, type when the block sets no columns', () => {
    expect(columnsFor({ where: [], sort: [], show: 'table' })).toEqual(['name', 'type']);
  });

  test('uses the block\'s own columns when given', () => {
    const q: ParsedQuery = { where: [], sort: [], show: 'table', columns: ['name', 'owner'] };
    expect(columnsFor(q)).toEqual(['name', 'owner']);
  });
});
