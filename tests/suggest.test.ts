import { describe, expect, test } from 'bun:test';
import {
  type Candidate,
  completionInsertText,
  findLooseEndAt,
  findLooseEndByDescriptor,
  findWikilinkAt,
  looseEndExistingReplacement,
  looseEndTypeChoices,
  looseEndTypeInsertText,
  mergeCandidates,
  rewriteLooseEnd,
  triggerLooseEnd,
  triggerQuery,
} from '../src/suggest/pure';

describe('triggerQuery', () => {
  test('bare "[[" with a partial id', () => {
    expect(triggerQuery('[[con')).toEqual({ startCh: 2, query: 'con' });
  });

  test('with leading text before the trigger', () => {
    const result = triggerQuery('See [[con');
    expect(result).toEqual({ startCh: 6, query: 'con' });
  });

  test('external "@pkg/" query is a normal trigger', () => {
    expect(triggerQuery('[[@pkg/con')).toEqual({ startCh: 2, query: '@pkg/con' });
  });

  test('a query starting with "?" (loose end) does not trigger', () => {
    expect(triggerQuery('[[?person: x')).toBeNull();
  });

  test('a query containing "|" (past the target, into display text) does not trigger', () => {
    expect(triggerQuery('[[a|b')).toBeNull();
  });

  test('no "[[" at all', () => {
    expect(triggerQuery('just some text')).toBeNull();
  });

  test('a closed wikilink earlier on the line does not falsely trigger', () => {
    expect(triggerQuery('[[concept:reference]] and now typing')).toBeNull();
  });

  test('empty query right after "[["', () => {
    expect(triggerQuery('[[')).toEqual({ startCh: 2, query: '' });
  });
});

describe('mergeCandidates', () => {
  const local: Candidate[] = [
    { id: 'concept:reference', name: 'Reference', type: 'concept', source: 'local' },
    { id: 'concept:loose-end', name: 'Loose end', type: 'concept', source: 'local' },
  ];

  test('local results come first, in their given order', () => {
    const cli: Candidate[] = [{ id: 'cli:vaire', name: 'Vairë CLI', type: 'cli', source: 'cli' }];
    const merged = mergeCandidates(local, cli);
    expect(merged.map((c) => c.id)).toEqual(['concept:reference', 'concept:loose-end', 'cli:vaire']);
  });

  test('a CLI suggestion whose id equals a local id is dropped', () => {
    const cli: Candidate[] = [
      { id: 'concept:reference', name: 'Reference (stale cli copy)', type: 'concept', source: 'cli' },
      { id: 'cli:vaire', name: 'Vairë CLI', type: 'cli', source: 'cli' },
    ];
    const merged = mergeCandidates(local, cli);
    expect(merged).toHaveLength(3);
    expect(merged.map((c) => c.id)).toEqual(['concept:reference', 'concept:loose-end', 'cli:vaire']);
    // The local entry wins — not overwritten by the CLI's duplicate.
    expect(merged[0].source).toBe('local');
  });

  test('duplicate CLI entries (same id twice) are also deduped', () => {
    const cli: Candidate[] = [
      { id: '@pkg/cli:vaire', name: 'A', type: 'cli', source: 'cli' },
      { id: '@pkg/cli:vaire', name: 'A again', type: 'cli', source: 'cli' },
    ];
    const merged = mergeCandidates([], cli);
    expect(merged).toHaveLength(1);
  });

  test('empty inputs', () => {
    expect(mergeCandidates([], [])).toEqual([]);
  });
});

describe('completionInsertText', () => {
  test('without display text', () => {
    expect(completionInsertText('concept:reference', 'Reference', false)).toBe('concept:reference');
  });

  test('with display text', () => {
    expect(completionInsertText('concept:reference', 'Reference', true)).toBe('concept:reference|Reference');
  });
});

