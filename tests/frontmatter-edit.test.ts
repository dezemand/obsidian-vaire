import { describe, expect, test } from 'bun:test';
import { addAlias, addEdge, edgeKeysForType, looseEndText, todayIso } from '../src/authoring/frontmatter-edit';

describe('addAlias', () => {
  test('creates the list when aliases is absent', () => {
    const fm: Record<string, unknown> = { id: 'x', type: 'concept' };
    const result = addAlias(fm, 'New alias');
    expect(result.changed).toBe(true);
    expect(fm.aliases).toEqual(['New alias']);
  });

  test('appends to an existing list', () => {
    const fm: Record<string, unknown> = { aliases: ['Foo'] };
    const result = addAlias(fm, 'Bar');
    expect(result.changed).toBe(true);
    expect(fm.aliases).toEqual(['Foo', 'Bar']);
  });

  test('upgrades a scalar aliases value to a list', () => {
    const fm: Record<string, unknown> = { aliases: 'Foo' };
    const result = addAlias(fm, 'Bar');
    expect(result.changed).toBe(true);
    expect(fm.aliases).toEqual(['Foo', 'Bar']);
  });

  test('skips a case-insensitive duplicate in a list', () => {
    const fm: Record<string, unknown> = { aliases: ['Foo', 'Bar'] };
    const result = addAlias(fm, 'foo');
    expect(result.changed).toBe(false);
    expect(fm.aliases).toEqual(['Foo', 'Bar']);
  });

  test('skips a case-insensitive duplicate against a scalar', () => {
    const fm: Record<string, unknown> = { aliases: 'FOO' };
    const result = addAlias(fm, 'foo');
    expect(result.changed).toBe(false);
    expect(fm.aliases).toBe('FOO');
  });

  test('trims whitespace before comparing/storing', () => {
    const fm: Record<string, unknown> = { aliases: ['Foo'] };
    const result = addAlias(fm, '  Bar  ');
    expect(result.changed).toBe(true);
    expect(fm.aliases).toEqual(['Foo', 'Bar']);
  });

  test('a blank alias is a no-op', () => {
    const fm: Record<string, unknown> = { aliases: ['Foo'] };
    const result = addAlias(fm, '   ');
    expect(result.changed).toBe(false);
    expect(fm.aliases).toEqual(['Foo']);
  });

  test('never mutates unrelated keys', () => {
    const fm: Record<string, unknown> = { id: 'x', type: 'concept', status: 'active', aliases: ['Foo'] };
    addAlias(fm, 'Bar');
    expect(fm.id).toBe('x');
    expect(fm.type).toBe('concept');
    expect(fm.status).toBe('active');
  });

  test('preserves key order — aliases created fresh lands at the end, not reordered later', () => {
    const fm: Record<string, unknown> = { id: 'x', type: 'concept' };
    addAlias(fm, 'Bar');
    expect(Object.keys(fm)).toEqual(['id', 'type', 'aliases']);
  });

  test('non-string entries already in the list are left untouched, only appended past', () => {
    const fm: Record<string, unknown> = { aliases: ['Foo', 42] };
    const result = addAlias(fm, 'Bar');
    expect(result.changed).toBe(true);
    expect(fm.aliases).toEqual(['Foo', 42, 'Bar']);
  });
});

