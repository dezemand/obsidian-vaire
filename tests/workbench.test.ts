import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FUZZY_THRESHOLD,
  filterGroups,
  groupExact,
  groupFuzzy,
  jaccard,
  labelFor,
  normalizeDescriptor,
  tokenize,
} from '../src/workbench/pure';
import type { LooseEndItem } from '../src/types';

function item(overrides: Partial<LooseEndItem> & Pick<LooseEndItem, 'record' | 'path' | 'line' | 'descriptor'>): LooseEndItem {
  return { type_guess: null, ...overrides };
}

describe('normalizeDescriptor', () => {
  test('lowercases, trims, strips punctuation, collapses whitespace', () => {
    expect(normalizeDescriptor('Someone from Logistics!')).toBe('someone from logistics');
    expect(normalizeDescriptor('someone from logistics')).toBe('someone from logistics');
  });

  test('collapses internal runs of whitespace', () => {
    expect(normalizeDescriptor('the   broker    thing')).toBe('the broker thing');
  });

  test('trims leading/trailing whitespace', () => {
    expect(normalizeDescriptor('  padded  ')).toBe('padded');
  });

  test('punctuation becomes a word boundary, not a deletion', () => {
    expect(normalizeDescriptor('self-service portal')).toBe('self service portal');
  });

  test('digits are preserved', () => {
    expect(normalizeDescriptor('VLAN 990 owner')).toBe('vlan 990 owner');
  });
});

describe('tokenize', () => {
  test('drops stop words', () => {
    expect(tokenize('the broker thing')).toEqual(['broker', 'thing']);
  });

  test('keeps non-stop-word tokens in normalized form', () => {
    expect(tokenize('Someone from Logistics!')).toEqual(['someone', 'logistics']);
  });

  test('a descriptor that is entirely stop words tokenizes to empty', () => {
    expect(tokenize('the of it')).toEqual([]);
  });

  test('empty string tokenizes to empty', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('jaccard', () => {
  test('identical sets score 1', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  test('disjoint sets score 0', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  test('partial overlap', () => {
    // {broker, thing} vs {broker, service, thing}: intersection 2, union 3.
    expect(jaccard(['broker', 'thing'], ['broker', 'service', 'thing'])).toBeCloseTo(2 / 3);
  });

  test('either side empty scores 0, not 1', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });
});

describe('labelFor', () => {
  test('picks the most frequent descriptor', () => {
    const occurrences = [
      item({ record: 'r1', path: 'a.md', line: 1, descriptor: 'someone from logistics' }),
      item({ record: 'r2', path: 'a.md', line: 2, descriptor: 'Someone from Logistics!' }),
      item({ record: 'r3', path: 'a.md', line: 3, descriptor: 'someone from logistics' }),
    ];
    expect(labelFor(occurrences)).toBe('someone from logistics');
  });

  test('ties break by first occurrence', () => {
    const occurrences = [
      item({ record: 'r1', path: 'a.md', line: 1, descriptor: 'B first' }),
      item({ record: 'r2', path: 'a.md', line: 2, descriptor: 'A second' }),
    ];
    expect(labelFor(occurrences)).toBe('B first');
  });

  test('empty input returns the empty string', () => {
    expect(labelFor([])).toBe('');
  });
});

describe('groupExact', () => {
  test('groups descriptors that normalize identically (same type hint)', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 3, descriptor: 'someone from logistics' }),
      item({ record: 'record:b', path: 'b.md', line: 7, descriptor: 'Someone from Logistics!' }),
    ];
    const groups = groupExact(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].descriptors.sort()).toEqual(['Someone from Logistics!', 'someone from logistics'].sort());
  });

  test('type hints split groups even with identical wording', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 1, descriptor: 'the broker thing', type_guess: 'system' }),
      item({ record: 'record:b', path: 'b.md', line: 2, descriptor: 'the broker thing', type_guess: 'concept' }),
      item({ record: 'record:c', path: 'c.md', line: 3, descriptor: 'the broker thing', type_guess: null }),
    ];
    const groups = groupExact(items);
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      expect(g.count).toBe(1);
      expect(g.typeHints).toHaveLength(1);
    }
    const hints = groups.map((g) => g.typeHints[0]).sort();
    expect(hints).toEqual([null, 'concept', 'system'].sort() as unknown as (string | null)[]);
  });

  test('unrelated descriptors stay in separate groups', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 1, descriptor: 'one thing' }),
      item({ record: 'record:b', path: 'b.md', line: 2, descriptor: 'a totally different thing' }),
    ];
    expect(groupExact(items)).toHaveLength(2);
  });

  test('empty input returns no groups', () => {
    expect(groupExact([])).toEqual([]);
  });
});

