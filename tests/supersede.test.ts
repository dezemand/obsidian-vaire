import { describe, expect, test } from 'bun:test';
import { mergeAliases, rewriteReference, summarizeSupersede, todayIso } from '../src/authoring/supersede-pure';

describe('rewriteReference — wikilinks', () => {
  test('bare [[old]] becomes [[new]]', () => {
    expect(rewriteReference('See [[concept:reference]] for details.', 'concept:reference', 'concept:new-reference')).toBe(
      'See [[concept:new-reference]] for details.',
    );
  });

  test('[[old|Display]] keeps the display text verbatim', () => {
    expect(
      rewriteReference('See [[concept:reference|the reference model]] here.', 'concept:reference', 'concept:new-reference'),
    ).toBe('See [[concept:new-reference|the reference model]] here.');
  });

  test('multiple occurrences on one line are all rewritten', () => {
    expect(rewriteReference('[[concept:reference]] and [[concept:reference|again]]', 'concept:reference', 'concept:new-reference')).toBe(
      '[[concept:new-reference]] and [[concept:new-reference|again]]',
    );
  });

  test('a line with no reference to the old id is returned unchanged', () => {
    const line = 'Nothing to see here, just [[concept:other]].';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('does not touch [[@pkg/old]] — a different package’s node, even with the same type:id', () => {
    const line = 'See [[@other-pkg/concept:reference]] instead.';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('does not touch [[@pkg/old|Display]] either', () => {
    const line = 'See [[@other-pkg/concept:reference|elsewhere]] instead.';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('no false positive on an id that merely shares a prefix', () => {
    const line = 'See [[concept:reference-old]] and [[concept:referencex]].';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('a scoped old id is matched by its full address', () => {
    const line = 'Declared in [[cli:vaire/flag:verbose]].';
    expect(rewriteReference(line, 'cli:vaire/flag:verbose', 'cli:vaire/flag:loud')).toBe('Declared in [[cli:vaire/flag:loud]].');
  });

  test('loose ends ([[?...]]) are never touched (they never equal a full id target)', () => {
    const line = 'See [[?concept: the reference thing]].';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });
});

describe('rewriteReference — frontmatter scalar/list values', () => {
  test('unquoted scalar value', () => {
    expect(rewriteReference('owner: concept:reference', 'concept:reference', 'concept:new-reference')).toBe(
      'owner: concept:new-reference',
    );
  });

  test('double-quoted scalar value keeps its quotes', () => {
    expect(rewriteReference('owner: "concept:reference"', 'concept:reference', 'concept:new-reference')).toBe(
      'owner: "concept:new-reference"',
    );
  });

  test('single-quoted scalar value keeps its quotes', () => {
    expect(rewriteReference("owner: 'concept:reference'", 'concept:reference', 'concept:new-reference')).toBe(
      "owner: 'concept:new-reference'",
    );
  });

  test('unquoted list item', () => {
    expect(rewriteReference('  - concept:reference', 'concept:reference', 'concept:new-reference')).toBe(
      '  - concept:new-reference',
    );
  });

  test('quoted list item', () => {
    expect(rewriteReference('  - "concept:reference"', 'concept:reference', 'concept:new-reference')).toBe(
      '  - "concept:new-reference"',
    );
  });

  test('a list item for a different value is untouched', () => {
    const line = '  - concept:other';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('no false positive on a frontmatter value sharing a prefix', () => {
    const line = 'owner: concept:reference-old';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('a key whose value is only part of the line (trailing text) is left alone', () => {
    // Anchored to the whole remainder of the line — this is what tells a real frontmatter
    // scalar apart from a prose sentence that merely happens to contain "key: text".
    const line = 'owner: concept:reference and some other note';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });

  test('an unrelated key: value pair is untouched', () => {
    const line = 'status: active';
    expect(rewriteReference(line, 'concept:reference', 'concept:new-reference')).toBe(line);
  });
});

describe('mergeAliases', () => {
  test('appends the old node’s name and aliases to the successor’s existing aliases', () => {
    const successorFm = { name: 'New Reference', aliases: ['Ref Model'] };
    const merged = mergeAliases(successorFm, { name: 'Old Reference', aliases: ['Legacy Ref'] });
    expect(merged).toEqual(['Ref Model', 'Old Reference', 'Legacy Ref']);
  });

  test('dedupes case-insensitively, keeping the first-seen casing', () => {
    const successorFm = { aliases: ['Ref Model'] };
    const merged = mergeAliases(successorFm, { name: 'ref model', aliases: [] });
    expect(merged).toEqual(['Ref Model']);
  });

  test('never adds the successor’s own name as one of its aliases', () => {
    const successorFm = { name: 'New Reference', aliases: [] };
    const merged = mergeAliases(successorFm, { name: 'New Reference', aliases: ['new reference'] });
    expect(merged).toEqual([]);
  });

  test('handles a successor with no existing aliases field', () => {
    const merged = mergeAliases({ name: 'New Reference' }, { name: 'Old Reference', aliases: ['Legacy'] });
    expect(merged).toEqual(['Old Reference', 'Legacy']);
  });

  test('handles a successor whose aliases field is a bare string, not an array', () => {
    const merged = mergeAliases({ aliases: 'Solo Alias' }, { name: 'Old Reference', aliases: [] });
    expect(merged).toEqual(['Solo Alias', 'Old Reference']);
  });

  test('drops blank/whitespace-only entries', () => {
    const merged = mergeAliases({ aliases: [''] }, { name: 'Old Reference', aliases: ['  '] });
    expect(merged).toEqual(['Old Reference']);
  });

  test('does not mutate its inputs', () => {
    const successorFm = { aliases: ['A'] };
    const oldNode = { name: 'B', aliases: ['C'] };
    mergeAliases(successorFm, oldNode);
    expect(successorFm.aliases).toEqual(['A']);
    expect(oldNode.aliases).toEqual(['C']);
  });
});

describe('summarizeSupersede', () => {
  test('minimal: no aliases merged, nothing rewritten', () => {
    expect(
      summarizeSupersede({
        oldFull: 'concept:reference',
        newFull: 'concept:new-reference',
        backlinksCount: 0,
        aliasesMerged: false,
        referencesRewritten: 0,
      }),
    ).toBe('concept:reference → concept:new-reference · 0 backlinks redirected');
  });

  test('singular backlink and reference counts', () => {
    expect(
      summarizeSupersede({
        oldFull: 'concept:reference',
        newFull: 'concept:new-reference',
        backlinksCount: 1,
        aliasesMerged: true,
        referencesRewritten: 1,
      }),
    ).toBe('concept:reference → concept:new-reference · 1 backlink redirected · aliases merged · 1 reference rewritten');
  });

  test('plural backlink and reference counts', () => {
    expect(
      summarizeSupersede({
        oldFull: 'concept:reference',
        newFull: 'concept:new-reference',
        backlinksCount: 3,
        aliasesMerged: false,
        referencesRewritten: 2,
      }),
    ).toBe('concept:reference → concept:new-reference · 3 backlinks redirected · 2 references rewritten');
  });
});

describe('todayIso', () => {
  test('formats a given date as YYYY-MM-DD', () => {
    expect(todayIso(new Date('2026-06-15T13:45:00Z'))).toBe('2026-06-15');
  });
});
