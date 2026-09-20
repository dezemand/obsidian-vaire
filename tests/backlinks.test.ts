import { describe, expect, test } from 'bun:test';
import {
  filterContexts,
  groupByNode,
  snippetForLine,
  type BacklinkContext,
} from '../src/views/pure-backlinks';

describe('snippetForLine', () => {
  test('finds a single inline wikilink hit and splits before/after around it', () => {
    const line = '[[concept:loose-end|loose ends]], the derived index, hybrid search, integrity checks,';
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).toEqual({
      before: '',
      hit: '[[concept:loose-end|loose ends]]',
      after: ', the derived index, hybrid search, integrity checks,',
    });
  });

  test('finds the right link on a line with two wikilinks, ignoring the one that does not match', () => {
    const line = 'See [[concept:alias|aliasing]] and also [[concept:loose-end|loose ends]] for more.';
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).toEqual({
      before: 'See [[concept:alias|aliasing]] and also ',
      hit: '[[concept:loose-end|loose ends]]',
      after: ' for more.',
    });
  });

  test('a wikilink with no display text still matches on the bare target', () => {
    const line = 'as declared [[concept:dependency]] between packages';
    const snippet = snippetForLine(line, 'concept:dependency');
    expect(snippet).toEqual({
      before: 'as declared ',
      hit: '[[concept:dependency]]',
      after: ' between packages',
    });
  });

  test('a cross-package @pkg/... link resolves against the bare local id', () => {
    const line = 'this concept is exactly [[@vaire/concept:loose-end|loose ends]] again';
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).toEqual({
      before: 'this concept is exactly ',
      hit: '[[@vaire/concept:loose-end|loose ends]]',
      after: ' again',
    });
  });

  test('a scoped target id matches a scoped wikilink', () => {
    const line = 'see [[cli:vaire/command:refs|the refs command]] for details';
    const snippet = snippetForLine(line, 'cli:vaire/command:refs');
    expect(snippet).toEqual({
      before: 'see ',
      hit: '[[cli:vaire/command:refs|the refs command]]',
      after: ' for details',
    });
  });

  test('a frontmatter flow-list line has no [[...]] syntax at all -> no hit, trimmed line kept', () => {
    const line = 'documented_in: [document:design-spec, document:packages-spec]';
    const snippet = snippetForLine(line, 'document:design-spec');
    expect(snippet).toEqual({
      before: 'documented_in: [document:design-spec, document:packages-spec]',
      hit: null,
      after: '',
    });
  });

  test('a line with wikilinks but none of them resolve to the target id -> no hit', () => {
    const line = 'related to [[concept:alias|aliasing]] and [[concept:record]], not this one';
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).toEqual({
      before: 'related to [[concept:alias|aliasing]] and [[concept:record]], not this one',
      hit: null,
      after: '',
    });
  });

  test('leading/trailing whitespace is trimmed before matching', () => {
    const line = '   [[concept:loose-end]] trailing text   ';
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).toEqual({ before: '', hit: '[[concept:loose-end]]', after: ' trailing text' });
  });

  test('blank line returns null', () => {
    expect(snippetForLine('', 'concept:loose-end')).toBeNull();
    expect(snippetForLine('   ', 'concept:loose-end')).toBeNull();
  });

  test('a plain non-matching line (no wikilinks) has no hit, trimmed line kept', () => {
    const snippet = snippetForLine('  just some ordinary prose with no links  ', 'concept:loose-end');
    expect(snippet).toEqual({ before: 'just some ordinary prose with no links', hit: null, after: '' });
  });

  test('caps a very long line to at most 160 characters while keeping the hit intact', () => {
    const before = 'a'.repeat(120);
    const after = 'b'.repeat(120);
    const line = `${before}[[concept:loose-end|loose ends]]${after}`;
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet).not.toBeNull();
    expect(snippet!.hit).toBe('[[concept:loose-end|loose ends]]');
    const total = snippet!.before.length + snippet!.hit!.length + snippet!.after.length;
    expect(total).toBeLessThanOrEqual(160);
    expect(snippet!.before.startsWith('…')).toBe(true);
    expect(snippet!.after.endsWith('…')).toBe(true);
  });

  test('caps a very long no-hit line to at most 160 characters', () => {
    const line = 'x'.repeat(300);
    const snippet = snippetForLine(line, 'concept:loose-end');
    expect(snippet!.hit).toBeNull();
    expect(snippet!.before.length).toBeLessThanOrEqual(160);
    expect(snippet!.before.endsWith('…')).toBe(true);
  });
});

