import { describe, expect, test } from 'bun:test';
// `LocalNode`/`PackageInfo` are imported as types only — erased before `bun test` ever tries to
// resolve `../src/packages` (which pulls in `obsidian`, a types-only npm package with no
// runtime module; see the same note in `src/suggest/quick-switch-pure.ts` and the header
// comment of `tests/scope.test.ts`, which explains why a *value*-level import of that file
// would break here).
import type { LocalNode, PackageInfo } from '../src/packages';
import type { Suggestion } from '../src/types';
import {
  filterQuickItems,
  itemSearchSegments,
  itemSearchText,
  localNodeToItem,
  matchesInRange,
  mergeCliItems,
  parseQuickQuery,
  sortItems,
  suggestionToNodeItem,
  type NodeItem,
} from '../src/suggest/quick-switch-pure';

function fakeNode(overrides: Partial<LocalNode> & Pick<LocalNode, 'type' | 'id' | 'full' | 'name'>): LocalNode {
  return {
    file: {} as unknown as LocalNode['file'],
    aliases: [],
    frontmatter: {},
    ...overrides,
  };
}

function fakePkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    dir: '',
    absRoot: '/vault/pkg',
    name: 'pkg',
    version: '1.0.0',
    types: [],
    scopedTypesWhitelist: [],
    dependencies: {},
    index: undefined as unknown as PackageInfo['index'],
    ...overrides,
  };
}

function item(overrides: Partial<NodeItem> & Pick<NodeItem, 'id' | 'name' | 'type'>): NodeItem {
  return { aliases: [], superseded: false, source: 'local', ...overrides };
}

describe('parseQuickQuery', () => {
  test('no recognized prefix: everything is text', () => {
    expect(parseQuickQuery('caret')).toEqual({ typeFilter: undefined, pkgFilter: undefined, text: 'caret' });
  });

  test('a type: prefix', () => {
    expect(parseQuickQuery('decision: caret')).toEqual({
      typeFilter: 'decision',
      pkgFilter: undefined,
      text: 'caret',
    });
  });

  test('an @pkg prefix', () => {
    expect(parseQuickQuery('@acme-platform caret')).toEqual({
      typeFilter: undefined,
      pkgFilter: 'acme-platform',
      text: 'caret',
    });
  });

  test('both, package first then type', () => {
    expect(parseQuickQuery('@acme decision: caret')).toEqual({
      typeFilter: 'decision',
      pkgFilter: 'acme',
      text: 'caret',
    });
  });

  test('a bare @pkg with nothing after it', () => {
    expect(parseQuickQuery('@acme')).toEqual({ typeFilter: undefined, pkgFilter: 'acme', text: '' });
  });

  test('a bare type: with nothing after it', () => {
    expect(parseQuickQuery('decision:')).toEqual({ typeFilter: 'decision', pkgFilter: undefined, text: '' });
  });

  test('a type: prefix only applies when it comes after any @pkg prefix, not before', () => {
    // "decision:" here is the first token, so it's read as a type prefix even with no @pkg —
    // this just documents that type: must appear where @pkg (if present) has already been
    // stripped, per parseQuickQuery's doc comment ("@pkg ... must come first").
    expect(parseQuickQuery('decision: @acme caret')).toEqual({
      typeFilter: 'decision',
      pkgFilter: undefined,
      text: '@acme caret',
    });
  });

  test('text is returned unchanged, not trimmed (leading whitespace after the colon is consumed, trailing is not)', () => {
    expect(parseQuickQuery('decision:   caret  ')).toEqual({
      typeFilter: 'decision',
      pkgFilter: undefined,
      text: 'caret  ',
    });
  });

  test('empty query', () => {
    expect(parseQuickQuery('')).toEqual({ typeFilter: undefined, pkgFilter: undefined, text: '' });
  });
});