describe('groupFuzzy', () => {
  test('clusters similar wording above the default threshold', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 1, descriptor: 'the broker thing' }),
      item({ record: 'record:b', path: 'b.md', line: 2, descriptor: 'broker service thing' }),
      item({ record: 'record:c', path: 'c.md', line: 3, descriptor: 'the ingest api' }),
    ];
    const groups = groupFuzzy(items, DEFAULT_FUZZY_THRESHOLD);
    expect(groups).toHaveLength(2);

    const brokerGroup = groups.find((g) => g.occurrences.some((o) => o.record === 'record:a'))!;
    expect(brokerGroup.count).toBe(2);
    expect(brokerGroup.occurrences.map((o) => o.record).sort()).toEqual(['record:a', 'record:b']);

    const ingestGroup = groups.find((g) => g.occurrences.some((o) => o.record === 'record:c'))!;
    expect(ingestGroup.count).toBe(1);
  });

  test('single-link transitivity: A~B and B~C merge A/B/C even if A and C alone are below threshold', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 1, descriptor: 'alpha bravo' }),
      item({ record: 'record:b', path: 'b.md', line: 2, descriptor: 'bravo charlie' }),
      item({ record: 'record:c', path: 'c.md', line: 3, descriptor: 'charlie delta' }),
    ];
    // a~b jaccard = 1/3, b~c jaccard = 1/3, a~c jaccard = 0 — none alone clears 0.6, but a low
    // threshold makes every adjacent pair link, and single-link clustering chains them.
    const groups = groupFuzzy(items, 0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });

  test('a threshold of 1 only merges identical token sets', () => {
    const items = [
      item({ record: 'record:a', path: 'a.md', line: 1, descriptor: 'broker thing' }),
      item({ record: 'record:b', path: 'b.md', line: 2, descriptor: 'the broker thing' }),
      item({ record: 'record:c', path: 'c.md', line: 3, descriptor: 'broker service thing' }),
    ];
    const groups = groupFuzzy(items, 1);
    // "broker thing" and "the broker thing" tokenize identically ({broker, thing}) since "the"
    // is a stop word, so they merge; "broker service thing" has an extra token and stays apart.
    expect(groups).toHaveLength(2);
  });

  test('empty input returns no groups', () => {
    expect(groupFuzzy([], DEFAULT_FUZZY_THRESHOLD)).toEqual([]);
  });
});

describe('filterGroups', () => {
  const groups = groupExact([
    item({ record: 'record:a', path: 'devices/a.md', line: 1, descriptor: 'someone from logistics', type_guess: 'person' }),
    item({ record: 'record:b', path: 'devices/b.md', line: 2, descriptor: 'the ingest api', type_guess: 'system' }),
  ]);

  test('filters by exact type hint', () => {
    const filtered = filterGroups(groups, { type: 'person' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].label).toBe('someone from logistics');
  });

  test('filters by text against label/descriptors/record/path', () => {
    expect(filterGroups(groups, { text: 'logistics' })).toHaveLength(1);
    expect(filterGroups(groups, { text: 'record:b' })).toHaveLength(1);
    expect(filterGroups(groups, { text: 'devices/a' })).toHaveLength(1);
    expect(filterGroups(groups, { text: 'nonexistent' })).toHaveLength(0);
  });

  test('combines type and text filters', () => {
    expect(filterGroups(groups, { type: 'system', text: 'logistics' })).toHaveLength(0);
    expect(filterGroups(groups, { type: 'system', text: 'ingest' })).toHaveLength(1);
  });

  test('no filters returns everything', () => {
    expect(filterGroups(groups)).toHaveLength(2);
  });
});