function ctx(overrides: Partial<BacklinkContext> & Pick<BacklinkContext, 'id' | 'type' | 'path' | 'ref_type' | 'line'>): BacklinkContext {
  return { name: overrides.id, snippet: null, ...overrides };
}

describe('groupByNode', () => {
  const contexts: BacklinkContext[] = [
    ctx({ id: 'cli:vaire', type: 'cli', path: 'tools/vaire.md', ref_type: 'inline', line: 154, name: 'vaire' }),
    ctx({
      id: 'cli:vaire/command:refs',
      type: 'command',
      path: 'commands/refs.md',
      ref_type: 'inline',
      line: 18,
      name: 'refs',
    }),
    ctx({
      id: 'cli:vaire/command:render',
      type: 'command',
      path: 'commands/render.md',
      ref_type: 'inline',
      line: 32,
      name: 'render',
    }),
    ctx({
      id: 'release:0-2-1',
      type: 'release',
      path: 'releases/0-2-1.md',
      ref_type: 'added',
      line: 8,
      name: '0.2.1',
    }),
    ctx({
      id: 'release:0-2-1',
      type: 'release',
      path: 'releases/0-2-1.md',
      ref_type: 'inline',
      line: 67,
      name: '0.2.1',
    }),
    ctx({
      id: 'concept:reference',
      type: 'concept',
      path: 'foo.md',
      package: 'acme-security',
      ref_type: 'inline',
      line: 4,
      name: 'Reference (external)',
    }),
  ];

  test('groups rows from the same referencing node together (same file, two rows)', () => {
    const groups = groupByNode(contexts);
    const release = groups.find((g) => g.id === 'release:0-2-1' && !g.package);
    expect(release).toBeDefined();
    expect(release!.count).toBe(2);
    expect(release!.rows.map((r) => r.line)).toEqual([8, 67]); // sorted by line
  });

  test('does not merge same-id rows across different packages', () => {
    const groups = groupByNode(contexts);
    const external = groups.find((g) => g.id === 'concept:reference' && g.package === 'acme-security');
    expect(external).toBeDefined();
    expect(external!.count).toBe(1);
  });

  test('sorts groups by name case-insensitively, tie-broken by id', () => {
    const groups = groupByNode(contexts);
    const names = groups.map((g) => g.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  test('produces one group per distinct referencing node', () => {
    const groups = groupByNode(contexts);
    expect(groups).toHaveLength(5); // cli:vaire, command:refs, command:render, release:0-2-1, external concept:reference
  });
});

describe('filterContexts', () => {
  const contexts: BacklinkContext[] = [
    ctx({
      id: 'cli:vaire/command:refs',
      type: 'command',
      path: 'commands/refs.md',
      ref_type: 'inline',
      line: 18,
      name: 'refs',
      snippet: { before: 'see the ', hit: '[[concept:loose-end|refs command]]', after: ' for details' },
    }),
    ctx({
      id: 'release:0-2-1',
      type: 'release',
      path: 'releases/0-2-1.md',
      ref_type: 'added',
      line: 8,
      name: '0.2.1',
      snippet: null,
    }),
  ];

  test('empty query returns everything unchanged', () => {
    expect(filterContexts(contexts, '')).toEqual(contexts);
    expect(filterContexts(contexts, '   ')).toEqual(contexts);
  });

  test('matches the referencing node name, case-insensitively', () => {
    expect(filterContexts(contexts, 'REFS').map((c) => c.id)).toEqual(['cli:vaire/command:refs']);
  });

  test('matches the ref_type badge', () => {
    expect(filterContexts(contexts, 'added').map((c) => c.id)).toEqual(['release:0-2-1']);
  });

  test('matches snippet text (before/hit/after)', () => {
    expect(filterContexts(contexts, 'for details').map((c) => c.id)).toEqual(['cli:vaire/command:refs']);
    expect(filterContexts(contexts, 'loose-end').map((c) => c.id)).toEqual(['cli:vaire/command:refs']);
  });

  test('no match -> empty array', () => {
    expect(filterContexts(contexts, 'nonexistent-needle')).toEqual([]);
  });
});
