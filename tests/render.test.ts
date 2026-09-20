import { describe, expect, test } from 'bun:test';
import {
  basenameNoExt,
  chooseLivePreviewDisplayText,
  computeFencedLines,
  diagramTargetFromHref,
  externalTooltip,
  extractLinkTarget,
  findWikilinkSpan,
  hasDisplayOverride,
  humanizeKey,
  isInlineCodeAtColumn,
  lineIntersectsSelection,
  localTooltip,
  looseTooltip,
  matchPropertyValues,
  missingTooltip,
  nameFromResolveResult,
  navDecorationKey,
  navDisplayText,
  parseExternalSourcePath,
  propertyEdgeKeys,
  shouldDecorateRow,
  unlinkedTooltip,
} from '../src/render/pure';
import { extractFrontmatterEdges, parseRef } from '../src/ids';
import type { ResolveResult } from '../src/types';

describe('extractLinkTarget', () => {
  test('prefers data-href over href', () => {
    expect(extractLinkTarget('concept:reference', 'concept%3Areference')).toBe('concept:reference');
  });

  test('falls back to href when data-href is absent', () => {
    expect(extractLinkTarget(null, 'concept:reference')).toBe('concept:reference');
    expect(extractLinkTarget(undefined, 'concept:reference')).toBe('concept:reference');
    expect(extractLinkTarget('', 'concept:reference')).toBe('concept:reference');
  });

  test('strips a trailing #subpath', () => {
    expect(extractLinkTarget('concept:reference#^blockid', null)).toBe('concept:reference');
    expect(extractLinkTarget('concept:reference#Some Heading', null)).toBe('concept:reference');
  });

  test('decodes percent-escapes', () => {
    expect(extractLinkTarget('@acme-security%2Fstandard%3Acoding-style', null)).toBe('@acme-security/standard:coding-style');
  });

  test('returns the raw string when decoding fails rather than throwing', () => {
    expect(extractLinkTarget('%E0%A4%A', null)).toBe('%E0%A4%A');
  });

  test('null when neither attribute has content', () => {
    expect(extractLinkTarget(null, null)).toBeNull();
    expect(extractLinkTarget('', '')).toBeNull();
    expect(extractLinkTarget('   ', undefined)).toBeNull();
  });

  test('empty target after stripping a leading #subpath is null', () => {
    expect(extractLinkTarget('#^blockid', null)).toBeNull();
  });
});

describe('hasDisplayOverride', () => {
  test('false when the anchor text matches the target', () => {
    expect(hasDisplayOverride('concept:reference', 'concept:reference')).toBe(false);
  });

  test('true when an alias was used', () => {
    expect(hasDisplayOverride('Reference', 'concept:reference')).toBe(true);
  });

  test('ignores surrounding whitespace', () => {
    expect(hasDisplayOverride('  concept:reference  ', 'concept:reference')).toBe(false);
  });
});

describe('findWikilinkSpan', () => {
  test('finds the span containing the given column', () => {
    const line = 'See [[concept:reference|Reference]] for details.';
    const span = findWikilinkSpan(line, 10);
    expect(span).not.toBeNull();
    expect(span?.inner).toBe('concept:reference|Reference');
    expect(line.slice(span!.start, span!.end)).toBe('[[concept:reference|Reference]]');
  });

  test('matches at the exact boundary columns', () => {
    const line = '[[concept:reference]]';
    expect(findWikilinkSpan(line, 0)?.inner).toBe('concept:reference');
    expect(findWikilinkSpan(line, line.length)?.inner).toBe('concept:reference');
  });

  test('picks the correct span among several on one line', () => {
    const line = '[[concept:a]] and [[concept:b]]';
    expect(findWikilinkSpan(line, 3)?.inner).toBe('concept:a');
    expect(findWikilinkSpan(line, 25)?.inner).toBe('concept:b');
  });

  test('null when the column is outside any span', () => {
    const line = 'plain text [[concept:reference]] more text';
    expect(findWikilinkSpan(line, 3)).toBeNull();
  });

  test('null when there is no wikilink at all', () => {
    expect(findWikilinkSpan('no links here', 3)).toBeNull();
  });
});

