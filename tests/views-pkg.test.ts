import { describe, expect, test } from 'bun:test';
import {
  describeFinding,
  dropLeadingH1,
  groupNodes,
  packageRelativePath,
  shortCommit,
  vaultPathFor,
  type NodeLike,
} from '../src/views/pure-pkg';

function node(overrides: Partial<NodeLike> & Pick<NodeLike, 'type' | 'id' | 'full' | 'name'>): NodeLike {
  return { aliases: [], ...overrides };
}

describe('groupNodes', () => {
  const nodes: NodeLike[] = [
    node({ type: 'concept', id: 'b-concept', full: 'concept:b-concept', name: 'Banana' }),
    node({ type: 'concept', id: 'a-concept', full: 'concept:a-concept', name: 'apple' }),
    node({ type: 'concept', id: 'z-concept', full: 'concept:z-concept', name: 'Apple' }), // tie on name, case-insensitive
    node({ type: 'guide', id: 'g1', full: 'guide:g1', name: 'Getting started', aliases: ['onboarding'] }),
    node({
      type: 'guide',
      id: 'g2',
      full: 'guide:g2',
      name: 'Old guide',
      supersededBy: 'guide:g1',
    }),
  ];

  test('groups by type, sorted by type slug', () => {
    const groups = groupNodes(nodes);
    expect(groups.map((g) => g.type)).toEqual(['concept', 'guide']);
    expect(groups.map((g) => g.count)).toEqual([3, 2]);
  });

  test('sorts nodes case-insensitively by name, tie-broken by full id', () => {
    const groups = groupNodes(nodes);
    const concept = groups.find((g) => g.type === 'concept')!;
    // "apple" and "Apple" tie on name (case-insensitive) -> broken by full id ascending.
    expect(concept.nodes.map((n) => n.full)).toEqual(['concept:a-concept', 'concept:z-concept', 'concept:b-concept']);
  });

  test('flags superseded nodes as gone without excluding them', () => {
    const groups = groupNodes(nodes);
    const guide = groups.find((g) => g.type === 'guide')!;
    const old = guide.nodes.find((n) => n.id === 'g2')!;
    const current = guide.nodes.find((n) => n.id === 'g1')!;
    expect(old.gone).toBe(true);
    expect(current.gone).toBe(false);
  });

  test('filters by exact type', () => {
    const groups = groupNodes(nodes, { type: 'guide' });
    expect(groups.map((g) => g.type)).toEqual(['guide']);
  });

  test('filters by text against id, full id, name and aliases (case-insensitive)', () => {
    expect(groupNodes(nodes, { text: 'banana' }).flatMap((g) => g.nodes.map((n) => n.id))).toEqual(['b-concept']);
    expect(groupNodes(nodes, { text: 'concept:' }).flatMap((g) => g.nodes.map((n) => n.id))).toEqual([
      'a-concept',
      'z-concept',
      'b-concept',
    ]);
    expect(groupNodes(nodes, { text: 'onboarding' }).flatMap((g) => g.nodes.map((n) => n.id))).toEqual(['g1']);
    expect(groupNodes(nodes, { text: 'nonexistent' })).toEqual([]);
  });

  test('combines type and text filters', () => {
    const groups = groupNodes(nodes, { type: 'concept', text: 'apple' });
    expect(groups).toHaveLength(1);
    expect(groups[0].nodes.map((n) => n.id)).toEqual(['a-concept', 'z-concept']);
  });
});