describe('addEdge', () => {
  test('sets a scalar when the key is absent', () => {
    const fm: Record<string, unknown> = { id: 'x' };
    const result = addEdge(fm, 'owner', 'person:jane');
    expect(result.changed).toBe(true);
    expect(fm.owner).toBe('person:jane');
  });

  test('converts an existing scalar to a two-item list', () => {
    const fm: Record<string, unknown> = { participants: 'person:jane' };
    const result = addEdge(fm, 'participants', 'person:bob');
    expect(result.changed).toBe(true);
    expect(fm.participants).toEqual(['person:jane', 'person:bob']);
  });

  test('appends to an existing list', () => {
    const fm: Record<string, unknown> = { participants: ['person:jane'] };
    const result = addEdge(fm, 'participants', 'person:bob');
    expect(result.changed).toBe(true);
    expect(fm.participants).toEqual(['person:jane', 'person:bob']);
  });

  test('skips an exact duplicate in a list — no change', () => {
    const fm: Record<string, unknown> = { participants: ['person:jane', 'person:bob'] };
    const result = addEdge(fm, 'participants', 'person:bob');
    expect(result.changed).toBe(false);
    expect(fm.participants).toEqual(['person:jane', 'person:bob']);
  });

  test('trims key and value', () => {
    const fm: Record<string, unknown> = {};
    addEdge(fm, '  owner  ', '  person:jane  ');
    expect(fm.owner).toBe('person:jane');
  });

  test('a blank key or value is a no-op', () => {
    const fm: Record<string, unknown> = { owner: 'person:jane' };
    expect(addEdge(fm, '   ', 'person:bob').changed).toBe(false);
    expect(addEdge(fm, 'owner', '   ').changed).toBe(false);
    expect(fm.owner).toBe('person:jane');
  });

  test('a loose-end value is stored verbatim, same rules as an id value', () => {
    const fm: Record<string, unknown> = {};
    addEdge(fm, 'owner', '?person: someone from ops');
    expect(fm.owner).toBe('?person: someone from ops');
  });

  test('never touches other keys', () => {
    const fm: Record<string, unknown> = { id: 'x', type: 'record', status: 'active', participants: ['person:jane'] };
    addEdge(fm, 'participants', 'person:bob');
    expect(fm.id).toBe('x');
    expect(fm.type).toBe('record');
    expect(fm.status).toBe('active');
  });

  test('preserves key order — a brand-new key lands at the end', () => {
    const fm: Record<string, unknown> = { id: 'x', type: 'record' };
    addEdge(fm, 'owner', 'person:jane');
    expect(Object.keys(fm)).toEqual(['id', 'type', 'owner']);
  });
});

describe('edgeKeysForType', () => {
  test('collects edge keys used by any of the given nodes, deduped and sorted', () => {
    const nodes = [
      { frontmatter: { id: 'a', type: 'record', participants: ['person:jane'] } },
      { frontmatter: { id: 'b', type: 'record', owner: 'person:bob' } },
      { frontmatter: { id: 'c', type: 'record', participants: ['person:jane'] } },
    ];
    expect(edgeKeysForType(nodes)).toEqual(['owner', 'participants']);
  });

  test('ignores frontmatter keys that never hold a ref-shaped value', () => {
    const nodes = [{ frontmatter: { id: 'a', type: 'record', status: 'active', description: 'not a ref' } }];
    expect(edgeKeysForType(nodes)).toEqual([]);
  });

  test('ignores bookkeeping keys (id, type, aliases, ...)', () => {
    const nodes = [{ frontmatter: { id: 'a', type: 'record', name: 'A', aliases: ['x'] } }];
    expect(edgeKeysForType(nodes)).toEqual([]);
  });

  test('empty node list', () => {
    expect(edgeKeysForType([])).toEqual([]);
  });

  test('includes a key even when only a loose-end value uses it', () => {
    const nodes = [{ frontmatter: { id: 'a', type: 'record', owner: '?person: someone from ops' } }];
    expect(edgeKeysForType(nodes)).toEqual(['owner']);
  });
});

describe('looseEndText', () => {
  test('with a type hint', () => {
    expect(looseEndText('person', 'someone from ops')).toBe('?person: someone from ops');
  });

  test('without a type hint', () => {
    expect(looseEndText(undefined, 'the broker thing')).toBe('?: the broker thing');
  });

  test('trims the type hint and descriptor', () => {
    expect(looseEndText('  person  ', '  someone from ops  ')).toBe('?person: someone from ops');
  });

  test('an empty-string type hint is treated the same as no hint', () => {
    expect(looseEndText('', 'the broker thing')).toBe('?: the broker thing');
  });
});

describe('todayIso', () => {
  test('formats a date as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 8, 16))).toBe('2026-09-16'); // month is 0-indexed: 8 = September
  });

  test('pads single-digit months and days', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  test('defaults to now when no date is given', () => {
    const result = todayIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