describe('parseExternalSourcePath', () => {
  test('parses the encoded absRoot out of the synthetic sourcePath', () => {
    const abs = '/home/dev/Projects/vaire-all/packages/acme-security';
    const sourcePath = `__vaire_external__/${encodeURIComponent(abs)}/concepts/reference.md`;
    expect(parseExternalSourcePath(sourcePath)).toBe(abs);
  });

  test('null for an ordinary vault sourcePath', () => {
    expect(parseExternalSourcePath('packages/vaire/concepts/reference.md')).toBeNull();
  });

  test('null when the prefix is present but empty', () => {
    expect(parseExternalSourcePath('__vaire_external__/')).toBeNull();
  });

  test('handles a root with no further path segment', () => {
    const abs = '/abs/root';
    expect(parseExternalSourcePath(`__vaire_external__/${encodeURIComponent(abs)}`)).toBe(abs);
  });
});

describe('basenameNoExt', () => {
  test('strips the directory and .md extension', () => {
    expect(basenameNoExt('concepts/reference.md')).toBe('reference');
  });

  test('leaves a path with no extension alone', () => {
    expect(basenameNoExt('concepts/reference')).toBe('reference');
  });

  test('handles a bare filename', () => {
    expect(basenameNoExt('reference.md')).toBe('reference');
  });
});

describe('humanizeKey', () => {
  test('replaces underscores and hyphens with spaces', () => {
    expect(humanizeKey('related_systems')).toBe('related systems');
    expect(humanizeKey('related-systems')).toBe('related systems');
    expect(humanizeKey('a_b-c')).toBe('a b c');
  });

  test('leaves an already-plain key alone', () => {
    expect(humanizeKey('owner')).toBe('owner');
  });
});

describe('diagramTargetFromHref', () => {
  test('strips the vaire/ marker off a plain shape target', () => {
    expect(diagramTargetFromHref('vaire/technology-component:plc')).toBe('technology-component:plc');
  });

  test('strips the marker off a scoped/@pkg target too', () => {
    expect(diagramTargetFromHref('vaire/project:atlas/record:kickoff')).toBe('project:atlas/record:kickoff');
    expect(diagramTargetFromHref('vaire/@acme-security/standard:coding-style')).toBe('@acme-security/standard:coding-style');
  });

  test('null for an ordinary URL an author linked a shape to', () => {
    expect(diagramTargetFromHref('https://example.com/plc')).toBeNull();
    expect(diagramTargetFromHref('./local-file.svg')).toBeNull();
  });

  test('null when the href merely contains "vaire/" but is not prefixed by it', () => {
    expect(diagramTargetFromHref('https://example.com/vaire/technology-component:plc')).toBeNull();
  });

  test('null for empty/missing hrefs, and for the bare marker with nothing after it', () => {
    expect(diagramTargetFromHref(null)).toBeNull();
    expect(diagramTargetFromHref(undefined)).toBeNull();
    expect(diagramTargetFromHref('')).toBeNull();
    expect(diagramTargetFromHref('vaire/')).toBeNull();
    expect(diagramTargetFromHref('vaire/   ')).toBeNull();
  });

  test('the stripped text round-trips through parseRef for a valid shape target', () => {
    const target = diagramTargetFromHref('vaire/technology-component:plc');
    expect(target).not.toBeNull();
    expect(parseRef(target as string)).toMatchObject({ kind: 'id', type: 'technology-component', id: 'plc' });
  });

  test('the stripped text fails parseRef for a malformed shape target (mirrors malformed_diagram_ref)', () => {
    const target = diagramTargetFromHref('vaire/not a reference');
    expect(target).not.toBeNull();
    expect(parseRef(target as string)).toBeNull();
  });
});

describe('tooltip builders', () => {
  test('local: address · name', () => {
    expect(localTooltip('concept:reference', 'Reference')).toBe('concept:reference · Reference');
  });

  test('external: address · name · @pkg', () => {
    expect(externalTooltip('@acme-security/standard:coding-style', 'General Instructions', 'acme-security')).toBe(
      '@acme-security/standard:coding-style · General Instructions · @acme-security',
    );
  });

  test('unlinked: explains the package is not linked here', () => {
    expect(unlinkedTooltip('@acme-org/team:logistics', 'acme-org')).toBe(
      "@acme-org/team:logistics lives in package 'acme-org', which is not linked here",
    );
  });

  test('missing: without a CLI error message', () => {
    expect(missingTooltip('concept:nope')).toBe('not found in this package: concept:nope');
  });

  test('missing: with a CLI error message appended', () => {
    expect(missingTooltip('concept:nope', 'no repo configured')).toBe(
      'not found in this package: concept:nope — no repo configured',
    );
  });

  test('loose: fixed unresolved-reference text', () => {
    expect(looseTooltip()).toBe('unresolved reference — not a tracked node yet (click to resolve)');
  });
});

