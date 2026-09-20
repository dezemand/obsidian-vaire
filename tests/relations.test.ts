import { describe, expect, test } from 'bun:test';
import {
  RELATIONS_WIDE_THRESHOLD,
  isLastSection,
  isWideRelations,
  looseEndsOf,
  outgoingRefs,
  sortBacklinksById,
} from '../src/render/relations-data';

describe('outgoingRefs', () => {
  test('frontmatter edges first, in authored order, then prose links in appearance order', () => {
    const frontmatter = {
      owner: 'person:alice',
      related: ['concept:a', 'concept:b'],
    };
    const prose = ['concept:c', 'concept:a']; // concept:a repeats
    const refs = outgoingRefs(frontmatter, prose);
    expect(refs.map((r) => r.full)).toEqual(['person:alice', 'concept:a', 'concept:b', 'concept:c']);
  });

  test('dedupes by full id, keeping the first occurrence (frontmatter wins over prose)', () => {
    const frontmatter = { owner: 'person:alice' };
    const prose = ['person:alice', 'person:alice'];
    const refs = outgoingRefs(frontmatter, prose);
    expect(refs.length).toBe(1);
    expect(refs[0].full).toBe('person:alice');
  });

  test('excludes loose ends — they have their own section', () => {
    const frontmatter = { owner: '?person: someone from logistics' };
    const prose = ['?team: unknown team', 'concept:a'];
    const refs = outgoingRefs(frontmatter, prose);
    expect(refs.map((r) => r.full)).toEqual(['concept:a']);
  });

  test('keeps a target that does not resolve to a node — the caller renders it as missing', () => {
    // outgoingRefs only shapes the *list*; whether `concept:nope` actually resolves is decided
    // later by createRefElement. It must still appear here so a broken edge stays visible.
    const refs = outgoingRefs({ related: 'concept:nope' }, []);
    expect(refs.map((r) => r.full)).toEqual(['concept:nope']);
  });

  test('ignores ordinary (non-Vairë) prose links', () => {
    const refs = outgoingRefs(undefined, ['Some Note', 'concept:a']);
    expect(refs.map((r) => r.full)).toEqual(['concept:a']);
  });

  test('empty frontmatter and no prose links -> empty', () => {
    expect(outgoingRefs(undefined, [])).toEqual([]);
    expect(outgoingRefs({}, [])).toEqual([]);
  });

  test('a scoped/external ref is deduped by its full address, not its local one', () => {
    const frontmatter = { related: '@acme-security/standard:coding-style' };
    const prose = ['@acme-security/standard:coding-style'];
    const refs = outgoingRefs(frontmatter, prose);
    expect(refs.length).toBe(1);
  });
});

describe('looseEndsOf', () => {
  test('collects frontmatter loose ends (bare, no brackets) and prose loose ends', () => {
    const frontmatter = { owner: '?person: someone from logistics' };
    const prose = ['?team: unknown team', 'concept:a'];
    const loose = looseEndsOf(frontmatter, prose);
    expect(loose.map((l) => l.raw)).toEqual(['?person: someone from logistics', '?team: unknown team']);
  });

  test('dedupes by raw text, frontmatter first', () => {
    const frontmatter = { owner: '?person: someone' };
    const prose = ['?person: someone', '?person: someone'];
    const loose = looseEndsOf(frontmatter, prose);
    expect(loose.length).toBe(1);
  });

  test('ignores resolved refs and ordinary links', () => {
    const loose = looseEndsOf({ owner: 'person:alice' }, ['concept:a', 'Some Note']);
    expect(loose).toEqual([]);
  });

  test('no type hint -> typeHint left undefined', () => {
    const loose = looseEndsOf(undefined, ['?: a mystery']);
    expect(loose.length).toBe(1);
    expect(loose[0].typeHint).toBeUndefined();
    expect(loose[0].descriptor).toBe('a mystery');
  });

  test('empty when there are none', () => {
    expect(looseEndsOf({ owner: 'person:alice' }, ['concept:a'])).toEqual([]);
  });
});

describe('sortBacklinksById', () => {
  test('sorts ascending by id, without mutating the input', () => {
    const items = [{ id: 'concept:z' }, { id: 'concept:a' }, { id: 'concept:m' }];
    const sorted = sortBacklinksById(items);
    expect(sorted.map((i) => i.id)).toEqual(['concept:a', 'concept:m', 'concept:z']);
    expect(items.map((i) => i.id)).toEqual(['concept:z', 'concept:a', 'concept:m']); // unchanged
  });

  test('stable-ish for equal ids (order among duplicates preserved by Array#sort)', () => {
    const items = [
      { id: 'concept:a', tag: 1 },
      { id: 'concept:a', tag: 2 },
    ];
    expect(sortBacklinksById(items).map((i) => i.tag)).toEqual([1, 2]);
  });
});

describe('isWideRelations', () => {
  test('narrow when both counts are at or below the threshold', () => {
    expect(isWideRelations(0, 0)).toBe(false);
    expect(isWideRelations(RELATIONS_WIDE_THRESHOLD, RELATIONS_WIDE_THRESHOLD)).toBe(false);
  });

  test('wide once either count exceeds the threshold', () => {
    expect(isWideRelations(RELATIONS_WIDE_THRESHOLD + 1, 0)).toBe(true);
    expect(isWideRelations(0, RELATIONS_WIDE_THRESHOLD + 1)).toBe(true);
  });

  test('a custom threshold is honored', () => {
    expect(isWideRelations(3, 0, 2)).toBe(true);
    expect(isWideRelations(2, 0, 2)).toBe(false);
  });
});

describe('isLastSection', () => {
  test('a single-line file with no trailing newline', () => {
    const text = '# Title';
    expect(isLastSection(text, 0)).toBe(true);
  });

  test('a file ending with exactly one trailing newline', () => {
    const text = '# Title\n\nBody line.\n';
    // "Body line." is content line index 2; split('\n') yields a trailing '' at index 3.
    expect(isLastSection(text, 2)).toBe(true);
    expect(isLastSection(text, 0)).toBe(false); // the heading section is not the last one
  });

  test('several trailing blank lines still resolve to the last non-empty line', () => {
    const text = '# Title\n\nBody.\n\n\n';
    expect(isLastSection(text, 2)).toBe(true);
  });

  test('a section reported past the last non-empty line still counts as last (>=)', () => {
    const text = '# Title\n\nBody.\n';
    expect(isLastSection(text, 5)).toBe(true);
  });

  test('an earlier section is not the last one', () => {
    const text = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    // sections: heading at line 0, "First paragraph." at line 2, "Second paragraph." at line 4
    expect(isLastSection(text, 0)).toBe(false);
    expect(isLastSection(text, 2)).toBe(false);
    expect(isLastSection(text, 4)).toBe(true);
  });
});
