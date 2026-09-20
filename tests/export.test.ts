import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  citationFor,
  collectRefs,
  exportFileName,
  exportHeaderComment,
  localPortable,
  postProcessRendered,
  relativeLink,
  type LocalPortableContext,
} from '../src/export/pure';
import type { IdRef } from '../src/ids';
import type { RenderResult } from '../src/types';
import looseEndFixture from './fixtures/render-loose-end.json';
import standardFixture from './fixtures/render-standard-intake.json';

const VAIRE_REPO = '/repo/acme-core';
// A made-up package root under this test file's own directory — never read from disk itself,
// but `standardFixture`'s cross-package link (below) is a real relative path from here to the
// self-contained fixture package at tests/fixtures/corpus/acme-security/, so the
// `crossPackageLinks: 'address'` case (which does read its target off disk) works without any
// dependency on a real, external Vairë corpus.
const ACME_PLATFORM_REPO = path.join(import.meta.dir, 'fixtures', 'repo-acme-platform');

// ---- small pure helpers ----------------------------------------------------------------------

describe('relativeLink', () => {
  test('same directory -> ./sibling.md', () => {
    expect(relativeLink('concepts', 'concepts/reference.md')).toBe('./reference.md');
  });

  test('vault root -> nested path, no leading ./ collapse needed', () => {
    expect(relativeLink('', 'concepts/reference.md')).toBe('./concepts/reference.md');
  });

  test('sibling subtree -> ../ up and back down', () => {
    expect(relativeLink('records/2026', 'current/network-devices/cat230-67.md')).toBe(
      '../../current/network-devices/cat230-67.md',
    );
  });

  test('works on real absolute filesystem paths too', () => {
    const rel = relativeLink(path.join(ACME_PLATFORM_REPO, 'records/2026'), path.join(ACME_PLATFORM_REPO, 'README.md'));
    expect(rel).toBe('../../README.md');
  });
});

describe('exportFileName', () => {
  test('replaces the colon in an unscoped id', () => {
    expect(exportFileName('concept:loose-end')).toBe('concept-loose-end.md');
  });

  test('replaces both the slash and the colons in a scoped id', () => {
    expect(exportFileName('cli:vaire/command:render')).toBe('cli-vaire-command-render.md');
  });
});

describe('exportHeaderComment', () => {
  test('formats the render-mode comment', () => {
    expect(exportHeaderComment('concept:loose-end', 'render', '2026-09-16')).toBe(
      '<!-- exported from vaire: concept:loose-end via render on 2026-09-16 -->',
    );
  });

  test('formats the local-mode comment', () => {
    expect(exportHeaderComment('record:x', 'local', '2026-09-16')).toBe(
      '<!-- exported from vaire: record:x via local on 2026-09-16 -->',
    );
  });
});

describe('citationFor', () => {
  test('unscoped node', () => {
    expect(citationFor({ full: 'concept:loose-end', name: 'Loose end' }, { name: 'vaire', version: '0.3.2' })).toBe(
      'Loose end (concept:loose-end, vaire@0.3.2)',
    );
  });

  test('scoped node keeps the scope in the address', () => {
    expect(
      citationFor({ full: 'cli:vaire/command:render', name: 'render' }, { name: 'vaire', version: '0.3.2' }),
    ).toBe('render (cli:vaire/command:render, vaire@0.3.2)');
  });
});

// ---- local mode -------------------------------------------------------------------------------

function fakeLocalIndex(entries: Record<string, { path: string; name: string }>) {
  return (ref: IdRef): { path: string; name: string } | null => entries[ref.local] ?? null;
}