describe('findWikilinkAt', () => {
  const line = 'See [[concept:reference]] and [[?person: someone from ops]] too.';
  // "[[concept:reference]]" starts at 4, ends at 25 (index just past the closing "]]")
  // "[[?person: someone from ops]]" starts at 30

  test('cursor inside an id wikilink', () => {
    const occ = findWikilinkAt(line, 10);
    expect(occ).not.toBeNull();
    expect(occ?.inner).toBe('concept:reference');
  });

  test('cursor inside a loose-end wikilink', () => {
    const occ = findWikilinkAt(line, 40);
    expect(occ?.inner).toBe('?person: someone from ops');
  });

  test('cursor at the exact opening bracket boundary counts as inside', () => {
    const occ = findWikilinkAt(line, 4);
    expect(occ?.inner).toBe('concept:reference');
  });

  test('cursor at the exact closing bracket boundary counts as inside', () => {
    const occ = findWikilinkAt(line, 25);
    expect(occ?.inner).toBe('concept:reference');
  });

  test('cursor outside any wikilink', () => {
    expect(findWikilinkAt(line, 1)).toBeNull();
    expect(findWikilinkAt(line, 28)).toBeNull();
  });

  test('no wikilinks on the line at all', () => {
    expect(findWikilinkAt('plain text', 3)).toBeNull();
  });
});

describe('findLooseEndAt', () => {
  test('ignores an id wikilink and finds the loose end containing the cursor', () => {
    const line = '[[concept:reference]] then [[?person: someone from ops]]';
    const occ = findLooseEndAt(line, 40);
    expect(occ?.inner).toBe('?person: someone from ops');
  });

  test('returns null when the cursor sits on an id wikilink, not a loose end', () => {
    const line = '[[concept:reference]] then [[?person: someone from ops]]';
    expect(findLooseEndAt(line, 10)).toBeNull();
  });

  test('cursor at end of line falls back to the last loose end on the line', () => {
    const line = 'Ping [[?: the broker thing]] and [[?person: someone from ops]]';
    const occ = findLooseEndAt(line, line.length);
    expect(occ?.inner).toBe('?person: someone from ops');
  });

  test('cursor at end of line with no loose ends at all returns null', () => {
    const line = 'Nothing loose here [[concept:reference]]';
    expect(findLooseEndAt(line, line.length)).toBeNull();
  });

  test('cursor mid-line, not at end, and not inside any loose end returns null', () => {
    const line = 'Some [[?person: x]] text after it';
    expect(findLooseEndAt(line, line.length - 1)).toBeNull();
  });
});

describe('findLooseEndByDescriptor', () => {
  test('matches by exact (trimmed) descriptor text', () => {
    const line = 'See [[?person: someone from ops]] for details.';
    const occ = findLooseEndByDescriptor(line, 'someone from ops');
    expect(occ?.inner).toBe('?person: someone from ops');
  });

  test('trims the needle before matching', () => {
    const line = 'See [[?person: someone from ops]] for details.';
    expect(findLooseEndByDescriptor(line, '  someone from ops  ')?.inner).toBe('?person: someone from ops');
  });

  test('no match returns null', () => {
    const line = 'See [[?person: someone from ops]] for details.';
    expect(findLooseEndByDescriptor(line, 'a different descriptor')).toBeNull();
  });

  test('ignores id wikilinks entirely', () => {
    const line = '[[concept:reference|someone from ops]]';
    expect(findLooseEndByDescriptor(line, 'someone from ops')).toBeNull();
  });

  test('picks the first matching occurrence when descriptors collide', () => {
    const line = '[[?person: dup]] and [[?person: dup]]';
    const occ = findLooseEndByDescriptor(line, 'dup');
    expect(occ?.start).toBe(0);
  });
});