describe('itemSearchSegments / itemSearchText', () => {
  test('name, id and aliases joined with two-space separators', () => {
    const n = item({ id: 'concept:reference', name: 'Reference', type: 'concept', aliases: ['ref', 'the graph'] });
    const segments = itemSearchSegments(n);
    expect(segments.text).toBe('Reference  concept:reference  ref the graph');
    expect(segments.text.slice(...segments.nameRange)).toBe('Reference');
    expect(segments.text.slice(...segments.idRange)).toBe('concept:reference');
    expect(segments.aliasesRange).not.toBeNull();
    expect(segments.text.slice(...(segments.aliasesRange as [number, number]))).toBe('ref the graph');
    expect(itemSearchText(n)).toBe(segments.text);
  });

  test('no aliases: the aliases field is omitted entirely, not left empty', () => {
    const n = item({ id: 'concept:reference', name: 'Reference', type: 'concept' });
    const segments = itemSearchSegments(n);
    expect(segments.text).toBe('Reference  concept:reference');
    expect(segments.aliasesRange).toBeNull();
  });

  test('nameRange always starts at 0', () => {
    const n = item({ id: 'concept:x', name: 'X', type: 'concept' });
    expect(itemSearchSegments(n).nameRange).toEqual([0, 1]);
  });
});

describe('sortItems', () => {
  test('case-insensitive name order', () => {
    const items = [
      item({ id: 'concept:b', name: 'banana', type: 'concept' }),
      item({ id: 'concept:a', name: 'Apple', type: 'concept' }),
    ];
    expect(sortItems(items).map((i) => i.id)).toEqual(['concept:a', 'concept:b']);
  });

  test('ties on name are broken by id', () => {
    const items = [
      item({ id: 'concept:z', name: 'Apple', type: 'concept' }),
      item({ id: 'concept:a', name: 'apple', type: 'concept' }),
    ];
    expect(sortItems(items).map((i) => i.id)).toEqual(['concept:a', 'concept:z']);
  });

  test('superseded nodes sort last regardless of name', () => {
    const items = [
      item({ id: 'concept:z', name: 'Zebra', type: 'concept', superseded: true }),
      item({ id: 'concept:a', name: 'Aardvark', type: 'concept' }),
    ];
    expect(sortItems(items).map((i) => i.id)).toEqual(['concept:a', 'concept:z']);
  });

  test('does not mutate its input', () => {
    const items = [item({ id: 'concept:b', name: 'B', type: 'concept' }), item({ id: 'concept:a', name: 'A', type: 'concept' })];
    const original = [...items];
    sortItems(items);
    expect(items).toEqual(original);
  });
});

describe('mergeCliItems', () => {
  const local: NodeItem[] = [
    item({ id: 'concept:reference', name: 'Reference', type: 'concept' }),
    item({ id: 'concept:loose-end', name: 'Loose end', type: 'concept' }),
  ];

  test('appends @pkg/-prefixed cli hits after local, local order untouched', () => {
    const cli: NodeItem[] = [item({ id: '@acme-security/standard:coding-style', name: 'Coding Style', type: 'standard', source: 'cli' })];
    const merged = mergeCliItems(local, cli);
    expect(merged.map((i) => i.id)).toEqual(['concept:reference', 'concept:loose-end', '@acme-security/standard:coding-style']);
  });

  test('a cli hit not @-prefixed is dropped (it would mean the CLI somehow returned a bare local-looking id)', () => {
    const cli: NodeItem[] = [item({ id: 'concept:something-else', name: 'X', type: 'concept', source: 'cli' })];
    expect(mergeCliItems(local, cli)).toEqual(local);
  });

  test('a cli hit already present in local (same id) is dropped as redundant', () => {
    const cli: NodeItem[] = [item({ id: 'concept:reference', name: 'Reference', type: 'concept', source: 'cli' })];
    expect(mergeCliItems(local, cli).map((i) => i.id)).toEqual(['concept:reference', 'concept:loose-end']);
  });

  test('caps appended cli hits at 5', () => {
    const cli: NodeItem[] = Array.from({ length: 8 }, (_, i) =>
      item({ id: `@pkg/concept:c${i}`, name: `C${i}`, type: 'concept', source: 'cli' }),
    );
    const merged = mergeCliItems(local, cli);
    expect(merged.length).toBe(local.length + 5);
    expect(merged.slice(local.length).map((i) => i.id)).toEqual([
      '@pkg/concept:c0',
      '@pkg/concept:c1',
      '@pkg/concept:c2',
      '@pkg/concept:c3',
      '@pkg/concept:c4',
    ]);
  });
});