describe('propertyEdgeKeys', () => {
  test('includes a key whose scalar value is ref-shaped', () => {
    expect(propertyEdgeKeys({ org: 'department:platform' })).toEqual(new Set(['org']));
  });

  test('includes a key whose list values are ref-shaped', () => {
    const fm = { documented_in: ['document:design-spec', 'document:packages-spec'] };
    expect(propertyEdgeKeys(fm)).toEqual(new Set(['documented_in']));
  });

  test('includes a key whose value is a loose end', () => {
    expect(propertyEdgeKeys({ owner: '?person: someone from logistics' })).toEqual(new Set(['owner']));
  });

  test('excludes bookkeeping keys even though some are ref-shaped (e.g. scope)', () => {
    const fm = {
      id: 'x',
      type: 'concept',
      name: 'X',
      aliases: ['a'],
      scope: 'cli:vaire', // ref-shaped, but bookkeeping — already shown in the node header's "in" line
      updated: '2026-01-01',
      since: '0.1.0',
    };
    expect(propertyEdgeKeys(fm)).toEqual(new Set());
  });

  test('includes superseded_by when it parses as a ref, unlike extractFrontmatterEdges', () => {
    const fm = { superseded_by: 'concept:new-name' };
    expect(propertyEdgeKeys(fm)).toEqual(new Set(['superseded_by']));
    expect(extractFrontmatterEdges(fm)).toEqual([]); // node header shows it as a banner, not an edge
  });

  test('excludes superseded_by when it is not a ref (null, or unparseable text)', () => {
    expect(propertyEdgeKeys({ superseded_by: null })).toEqual(new Set());
    expect(propertyEdgeKeys({ superseded_by: 'not a ref' })).toEqual(new Set());
  });

  test('excludes a key holding plain, non-ref-shaped text', () => {
    expect(propertyEdgeKeys({ description: 'just some prose' })).toEqual(new Set());
  });

  test('a key with mixed ref/non-ref list items still counts (extractFrontmatterEdges semantics)', () => {
    expect(propertyEdgeKeys({ mixed: ['concept:a', 'plain text'] })).toEqual(new Set(['mixed']));
  });

  test('empty for undefined frontmatter', () => {
    expect(propertyEdgeKeys(undefined)).toEqual(new Set());
  });
});

describe('matchPropertyValues', () => {
  test('matches a single ref-shaped text value', () => {
    const matches = matchPropertyValues(['department:platform']);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ index: 0 });
    expect(matches[0].ref).toMatchObject({ kind: 'id', type: 'department', id: 'platform', full: 'department:platform' });
  });

  test('matches list values in order, skipping non-ref items and keeping their original index', () => {
    const matches = matchPropertyValues(['document:design-spec', 'not a ref', 'document:other']);
    expect(matches.map((m) => m.index)).toEqual([0, 2]);
    expect(matches[0].ref).toMatchObject({ full: 'document:design-spec' });
    expect(matches[1].ref).toMatchObject({ full: 'document:other' });
  });

  test('matches a loose end', () => {
    const matches = matchPropertyValues(['?person: someone from logistics']);
    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toMatchObject({ kind: 'loose', descriptor: 'someone from logistics' });
  });

  test('matches an external (@pkg) ref', () => {
    const matches = matchPropertyValues(['@acme-security/standard:coding-style']);
    expect(matches[0].ref).toMatchObject({ kind: 'id', pkg: 'acme-security', full: '@acme-security/standard:coding-style' });
  });

  test('trims surrounding whitespace before parsing', () => {
    expect(matchPropertyValues(['  department:platform  '])).toHaveLength(1);
  });

  test('empty input yields no matches', () => {
    expect(matchPropertyValues([])).toEqual([]);
  });

  test('no matches when nothing is ref-shaped', () => {
    expect(matchPropertyValues(['plain text', '123', '', '   '])).toEqual([]);
  });
});

