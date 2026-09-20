import { describe, expect, test } from 'bun:test';
import {
  displayNameFrom,
  extractFrontmatterEdges,
  formatRef,
  isVaireLinkTarget,
  parseRef,
  parseWikilinkText,
  statusDot,
  type IdRef,
} from '../src/ids';

describe('parseRef — grammar', () => {
  test('type:id', () => {
    const ref = parseRef('concept:reference');
    expect(ref).toEqual({
      kind: 'id',
      pkg: undefined,
      scope: undefined,
      type: 'concept',
      id: 'reference',
      full: 'concept:reference',
      local: 'concept:reference',
      display: undefined,
    });
  });

  test('scoped: ctype:cid/type:local', () => {
    const ref = parseRef('cli:vaire/command:index');
    expect(ref).toEqual({
      kind: 'id',
      pkg: undefined,
      scope: 'cli:vaire',
      type: 'command',
      id: 'index',
      full: 'cli:vaire/command:index',
      local: 'cli:vaire/command:index',
      display: undefined,
    });
  });

  test('@pkg/type:id', () => {
    const ref = parseRef('@acme-security/standard:coding-style');
    expect(ref).toEqual({
      kind: 'id',
      pkg: 'acme-security',
      scope: undefined,
      type: 'standard',
      id: 'coding-style',
      full: '@acme-security/standard:coding-style',
      local: 'standard:coding-style',
      display: undefined,
    });
  });

  test('@pkg/ctype:cid/type:local', () => {
    const ref = parseRef('@acme/cli:vaire/command:index');
    expect(ref).toEqual({
      kind: 'id',
      pkg: 'acme',
      scope: 'cli:vaire',
      type: 'command',
      id: 'index',
      full: '@acme/cli:vaire/command:index',
      local: 'cli:vaire/command:index',
      display: undefined,
    });
  });

  test('?type: descriptor', () => {
    const ref = parseRef('?person: someone from logistics');
    expect(ref).toEqual({
      kind: 'loose',
      typeHint: 'person',
      descriptor: 'someone from logistics',
      raw: '?person: someone from logistics',
      display: undefined,
    });
  });

  test('?: descriptor (no type hint)', () => {
    const ref = parseRef('?: the broker thing');
    expect(ref).toEqual({
      kind: 'loose',
      typeHint: undefined,
      descriptor: 'the broker thing',
      raw: '?: the broker thing',
      display: undefined,
    });
  });

  test('|display is carried alongside for id refs', () => {
    const ref = parseRef('concept:reference|Reference') as IdRef;
    expect(ref.kind).toBe('id');
    expect(ref.display).toBe('Reference');
    expect(ref.full).toBe('concept:reference');
  });

  test('|display is carried alongside for loose refs', () => {
    const ref = parseRef('?person: someone senior|someone senior');
    expect(ref).toMatchObject({ kind: 'loose', descriptor: 'someone senior', display: 'someone senior' });
  });

  test('whitespace around the target is trimmed', () => {
    expect(parseRef('  concept:reference  ')).toMatchObject({ kind: 'id', full: 'concept:reference' });
  });

  test('whitespace around the loose-end descriptor is lenient', () => {
    expect(parseRef('?person:someone')).toMatchObject({ typeHint: 'person', descriptor: 'someone' });
    expect(parseRef('?person:   someone  ')).toMatchObject({ typeHint: 'person', descriptor: 'someone' });
    expect(parseRef('? : someone')).toMatchObject({ typeHint: undefined, descriptor: 'someone' });
  });

  test('rejects an ordinary note title', () => {
    expect(parseRef('Some Note')).toBeNull();
  });

  test('rejects a folder-qualified note link', () => {
    expect(parseRef('folder/Note')).toBeNull();
  });

  test('rejects a heading link', () => {
    expect(parseRef('note#heading')).toBeNull();
  });

  test('rejects empty text', () => {
    expect(parseRef('')).toBeNull();
    expect(parseRef('   ')).toBeNull();
  });
});

describe('parseWikilinkText', () => {
  test('strips surrounding [[ ]]', () => {
    expect(parseWikilinkText('[[concept:reference]]')).toBe('concept:reference');
    expect(parseWikilinkText('[[concept:reference|Reference]]')).toBe('concept:reference|Reference');
  });

  test('leaves unbracketed text unchanged', () => {
    expect(parseWikilinkText('concept:reference')).toBe('concept:reference');
  });
});

