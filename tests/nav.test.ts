import { describe, expect, test } from 'bun:test';
import { scopeChain, titleKey, titleText, type ScopeLookupNode } from '../src/nav/pure';

describe('titleText', () => {
  const node = { name: 'Reference' };

  test("'file' mode always returns the basename, node or not", () => {
    expect(titleText(node, 'concept-reference.md', 'file')).toBe('concept-reference.md');
    expect(titleText(null, 'concept-reference.md', 'file')).toBe('concept-reference.md');
  });

  test("'node' mode returns the node's name", () => {
    expect(titleText(node, 'concept-reference.md', 'node')).toBe('Reference');
  });

  test("'both' mode returns 'Name · basename'", () => {
    expect(titleText(node, 'concept-reference.md', 'both')).toBe('Reference · concept-reference.md');
  });

  test('any mode falls back to the basename when the file is not a Vairë node', () => {
    expect(titleText(null, 'concept-reference.md', 'node')).toBe('concept-reference.md');
    expect(titleText(null, 'concept-reference.md', 'both')).toBe('concept-reference.md');
  });
});

describe('titleKey', () => {
  const node = { name: 'Reference' };

  test("null (nothing to decorate) for 'file' mode or a missing node", () => {
    expect(titleKey(node, 'concept', 'concept-reference.md', 'file')).toBeNull();
    expect(titleKey(null, undefined, 'concept-reference.md', 'node')).toBeNull();
  });

  test('a stable key that changes when any input changes', () => {
    const a = titleKey(node, 'concept', 'concept-reference.md', 'node');
    const b = titleKey(node, 'concept', 'concept-reference.md', 'node');
    expect(a).not.toBeNull();
    expect(a).toBe(b);

    expect(titleKey({ name: 'Other' }, 'concept', 'concept-reference.md', 'node')).not.toBe(a);
    expect(titleKey(node, 'decision', 'concept-reference.md', 'node')).not.toBe(a);
    expect(titleKey(node, 'concept', 'other.md', 'node')).not.toBe(a);
    expect(titleKey(node, 'concept', 'concept-reference.md', 'both')).not.toBe(a);
  });
});

describe('scopeChain', () => {
  function tableLookup(table: Record<string, ScopeLookupNode>) {
    return (id: string): ScopeLookupNode | null => table[id] ?? null;
  }

  test('unscoped node: empty chain, no cycle, nothing missing', () => {
    const result = scopeChain({ scope: undefined }, tableLookup({}));
    expect(result).toEqual({ chain: [], cycle: false, missing: false });
  });

  test('nested scopes: outermost container first, immediate container last', () => {
    const lookup = tableLookup({
      'project:atlas': { name: 'Atlas', scope: undefined },
      'team:atlas-core': { name: 'Atlas Core', scope: 'project:atlas' },
    });
    const result = scopeChain({ scope: 'team:atlas-core' }, lookup);
    expect(result.cycle).toBe(false);
    expect(result.missing).toBe(false);
    expect(result.chain).toEqual([
      { id: 'project:atlas', name: 'Atlas' },
      { id: 'team:atlas-core', name: 'Atlas Core' },
    ]);
  });

  test('three levels deep stay in outer-to-inner order', () => {
    const lookup = tableLookup({
      'org:vaire': { name: 'Vairë', scope: undefined },
      'project:atlas': { name: 'Atlas', scope: 'org:vaire' },
      'team:atlas-core': { name: 'Atlas Core', scope: 'project:atlas' },
    });
    const result = scopeChain({ scope: 'team:atlas-core' }, lookup);
    expect(result.chain.map((c) => c.id)).toEqual(['org:vaire', 'project:atlas', 'team:atlas-core']);
    expect(result.cycle).toBe(false);
    expect(result.missing).toBe(false);
  });

  test('a missing (unresolvable) container renders as a missing ref and stops climbing', () => {
    const lookup = tableLookup({});
    const result = scopeChain({ scope: 'project:ghost' }, lookup);
    expect(result.chain).toEqual([{ id: 'project:ghost', name: null }]);
    expect(result.missing).toBe(true);
    expect(result.cycle).toBe(false);
  });

  test('a missing container partway up the chain: resolved entries below it are kept', () => {
    const lookup = tableLookup({
      'team:atlas-core': { name: 'Atlas Core', scope: 'project:ghost' }, // 'project:ghost' unresolvable
    });
    const result = scopeChain({ scope: 'team:atlas-core' }, lookup);
    expect(result.chain).toEqual([
      { id: 'project:ghost', name: null },
      { id: 'team:atlas-core', name: 'Atlas Core' },
    ]);
    expect(result.missing).toBe(true);
  });

  test('a cycle is detected and the chain is truncated right before the repeat', () => {
    const lookup = tableLookup({
      'team:a': { name: 'A', scope: 'team:b' },
      'team:b': { name: 'B', scope: 'team:a' },
    });
    const result = scopeChain({ scope: 'team:a' }, lookup);
    expect(result.cycle).toBe(true);
    expect(result.missing).toBe(false);
    // Walked team:a -> team:b -> (team:a again, stop before re-adding it).
    expect(result.chain.map((c) => c.id)).toEqual(['team:b', 'team:a']);
  });

  test('a node scoped directly to itself is a one-step cycle with an empty chain', () => {
    const lookup = tableLookup({
      'team:a': { name: 'A', scope: 'team:a' },
    });
    const result = scopeChain({ scope: 'team:a' }, lookup);
    expect(result.cycle).toBe(true);
    expect(result.chain).toEqual([{ id: 'team:a', name: 'A' }]);
  });

  test('depth limit: stops after maxDepth containers even without a cycle or a miss', () => {
    const table: Record<string, ScopeLookupNode> = {};
    // 10 levels: level:0 has no scope, level:9 is the node's immediate container.
    for (let i = 0; i < 10; i++) {
      table[`level:${i}`] = { name: `Level ${i}`, scope: i > 0 ? `level:${i - 1}` : undefined };
    }
    const result = scopeChain({ scope: 'level:9' }, tableLookup(table), 8);
    expect(result.chain).toHaveLength(8);
    expect(result.cycle).toBe(false);
    expect(result.missing).toBe(false);
    // Innermost 8 of the 10 levels: level:2..level:9, outermost (level:2) first.
    expect(result.chain.map((c) => c.id)).toEqual([
      'level:2',
      'level:3',
      'level:4',
      'level:5',
      'level:6',
      'level:7',
      'level:8',
      'level:9',
    ]);
  });

  test('default maxDepth is 8', () => {
    const table: Record<string, ScopeLookupNode> = {};
    for (let i = 0; i < 10; i++) {
      table[`level:${i}`] = { name: `Level ${i}`, scope: i > 0 ? `level:${i - 1}` : undefined };
    }
    const result = scopeChain({ scope: 'level:9' }, tableLookup(table));
    expect(result.chain).toHaveLength(8);
  });
});