describe('triggerLooseEnd', () => {
  test('bare "[[?" — empty type query', () => {
    expect(triggerLooseEnd('[[?')).toEqual({ typeQuery: '' });
  });

  test('"[[?" with a partial type', () => {
    expect(triggerLooseEnd('[[?per')).toEqual({ typeQuery: 'per' });
  });

  test('with leading text before the trigger', () => {
    expect(triggerLooseEnd('Contact [[?per')).toEqual({ typeQuery: 'per' });
  });

  test('"[[?type:" with no space yet — empty descriptor', () => {
    expect(triggerLooseEnd('[[?person:')).toEqual({ typeHint: 'person', descriptor: '' });
  });

  test('"[[?type: " with a descriptor in progress', () => {
    expect(triggerLooseEnd('[[?person: someone from')).toEqual({ typeHint: 'person', descriptor: 'someone from' });
  });

  test('"[[?: " with no type hint at all', () => {
    expect(triggerLooseEnd('[[?: the broker thing')).toEqual({ typeHint: undefined, descriptor: 'the broker thing' });
  });

  test('no "[[?" at all — not even a plain "[["', () => {
    expect(triggerLooseEnd('just some text')).toBeNull();
  });

  test('a plain (non-loose) "[[" does not trigger this', () => {
    expect(triggerLooseEnd('[[concept:ref')).toBeNull();
  });

  test('a closed loose end earlier on the line does not falsely trigger', () => {
    expect(triggerLooseEnd('[[?person: someone from ops]] and now typing')).toBeNull();
  });

  test('a closed loose end earlier, then a fresh "[[?" — finds the later one', () => {
    expect(triggerLooseEnd('[[?person: x]] then [[?')).toEqual({ typeQuery: '' });
  });

  test('a closed loose end earlier, then a fresh descriptor in progress', () => {
    expect(triggerLooseEnd('[[?person: x]] then [[?team: the broker')).toEqual({
      typeHint: 'team',
      descriptor: 'the broker',
    });
  });
});

describe('looseEndTypeChoices', () => {
  const types = ['concept', 'person', 'record'];

  test('empty query returns every type plus the unknown-type entry', () => {
    expect(looseEndTypeChoices(types, '')).toEqual(['concept', 'person', 'record', null]);
  });

  test('filters by case-insensitive prefix, unknown-type entry always included', () => {
    expect(looseEndTypeChoices(types, 'per')).toEqual(['person', null]);
    expect(looseEndTypeChoices(types, 'PER')).toEqual(['person', null]);
  });

  test('no matches — still returns the unknown-type entry', () => {
    expect(looseEndTypeChoices(types, 'zzz')).toEqual([null]);
  });
});

describe('looseEndTypeInsertText', () => {
  test('a known type', () => {
    expect(looseEndTypeInsertText('person')).toBe('person: ');
  });

  test('null (unknown type)', () => {
    expect(looseEndTypeInsertText(null)).toBe(': ');
  });
});

describe('looseEndExistingReplacement', () => {
  test('builds "<id>|<descriptor>", trimmed', () => {
    expect(looseEndExistingReplacement('person:jane', '  someone from ops  ')).toBe('person:jane|someone from ops');
  });
});

describe('rewriteLooseEnd', () => {
  test('typed loose end, descriptor with a type hint', () => {
    const line = 'Contact [[?person: someone from ops]] about this.';
    const occ = findLooseEndAt(line, 20)!;
    expect(rewriteLooseEnd(line, occ, 'person:jane')).toBe('Contact [[person:jane|someone from ops]] about this.');
  });

  test('typed loose end, no type hint', () => {
    const line = 'File it under [[?: the broker thing]].';
    const occ = findLooseEndAt(line, 20)!;
    expect(rewriteLooseEnd(line, occ, 'system:broker')).toBe('File it under [[system:broker|the broker thing]].');
  });

  test('preserves surrounding text and other wikilinks on the line untouched', () => {
    const line = '[[concept:reference]] relates to [[?person: someone]] somehow.';
    const occ = findLooseEndAt(line, 45)!;
    expect(rewriteLooseEnd(line, occ, 'person:jane')).toBe(
      '[[concept:reference]] relates to [[person:jane|someone]] somehow.',
    );
  });
});