describe('formatRef', () => {
  const ref = parseRef('concept:reference') as IdRef;

  test('without display', () => {
    expect(formatRef(ref)).toBe('[[concept:reference]]');
  });

  test('with display', () => {
    expect(formatRef(ref, 'Reference')).toBe('[[concept:reference|Reference]]');
  });
});

describe('isVaireLinkTarget', () => {
  test('true for ids and loose ends', () => {
    expect(isVaireLinkTarget('concept:reference')).toBe(true);
    expect(isVaireLinkTarget('@acme-security/standard:coding-style')).toBe(true);
    expect(isVaireLinkTarget('?person: someone')).toBe(true);
    expect(isVaireLinkTarget('?: someone')).toBe(true);
  });

  test('false for ordinary links', () => {
    expect(isVaireLinkTarget('Some Note')).toBe(false);
    expect(isVaireLinkTarget('folder/Note')).toBe(false);
    expect(isVaireLinkTarget('note#heading')).toBe(false);
  });
});

describe('extractFrontmatterEdges', () => {
  // The `resolve concept:reference` sample from DESIGN.md.
  const resolveSampleFrontmatter = {
    aliases: ['wikilink', 'reference target', 'cross-package reference'],
    documented_in: ['document:design-spec', 'document:packages-spec'],
    updated: '2026-08-06',
    name: 'Reference',
  };

  test('picks up only ref-shaped keys, in authored order, skipping bookkeeping keys', () => {
    const edges = extractFrontmatterEdges(resolveSampleFrontmatter);
    expect(edges).toHaveLength(1);
    expect(edges[0].key).toBe('documented_in');
    expect(edges[0].values).toEqual([
      expect.objectContaining({ kind: 'id', full: 'document:design-spec' }),
      expect.objectContaining({ kind: 'id', full: 'document:packages-spec' }),
    ]);
  });

  test('mixed ref/text values are kept in order; text-only keys are dropped; loose ends count as refs', () => {
    const fm = {
      id: 'x',
      type: 'concept',
      name: 'X',
      aliases: ['a'],
      updated: '2026-01-01',
      since: '0.1.0',
      superseded_by: null,
      owner: 'concept:someone',
      note: 'just text, not a reference',
      mixed: ['concept:a', 'plain text', '?person: someone'],
    };
    const edges = extractFrontmatterEdges(fm);
    const keys = edges.map((e) => e.key);
    expect(keys).toEqual(['owner', 'mixed']);

    const mixed = edges.find((e) => e.key === 'mixed')!;
    expect(mixed.values).toEqual([
      expect.objectContaining({ kind: 'id', full: 'concept:a' }),
      { kind: 'text', text: 'plain text' },
      expect.objectContaining({ kind: 'loose', descriptor: 'someone' }),
    ]);
  });

  test('returns [] for undefined frontmatter', () => {
    expect(extractFrontmatterEdges(undefined)).toEqual([]);
  });
});

describe('displayNameFrom', () => {
  test('frontmatter.name wins', () => {
    expect(displayNameFrom({ name: 'Reference' }, 'Some heading', 'reference')).toBe('Reference');
  });

  test('falls back to the first H1', () => {
    expect(displayNameFrom({}, 'Reference', 'reference')).toBe('Reference');
    expect(displayNameFrom({ name: '   ' }, 'Reference', 'reference')).toBe('Reference');
  });

  test('falls back to the file basename', () => {
    expect(displayNameFrom({}, undefined, 'reference')).toBe('reference');
    expect(displayNameFrom(undefined, undefined, 'reference')).toBe('reference');
  });
});

describe('statusDot', () => {
  test('ok statuses', () => {
    for (const s of ['production', 'active', 'live', 'running', 'current', 'Active']) {
      expect(statusDot(s)).toBe('ok');
    }
  });

  test('warn statuses', () => {
    for (const s of ['decommissioning', 'deprecated', 'migrating', 'draft', 'planned', 'proposed']) {
      expect(statusDot(s)).toBe('warn');
    }
  });

  test('off statuses', () => {
    for (const s of ['decommissioned', 'retired', 'archived', 'stopped', 'gone', 'superseded']) {
      expect(statusDot(s)).toBe('off');
    }
  });

  test('unknown or non-string status', () => {
    expect(statusDot('something-else')).toBeNull();
    expect(statusDot(undefined)).toBeNull();
    expect(statusDot(42)).toBeNull();
  });
});