describe('nameFromResolveResult', () => {
  const base: ResolveResult = {
    id: 'concept:reference',
    type: 'concept',
    path: 'concepts/reference.md',
    frontmatter: {},
    superseded_by: null,
  };

  test('prefers frontmatter.name', () => {
    expect(nameFromResolveResult({ ...base, frontmatter: { name: 'Reference' } }, 'concept:reference')).toBe(
      'Reference',
    );
  });

  test('trims frontmatter.name', () => {
    expect(nameFromResolveResult({ ...base, frontmatter: { name: '  Reference  ' } }, 'concept:reference')).toBe(
      'Reference',
    );
  });

  test('falls back to the path basename when name is absent', () => {
    expect(nameFromResolveResult(base, 'concept:reference')).toBe('reference');
  });

  test('falls back to the path basename when name is blank', () => {
    expect(nameFromResolveResult({ ...base, frontmatter: { name: '   ' } }, 'concept:reference')).toBe('reference');
  });

  test('falls back to the caller-supplied fallback when path is empty', () => {
    expect(nameFromResolveResult({ ...base, path: '' }, 'concept:reference')).toBe('concept:reference');
  });
});

// ---- feat/lp-inline-names ("B" variant) pure helpers -------------------------------------

describe('computeFencedLines', () => {
  test('no fences: every line is unfenced', () => {
    expect(computeFencedLines(['# Title', 'Some [[type:id]] text', ''])).toEqual([false, false, false]);
  });

  test('a fenced block, including its delimiters, is marked fenced', () => {
    const lines = ['before', '```', 'code [[type:id]] here', '```', 'after'];
    expect(computeFencedLines(lines)).toEqual([false, true, true, true, false]);
  });

  test('an unclosed fence runs to the end of the document', () => {
    const lines = ['before', '```ts', 'code', 'more code'];
    expect(computeFencedLines(lines)).toEqual([false, true, true, true]);
  });

  test('tilde fences toggle too', () => {
    const lines = ['~~~', 'code', '~~~', 'text'];
    expect(computeFencedLines(lines)).toEqual([true, true, true, false]);
  });

  test('a fence indented up to 3 spaces still toggles', () => {
    const lines = ['  ```', 'code', '  ```'];
    expect(computeFencedLines(lines)).toEqual([true, true, true]);
  });

  test('two separate fenced blocks each toggle independently', () => {
    const lines = ['```', 'a', '```', 'text', '```', 'b', '```'];
    expect(computeFencedLines(lines)).toEqual([true, true, true, false, true, true, true]);
  });

  test('empty input', () => {
    expect(computeFencedLines([])).toEqual([]);
  });
});

describe('isInlineCodeAtColumn', () => {
  test('false before any backtick', () => {
    expect(isInlineCodeAtColumn('`code` and [[type:id]]', 0)).toBe(false);
  });

  test('false after a balanced inline code span', () => {
    const line = '`code` and [[type:id]]';
    expect(isInlineCodeAtColumn(line, line.indexOf('[['))).toBe(false);
  });

  test('true inside an open inline code span', () => {
    const line = '`code [[type:id]]` more';
    expect(isInlineCodeAtColumn(line, line.indexOf('[['))).toBe(true);
  });

  test('a column of 0 is never inside code', () => {
    expect(isInlineCodeAtColumn('`code`', 0)).toBe(false);
  });

  test('a negative column is treated as 0', () => {
    expect(isInlineCodeAtColumn('`code`', -5)).toBe(false);
  });
});

describe('lineIntersectsSelection', () => {
  test('a cursor (empty range) inside the line intersects', () => {
    expect(lineIntersectsSelection(10, 20, [{ from: 15, to: 15 }])).toBe(true);
  });

  test('a range fully before the line does not intersect', () => {
    expect(lineIntersectsSelection(10, 20, [{ from: 0, to: 5 }])).toBe(false);
  });

  test('a range fully after the line does not intersect', () => {
    expect(lineIntersectsSelection(10, 20, [{ from: 25, to: 30 }])).toBe(false);
  });

  test('a range touching exactly at the line end boundary intersects', () => {
    expect(lineIntersectsSelection(10, 20, [{ from: 20, to: 25 }])).toBe(true);
  });

  test('a range touching exactly at the line start boundary intersects', () => {
    expect(lineIntersectsSelection(10, 20, [{ from: 0, to: 10 }])).toBe(true);
  });

  test('any one of several ranges intersecting is enough', () => {
    expect(
      lineIntersectsSelection(10, 20, [
        { from: 0, to: 5 },
        { from: 12, to: 12 },
      ]),
    ).toBe(true);
  });

  test('no ranges at all does not intersect', () => {
    expect(lineIntersectsSelection(10, 20, [])).toBe(false);
  });
});