describe('localPortable', () => {
  const baseMarkdown = [
    '---',
    'id: intake',
    'type: record',
    'related: concept:a',
    '---',
    '# Title',
    '',
    'See [[concept:a]] and [[concept:b|Custom name]].',
  ].join('\n');

  test('resolves a bare id via LocalIndex into a relative markdown link', () => {
    const ctx: LocalPortableContext = {
      fromDir: 'records',
      resolveLocal: fakeLocalIndex({ 'concept:a': { path: 'concepts/a.md', name: 'Concept A' } }),
    };
    const out = localPortable('[[concept:a]]', ctx);
    expect(out).toContain('[Concept A](../concepts/a.md)');
  });

  test('an explicit |display overrides the resolved name', () => {
    const ctx: LocalPortableContext = {
      fromDir: 'records',
      resolveLocal: fakeLocalIndex({ 'concept:b': { path: 'concepts/b.md', name: 'Concept B' } }),
    };
    const out = localPortable('[[concept:b|Custom name]]', ctx);
    expect(out).toContain('[Custom name](../concepts/b.md)');
  });

  test('a scoped id resolves through its full local address', () => {
    const ctx: LocalPortableContext = {
      fromDir: '',
      resolveLocal: fakeLocalIndex({
        'cli:vaire/command:render': { path: 'commands/render.md', name: 'render' },
      }),
    };
    const out = localPortable('[[cli:vaire/command:render]]', ctx);
    expect(out).toContain('[render](./commands/render.md)');
  });

  test('a loose end degrades to its plain descriptor text, no brackets', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
    const out = localPortable('[[?person: someone from logistics]]', ctx);
    expect(out.trim()).toBe('someone from logistics');
  });

  test('markUnresolved appends "(unresolved)" to a loose end', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null, markUnresolved: true };
    const out = localPortable('[[?person: someone from logistics]]', ctx);
    expect(out.trim()).toBe('someone from logistics (unresolved)');
  });

  test('a same-package id LocalIndex does not know degrades to its bare address', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
    const out = localPortable('[[concept:nope]]', ctx);
    expect(out.trim()).toBe('concept:nope');
  });

  test('markUnresolved also marks a dangling same-package id', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null, markUnresolved: true };
    const out = localPortable('[[concept:nope]]', ctx);
    expect(out.trim()).toBe('concept:nope (unresolved)');
  });

  test('an @pkg ref that resolves locally (also a vault package) becomes a relative link', () => {
    const ctx: LocalPortableContext = {
      fromDir: '',
      resolveLocal: fakeLocalIndex({ 'standard:coding-style': { path: 'standards/coding-style.md', name: 'Coding Style' } }),
    };
    const out = localPortable('[[@acme-security/standard:coding-style]]', ctx);
    expect(out.trim()).toBe('[Coding Style](./standards/coding-style.md)');
  });

  test('an @pkg ref with no local match and no cached name falls back to the bare address', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
    const out = localPortable('[[@acme-security/standard:coding-style]]', ctx);
    expect(out.trim()).toBe('@acme-security/standard:coding-style');
  });

  test('an @pkg ref with a cached name (from plugin.resolveViaCli) becomes "Name (@pkg/type:id)"', () => {
    const ctx: LocalPortableContext = {
      fromDir: '',
      resolveLocal: () => null,
      knownExternalName: (ref) => (ref.full === '@acme-security/standard:coding-style' ? 'Coding Style' : undefined),
    };
    const out = localPortable('[[@acme-security/standard:coding-style]]', ctx);
    expect(out.trim()).toBe('Coding Style (@acme-security/standard:coding-style)');
  });

  test('code fences are left untouched, including fake-looking wikilink text inside them', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
    const markdown = ['before [[concept:nope]]', '```text', '[[?person: fake, not a real loose end]]', '```', 'after'].join(
      '\n',
    );
    const out = localPortable(markdown, ctx);
    expect(out).toContain('```text\n[[?person: fake, not a real loose end]]\n```');
  });

  test('frontmatter is kept verbatim', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null, edgesSection: false };
    const out = localPortable(baseMarkdown, ctx);
    expect(out).toContain('---\nid: intake\ntype: record\nrelated: concept:a\n---\n');
  });

  test('an ordinary (non-Vairë) wikilink is left alone', () => {
    const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
    const out = localPortable('See [[Some Note]] for more.', ctx);
    expect(out).toContain('[[Some Note]]');
  });

  describe('edges section', () => {
    const md = ['---', 'id: x', 'type: record', 'owner: person:alice', 'related: [concept:a, concept:b]', '---', '# X'].join(
      '\n',
    );

    test('appends a "## Relations" list resolving each frontmatter edge, on by default', () => {
      const ctx: LocalPortableContext = {
        fromDir: '',
        resolveLocal: fakeLocalIndex({
          'person:alice': { path: 'people/alice.md', name: 'Alice' },
          'concept:a': { path: 'concepts/a.md', name: 'A' },
          'concept:b': { path: 'concepts/b.md', name: 'B' },
        }),
      };
      const out = localPortable(md, ctx);
      expect(out).toContain('## Relations');
      expect(out).toContain('- **owner**: [Alice](./people/alice.md)');
      expect(out).toContain('- **related**: [A](./concepts/a.md), [B](./concepts/b.md)');
    });

    test('edgesSection: false omits the section entirely', () => {
      const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null, edgesSection: false };
      const out = localPortable(md, ctx);
      expect(out).not.toContain('## Relations');
    });

    test('no ref-shaped frontmatter -> no section even when edgesSection is on', () => {
      const ctx: LocalPortableContext = { fromDir: '', resolveLocal: () => null };
      const out = localPortable('---\nid: x\ntype: record\n---\n# X', ctx);
      expect(out).not.toContain('## Relations');
    });
  });
});

describe('collectRefs', () => {
  test('collects body wikilinks and frontmatter edges, skipping fences', () => {
    const md = [
      '---',
      'id: x',
      'type: record',
      'owner: person:alice',
      '---',
      '[[concept:a]]',
      '```text',
      '[[concept:fenced-out]]',
      '```',
    ].join('\n');
    const refs = collectRefs(md).filter((r): r is IdRef => r.kind === 'id');
    expect(refs.map((r) => r.full).sort()).toEqual(['concept:a', 'person:alice']);
  });
});

// ---- render mode --------------------------------------------------------------------------

const fixture = looseEndFixture as RenderResult;
const standard = standardFixture as RenderResult;