describe('describeFinding', () => {
  test('missing_dependency: {kind, package, note}', () => {
    const described = describeFinding({
      kind: 'missing_dependency',
      package: 'acme-org',
      note: "dependency error: dependency 'acme-org' is not linked",
    });
    expect(described).toEqual({
      title: 'missing dependency: acme-org',
      detail: "dependency error: dependency 'acme-org' is not linked",
      path: undefined,
      line: undefined,
    });
  });

  test('dangling_ref: {kind, from, to, path, line}', () => {
    const described = describeFinding({
      kind: 'dangling_ref',
      from: 'application:5s-cleaning',
      to: 'record:nope',
      path: 'archive/applications/5s-cleaning.md',
      line: 19,
    });
    expect(described).toEqual({
      title: 'dangling reference',
      detail: 'application:5s-cleaning → record:nope',
      path: 'archive/applications/5s-cleaning.md',
      line: 19,
    });
  });

  test('drift: {kind, id, to, path, line}', () => {
    const described = describeFinding({
      kind: 'drift',
      id: 'application:5s-cleaning',
      to: 'record:2026-07-14-portainer-container-inventory',
      path: 'archive/applications/5s-cleaning.md',
      line: 19,
    });
    expect(described).toEqual({
      title: 'drift',
      detail: 'application:5s-cleaning → record:2026-07-14-portainer-container-inventory',
      path: 'archive/applications/5s-cleaning.md',
      line: 19,
    });
  });

  test('orphan: {kind, id, path}', () => {
    const described = describeFinding({ kind: 'orphan', id: 'concept:unused', path: 'concepts/unused.md' });
    expect(described).toEqual({ title: 'orphan', detail: 'concept:unused', path: 'concepts/unused.md', line: undefined });
  });

  test('unknown kind falls back to whichever fields are present', () => {
    const described = describeFinding({ kind: 'unused_dependency', package: 'acme-ppl' });
    expect(described.title).toBe('unused_dependency');
    expect(described.detail).toContain('acme-ppl');
  });

  test('frontmatter_wikilink: {kind, id, field, path} — no line, field surfaced in detail', () => {
    const described = describeFinding({
      kind: 'frontmatter_wikilink',
      id: 'department:hr',
      field: 'owner',
      path: 'departments/hr.md',
    });
    expect(described).toEqual({
      title: 'frontmatter_wikilink',
      detail: "department:hr field 'owner'",
      path: 'departments/hr.md',
      line: undefined,
    });
  });

  test('unknown_type: {kind, id, field, value, path} — no line, field+value surfaced', () => {
    const described = describeFinding({
      kind: 'unknown_type',
      id: 'department:hr',
      field: 'owner',
      value: 'team:alpha',
      path: 'departments/hr.md',
    });
    expect(described).toEqual({
      title: 'unknown_type',
      detail: "department:hr field 'owner': 'team:alpha'",
      path: 'departments/hr.md',
      line: undefined,
    });
  });

  test('duplicate_id: {kind, id, paths} — file count surfaced', () => {
    const described = describeFinding({
      kind: 'duplicate_id',
      id: 'department:hr',
      paths: ['a.md', 'b.md'],
    });
    expect(described).toEqual({
      title: 'duplicate_id',
      detail: 'department:hr in 2 files',
      path: undefined,
      line: undefined,
    });
  });

  test('undeclared_import: {kind, package, from, to, path, line}', () => {
    const described = describeFinding({
      kind: 'undeclared_import',
      package: 'acme-core',
      from: 'record:a',
      to: '@acme-core/team:platform',
      path: 'records/a.md',
      line: 4,
    });
    expect(described).toEqual({
      title: 'undeclared_import',
      detail: 'record:a → @acme-core/team:platform acme-core',
      path: 'records/a.md',
      line: 4,
    });
  });
});

describe('packageRelativePath', () => {
  test('strips the package dir prefix when non-empty', () => {
    expect(packageRelativePath('packages/acme-platform/current/vm/foo.md', 'packages/acme-platform')).toBe(
      'current/vm/foo.md',
    );
  });

  test('returns the path unchanged for a root-level package', () => {
    expect(packageRelativePath('current/vm/foo.md', '')).toBe('current/vm/foo.md');
  });

  test('returns the path unchanged when it is not under the dir', () => {
    expect(packageRelativePath('other/foo.md', 'packages/acme-platform')).toBe('other/foo.md');
  });
});

describe('vaultPathFor', () => {
  test('joins a relative path back onto a non-empty package dir', () => {
    expect(vaultPathFor('packages/acme-platform', 'current/vm/foo.md')).toBe(
      'packages/acme-platform/current/vm/foo.md',
    );
  });

  test('is a no-op for a root-level package', () => {
    expect(vaultPathFor('', 'current/vm/foo.md')).toBe('current/vm/foo.md');
  });

  test('round-trips with packageRelativePath', () => {
    const dir = 'packages/acme-platform';
    const full = 'packages/acme-platform/current/vm/foo.md';
    expect(vaultPathFor(dir, packageRelativePath(full, dir))).toBe(full);
  });
});

describe('shortCommit', () => {
  test('takes the first 7 characters', () => {
    expect(shortCommit('7b3a35e6690b4f618a0d86ba144440820c200d90')).toBe('7b3a35e');
  });

  test('handles null/undefined/empty', () => {
    expect(shortCommit(null)).toBe('');
    expect(shortCommit(undefined)).toBe('');
    expect(shortCommit('')).toBe('');
  });

  test('passes through a sha shorter than 7 characters', () => {
    expect(shortCommit('abc')).toBe('abc');
  });
});

describe('dropLeadingH1', () => {
  test('drops a leading H1 and surrounding blank lines', () => {
    expect(dropLeadingH1('# Title\n\nBody text.\n')).toBe('Body text.\n');
    expect(dropLeadingH1('\n\n# Title\n\n\nBody text.')).toBe('Body text.');
  });

  test('leaves text unchanged when it does not start with an H1', () => {
    expect(dropLeadingH1('Just some prose.\n\n# Not first')).toBe('Just some prose.\n\n# Not first');
  });

  test('leaves an H2 alone', () => {
    expect(dropLeadingH1('## Subheading\n\nBody')).toBe('## Subheading\n\nBody');
  });
});