describe('chooseLivePreviewDisplayText', () => {
  test('the author-supplied display wins over everything else', () => {
    expect(chooseLivePreviewDisplayText('Display', 'Local', 'Cached', 'concept:x')).toBe('Display');
  });

  test('falls back to the local node name when there is no display', () => {
    expect(chooseLivePreviewDisplayText(undefined, 'Local', 'Cached', 'concept:x')).toBe('Local');
  });

  test('falls back to a cached CLI-resolved name when there is no local node', () => {
    expect(chooseLivePreviewDisplayText(undefined, undefined, 'Cached', 'concept:x')).toBe('Cached');
  });

  test('falls back to the bare address when nothing else is known', () => {
    expect(chooseLivePreviewDisplayText(undefined, undefined, undefined, 'concept:x')).toBe('concept:x');
  });

  test('an empty-string display is treated as absent', () => {
    expect(chooseLivePreviewDisplayText('', 'Local', undefined, 'concept:x')).toBe('Local');
  });

  test('null is treated the same as undefined for local/cached names', () => {
    expect(chooseLivePreviewDisplayText(undefined, null, null, 'concept:x')).toBe('concept:x');
  });
});

describe('navDisplayText', () => {
  const node = { name: 'Loose end', full: 'concept:loose-end' };
  test('node mode shows the name', () => {
    expect(navDisplayText(node, 'node')).toBe('Loose end');
  });
  test('id mode shows the full address, including a scope', () => {
    expect(navDisplayText(node, 'id')).toBe('concept:loose-end');
    expect(navDisplayText({ name: 'index', full: 'cli:vaire/command:index' }, 'id')).toBe('cli:vaire/command:index');
  });
  test('file mode keeps the basename', () => {
    expect(navDisplayText(node, 'file')).toBeNull();
  });
});

describe('navDecorationKey', () => {
  test('combines type, name and gone into one string', () => {
    expect(navDecorationKey({ type: 'concept', name: 'Reference', gone: false })).toBe('concept|Reference|0');
    expect(navDecorationKey({ type: 'concept', name: 'Reference', gone: true })).toBe('concept|Reference|1');
  });

  test('changes when the type changes', () => {
    const a = navDecorationKey({ type: 'concept', name: 'X', gone: false });
    const b = navDecorationKey({ type: 'document', name: 'X', gone: false });
    expect(a).not.toBe(b);
  });

  test('changes when the name changes', () => {
    const a = navDecorationKey({ type: 'concept', name: 'X', gone: false });
    const b = navDecorationKey({ type: 'concept', name: 'Y', gone: false });
    expect(a).not.toBe(b);
  });

  test('changes when gone toggles', () => {
    const a = navDecorationKey({ type: 'concept', name: 'X', gone: false });
    const b = navDecorationKey({ type: 'concept', name: 'X', gone: true });
    expect(a).not.toBe(b);
  });

  test('stable for identical inputs (same key means skip re-decoration)', () => {
    const key = (name: string) => navDecorationKey({ type: 'concept', name, gone: false });
    expect(key('Reference')).toBe(key('Reference'));
  });
});

describe('shouldDecorateRow', () => {
  test('true when dataPath exactly matches a package dir', () => {
    expect(shouldDecorateRow('packages/vaire', ['packages/vaire', 'packages/other'])).toBe(true);
  });

  test('false when dataPath is not a package dir', () => {
    expect(shouldDecorateRow('packages/vaire/concepts', ['packages/vaire'])).toBe(false);
  });

  test('false when there are no package dirs at all', () => {
    expect(shouldDecorateRow('packages/vaire', [])).toBe(false);
  });

  test('a vault-root package (dir === "") matches an empty dataPath', () => {
    expect(shouldDecorateRow('', [''])).toBe(true);
  });

  test('does not match on a mere prefix — exact dir equality only', () => {
    expect(shouldDecorateRow('packages/vaire-extra', ['packages/vaire'])).toBe(false);
  });
});