describe('postProcessRendered', () => {
  test('same-package links are rebased relative to exportDir and stay links', () => {
    const sourceDir = path.dirname(path.join(VAIRE_REPO, fixture.path));
    const exportDir = path.join(VAIRE_REPO, 'Vairë exports');
    const out = postProcessRendered(fixture.markdown, {
      repo: VAIRE_REPO,
      sourcePath: fixture.path,
      exportDir,
      crossPackageLinks: 'path',
    });
    // sourceDir is "concepts"; exportDir is the repo root's "Vairë exports" sibling folder, so a
    // same-package link one level up now needs an extra "../concepts/".
    expect(out).toContain('[Reference](../concepts/reference.md)');
    expect(sourceDir).toBe(path.join(VAIRE_REPO, 'concepts'));
  });

  test('same-package links round-trip unchanged when exportDir equals the source directory', () => {
    const sourceDir = path.dirname(path.join(VAIRE_REPO, fixture.path));
    const out = postProcessRendered(fixture.markdown, {
      repo: VAIRE_REPO,
      sourcePath: fixture.path,
      exportDir: sourceDir,
      crossPackageLinks: 'path',
    });
    expect(out).toContain('[Reference](./reference.md)');
    expect(out).toContain('[Entity-creation pass](./entity-creation-pass.md)');
  });

  test('code fences (including a literal loose-end example) are left untouched', () => {
    const sourceDir = path.dirname(path.join(VAIRE_REPO, fixture.path));
    const out = postProcessRendered(fixture.markdown, {
      repo: VAIRE_REPO,
      sourcePath: fixture.path,
      exportDir: sourceDir,
      crossPackageLinks: 'text',
    });
    expect(out).toContain('[[?person: someone from logistics]]      unresolved — type hint + descriptor');
  });

  test('frontmatter is never touched', () => {
    const sourceDir = path.dirname(path.join(VAIRE_REPO, fixture.path));
    const out = postProcessRendered(fixture.markdown, {
      repo: VAIRE_REPO,
      sourcePath: fixture.path,
      exportDir: sourceDir,
      crossPackageLinks: 'address',
    });
    expect(out).toContain('documented_in: [document:design-spec, document:packages-spec]');
  });

  describe('crossPackageLinks modes (standard-intake fixture: a cross-package href into acme-security)', () => {
    const sourceDir = path.dirname(path.join(ACME_PLATFORM_REPO, standard.path));
    const exportDir = path.join(ACME_PLATFORM_REPO, 'Vairë exports');

    test('"path" keeps it as a link, rebased to still resolve from exportDir', () => {
      const out = postProcessRendered(standard.markdown, {
        repo: ACME_PLATFORM_REPO,
        sourcePath: standard.path,
        exportDir,
        crossPackageLinks: 'path',
      });
      // Resolve the fixture's original href back to the real (self-contained, checked-in)
      // fixture file, then check our rebased href (read relative to exportDir) resolves to
      // that same file.
      const originalAbs = path.resolve(sourceDir, '../../../corpus/acme-security/standards/coding-style.md');
      expect(originalAbs).toBe(
        path.join(import.meta.dir, 'fixtures', 'corpus', 'acme-security', 'standards', 'coding-style.md'),
      );
      const match = /\[Coding Style Standard[^\]]*\]\(([^)]+)\)/.exec(out);
      expect(match).not.toBeNull();
      const rebasedAbs = path.resolve(exportDir, match![1]);
      expect(rebasedAbs).toBe(originalAbs);
    });

    test('"text" drops the link, keeping only the display text', () => {
      const out = postProcessRendered(standard.markdown, {
        repo: ACME_PLATFORM_REPO,
        sourcePath: standard.path,
        exportDir,
        crossPackageLinks: 'text',
      });
      expect(out).not.toContain('corpus/acme-security');
      expect(out).toContain('The Coding Style Standard — Acme Platform node');
    });

    test('"address" replaces it with "Display (@pkg/type:id)", recovered from the target file on disk', () => {
      const out = postProcessRendered(standard.markdown, {
        repo: ACME_PLATFORM_REPO,
        sourcePath: standard.path,
        exportDir,
        crossPackageLinks: 'address',
      });
      expect(out).toContain('Coding Style Standard — Acme Platform (@acme-security/standard:coding-style)');
    });

    test('the same-package link in this fixture is rebased regardless of crossPackageLinks mode', () => {
      const out = postProcessRendered(standard.markdown, {
        repo: ACME_PLATFORM_REPO,
        sourcePath: standard.path,
        exportDir,
        crossPackageLinks: 'address',
      });
      const match = /\[Record: policy-deck[^\]]*\]\(([^)]+)\)/.exec(out);
      expect(match).not.toBeNull();
      const rebasedAbs = path.resolve(exportDir, match![1]);
      expect(rebasedAbs).toBe(path.join(ACME_PLATFORM_REPO, 'records/2026/2026-07-14-policy-deck-extraction.md'));
    });
  });
});