describe('filterQuickItems', () => {
  const items: NodeItem[] = [
    item({ id: 'concept:a', name: 'A', type: 'concept', pkgName: 'vaire' }),
    item({ id: 'decision:b', name: 'B', type: 'decision', pkgName: 'vaire' }),
    item({ id: 'concept:c', name: 'C', type: 'concept', pkgName: 'acme-platform' }),
  ];

  test('no filters: returns the same array reference', () => {
    expect(filterQuickItems(items, {})).toBe(items);
  });

  test('typeFilter narrows to an exact, case-insensitive type match', () => {
    expect(filterQuickItems(items, { typeFilter: 'Concept' }).map((i) => i.id)).toEqual(['concept:a', 'concept:c']);
  });

  test('pkgFilter narrows to items whose package name starts with the filter, case-insensitively', () => {
    expect(filterQuickItems(items, { pkgFilter: 'ACME' }).map((i) => i.id)).toEqual(['concept:c']);
  });

  test('both filters combine (AND)', () => {
    expect(filterQuickItems(items, { typeFilter: 'concept', pkgFilter: 'acme' }).map((i) => i.id)).toEqual(['concept:c']);
  });

  test('an item with no pkgName never matches a pkgFilter', () => {
    const noPkg = [item({ id: 'concept:d', name: 'D', type: 'concept' })];
    expect(filterQuickItems(noPkg, { pkgFilter: 'anything' })).toEqual([]);
  });
});

describe('matchesInRange', () => {
  test('null range yields no matches', () => {
    expect(matchesInRange([[0, 3]], null)).toEqual([]);
  });

  test('keeps only pairs fully contained within the range', () => {
    const matches: [number, number][] = [
      [0, 2], // inside [0, 9)
      [5, 9], // inside [0, 9)
      [8, 12], // straddles the boundary — excluded
      [10, 14], // entirely outside — excluded
    ];
    expect(matchesInRange(matches, [0, 9])).toEqual([
      [0, 2],
      [5, 9],
    ]);
  });

  test('empty matches array', () => {
    expect(matchesInRange([], [0, 9])).toEqual([]);
  });
});

describe('localNodeToItem', () => {
  test('maps a LocalNode + its package into a NodeItem', () => {
    const node = fakeNode({
      type: 'concept',
      id: 'reference',
      full: 'concept:reference',
      name: 'Reference',
      aliases: ['ref'],
    });
    const pkg = fakePkg({ name: 'vaire' });
    const result = localNodeToItem(node, pkg);
    expect(result).toEqual({
      id: 'concept:reference',
      name: 'Reference',
      type: 'concept',
      aliases: ['ref'],
      pkgName: 'vaire',
      superseded: false,
      source: 'local',
      local: { node, pkg },
    });
  });

  test('superseded is derived from supersededBy being set', () => {
    const node = fakeNode({
      type: 'guide',
      id: 'old',
      full: 'guide:old',
      name: 'Old guide',
      supersededBy: 'guide:new',
    });
    const pkg = fakePkg();
    expect(localNodeToItem(node, pkg).superseded).toBe(true);
  });
});

describe('suggestionToNodeItem', () => {
  test('maps a CLI Suggestion into a NodeItem with source "cli" and no aliases', () => {
    const suggestion: Suggestion = {
      id: '@acme-security/standard:coding-style',
      type: 'standard',
      name: 'Coding Style',
      path: 'standards/coding-style.md',
      package: 'acme-security',
      score: 2.5,
    };
    expect(suggestionToNodeItem(suggestion)).toEqual({
      id: '@acme-security/standard:coding-style',
      name: 'Coding Style',
      type: 'standard',
      aliases: [],
      pkgName: 'acme-security',
      superseded: false,
      source: 'cli',
      suggestion,
    });
  });
});
