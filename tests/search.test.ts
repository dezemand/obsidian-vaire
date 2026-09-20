import { describe, expect, test } from 'bun:test';
import { highlightTerms, pushHistory, typesInResults } from '../src/views/pure-search';

describe('highlightTerms', () => {
  test('single term, single match', () => {
    expect(highlightTerms('the network switch', 'network')).toEqual([
      { text: 'the ', hit: false },
      { text: 'network', hit: true },
      { text: ' switch', hit: false },
    ]);
  });

  test('case-insensitive matching, original casing preserved in output', () => {
    expect(highlightTerms('Network Switch', 'network')).toEqual([
      { text: 'Network', hit: true },
      { text: ' Switch', hit: false },
    ]);
  });

  test('multiple whitespace-split terms', () => {
    expect(highlightTerms('the network switch is down', 'network down')).toEqual([
      { text: 'the ', hit: false },
      { text: 'network', hit: true },
      { text: ' switch is ', hit: false },
      { text: 'down', hit: true },
    ]);
  });

  test('longest term wins when one term is a substring of another', () => {
    // "net" is a substring of "network" — matching "network" first (longest-first) must
    // produce one hit segment "network", not "net" + "work".
    expect(highlightTerms('the network is up', 'net network')).toEqual([
      { text: 'the ', hit: false },
      { text: 'network', hit: true },
      { text: ' is up', hit: false },
    ]);
  });

  test('no match at all', () => {
    expect(highlightTerms('nothing here', 'zzz')).toEqual([{ text: 'nothing here', hit: false }]);
  });

  test('blank query returns the text as a single non-hit segment', () => {
    expect(highlightTerms('some snippet', '   ')).toEqual([{ text: 'some snippet', hit: false }]);
  });

  test('empty text returns no segments', () => {
    expect(highlightTerms('', 'network')).toEqual([]);
  });

  test('duplicate terms in the query are only matched once per occurrence', () => {
    expect(highlightTerms('network network', 'network network')).toEqual([
      { text: 'network', hit: true },
      { text: ' ', hit: false },
      { text: 'network', hit: true },
    ]);
  });

  test('regex-special characters in a term are treated literally', () => {
    expect(highlightTerms('cost: $5.00 (approx)', '$5.00')).toEqual([
      { text: 'cost: ', hit: false },
      { text: '$5.00', hit: true },
      { text: ' (approx)', hit: false },
    ]);
  });

  test('match at the very start and end of the text', () => {
    expect(highlightTerms('network', 'network')).toEqual([{ text: 'network', hit: true }]);
  });
});

describe('typesInResults', () => {
  test('deduplicates and sorts', () => {
    expect(typesInResults([{ type: 'guide' }, { type: 'concept' }, { type: 'guide' }, { type: 'application' }])).toEqual([
      'application',
      'concept',
      'guide',
    ]);
  });

  test('empty input', () => {
    expect(typesInResults([])).toEqual([]);
  });
});

describe('pushHistory', () => {
  test('prepends a new query', () => {
    expect(pushHistory(['old'], 'new query', 10)).toEqual(['new query', 'old']);
  });

  test('trims the query before storing', () => {
    expect(pushHistory([], '  spaced  ', 10)).toEqual(['spaced']);
  });

  test('moves a repeated query to the front instead of duplicating it', () => {
    expect(pushHistory(['a', 'b', 'c'], 'b', 10)).toEqual(['b', 'a', 'c']);
  });

  test('caps the result at max entries', () => {
    expect(pushHistory(['1', '2', '3'], 'new', 3)).toEqual(['new', '1', '2']);
  });

  test('blank query leaves history unchanged', () => {
    expect(pushHistory(['a', 'b'], '   ', 10)).toEqual(['a', 'b']);
  });

  test('empty history', () => {
    expect(pushHistory([], 'first', 10)).toEqual(['first']);
  });

  test('max of 0 yields an empty history', () => {
    expect(pushHistory(['a'], 'b', 0)).toEqual([]);
  });
});
