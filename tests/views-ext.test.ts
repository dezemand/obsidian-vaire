import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  describeRegistryShow,
  externalSourcePath,
  findPackageRoot,
  firstH1,
  frontmatterScalars,
  readManifest,
  relativeTime,
  rewriteRenderedLinks,
  shortPath,
  splitFrontmatter,
} from '../src/views/pure-ext';

// A handful of tests below need a real, on-disk Vairë package (to exercise `fs.existsSync` /
// `fs.readFileSync` against something real, not just path arithmetic) — set VAIRE_TEST_REPO to
// the absolute path of a package root (a directory with `knowledge.toml`) to run them; they are
// skipped otherwise. See README.md "Running the tests".
const VAIRE_TEST_REPO = process.env.VAIRE_TEST_REPO;

describe('splitFrontmatter', () => {
  test('splits a normal frontmatter block from the body', () => {
    const text = '---\nid: reference\ntype: concept\n---\n# Reference\n\nBody text.\n';
    const { frontmatterText, body } = splitFrontmatter(text);
    expect(frontmatterText).toBe('id: reference\ntype: concept');
    expect(body).toBe('# Reference\n\nBody text.\n');
  });

  test('no frontmatter -> empty frontmatterText, body unchanged', () => {
    const text = '# Just a heading\n\nNo frontmatter here.\n';
    const { frontmatterText, body } = splitFrontmatter(text);
    expect(frontmatterText).toBe('');
    expect(body).toBe(text);
  });

  test('CRLF line endings are tolerated', () => {
    const text = '---\r\nid: x\r\ntype: y\r\n---\r\n# H\r\nbody\r\n';
    const { frontmatterText, body } = splitFrontmatter(text);
    expect(frontmatterText).toBe('id: x\ntype: y');
    expect(body).toBe('# H\nbody\n');
  });

  test('empty frontmatter block', () => {
    const text = '---\n---\nbody only\n';
    const { frontmatterText, body } = splitFrontmatter(text);
    expect(frontmatterText).toBe('');
    expect(body).toBe('body only\n');
  });

  test('malformed (unterminated) frontmatter falls back to treating the whole thing as body', () => {
    const text = '---\nid: x\nno closing delimiter\n';
    const { frontmatterText, body } = splitFrontmatter(text);
    expect(frontmatterText).toBe('');
    expect(body).toBe(text);
  });
});

describe('firstH1', () => {
  test('finds the first level-1 heading', () => {
    expect(firstH1('# Title\n\nSome text\n## Subheading\n')).toBe('Title');
  });

  test('ignores ## and deeper headings', () => {
    expect(firstH1('## Not this\n\n# This one\n')).toBe('This one');
  });

  test('undefined when there is no H1', () => {
    expect(firstH1('Just prose, no headings.\n## only h2\n')).toBeUndefined();
  });

  test('CRLF line endings are tolerated', () => {
    expect(firstH1('intro\r\n# Title\r\nbody\r\n')).toBe('Title');
  });
});

describe('relativeTime', () => {
  const now = 1_800_000_000;

  test('just now for under 30s', () => {
    expect(relativeTime(now - 5, now)).toBe('just now');
    expect(relativeTime(now, now)).toBe('just now');
  });

  test('seconds', () => {
    expect(relativeTime(now - 45, now)).toBe('45 seconds ago');
  });

  test('minutes, hours, days, weeks, months, years — past', () => {
    expect(relativeTime(now - 5 * 60, now)).toBe('5 minutes ago');
    expect(relativeTime(now - 3 * 3600, now)).toBe('3 hours ago');
    expect(relativeTime(now - 2 * 86400, now)).toBe('2 days ago');
    expect(relativeTime(now - 9 * 86400, now)).toBe('1 week ago');
    expect(relativeTime(now - 60 * 86400, now)).toBe('2 months ago');
    expect(relativeTime(now - 400 * 86400, now)).toBe('1 year ago');
  });

  test('singular units', () => {
    expect(relativeTime(now - 60, now)).toBe('1 minute ago');
    expect(relativeTime(now - 3600, now)).toBe('1 hour ago');
    expect(relativeTime(now - 86400, now)).toBe('1 day ago');
  });

  test('future timestamps', () => {
    expect(relativeTime(now + 5 * 60, now)).toBe('in 5 minutes');
  });
});

describe('describeRegistryShow', () => {
  test('error-like empty object falls back to raw JSON', () => {
    const described = describeRegistryShow({});
    expect(described.rows).toEqual([]);
    expect(described.packages).toEqual([]);
    expect(described.raw).toBe('{}');
  });

  test('scalar fields become rows, packages with `versions` become a packages table', () => {
    const result = {
      schema_version: 1,
      name: 'lab',
      capabilities: { search: false },
      packages: [{ name: 'acme-core', versions: ['1.0.0', '1.1.0'] }],
    };
    const described = describeRegistryShow(result);
    expect(described.rows).toEqual(
      expect.arrayContaining([
        ['schema_version', '1'],
        ['name', 'lab'],
      ]),
    );
    expect(described.raw).toBeUndefined();
    expect(described.packages).toEqual([{ name: 'acme-core', versions: ['1.0.0', '1.1.0'], description: undefined }]);
  });

  test('packages with `releases` (objects carrying `version`) instead of `versions`', () => {
    const result = {
      name: 'lab',
      packages: [
        {
          name: 'acme-core',
          releases: [{ version: '1.0.0' }, { version: '1.1.0' }],
          description: 'core package',
        },
      ],
    };
    const described = describeRegistryShow(result);
    expect(described.packages).toEqual([
      { name: 'acme-core', versions: ['1.0.0', '1.1.0'], description: 'core package' },
    ]);
  });

  test('an unrecognized shape with no scalar rows and no packages falls back to raw JSON', () => {
    const result = { nested: { a: 1, b: 2 } };
    const described = describeRegistryShow(result);
    expect(described.rows).toEqual([]);
    expect(described.packages).toEqual([]);
    expect(described.raw).toBe(JSON.stringify(result, null, 2));
  });
});

describe('externalSourcePath', () => {
  test('encodes the repo and joins the in-package path', () => {
    expect(externalSourcePath('/home/dev/.vaire/store/acme-security/1.2.0', 'standards/coding-style.md')).toBe(
      '__vaire_external__/' + encodeURIComponent('/home/dev/.vaire/store/acme-security/1.2.0') + '/standards/coding-style.md',
    );
  });
});

describe('shortPath', () => {
  test('returns the path unchanged when it already fits', () => {
    expect(shortPath('/short/path', 40)).toBe('/short/path');
  });

  test('truncates a long path, keeping the start and end', () => {
    const long = '/home/dev/Projects/vaire-all/packages/acme-platform/current/clusters/ot-k8s.md';
    const short = shortPath(long, 30);
    expect(short.length).toBeLessThanOrEqual(30);
    expect(short).toContain('…');
    expect(short.startsWith('/home/dev')).toBe(true);
    expect(short.endsWith('ot-k8s.md')).toBe(true);
  });
});

describe('readManifest', () => {
  test.skipIf(!VAIRE_TEST_REPO)('reads name/version/description from a real knowledge.toml (VAIRE_TEST_REPO)', () => {
    const manifest = readManifest(VAIRE_TEST_REPO!);
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('vaire');
    expect(typeof manifest?.version).toBe('string');
    expect(typeof manifest?.description).toBe('string');
  });

  test('null for a non-existent directory', () => {
    expect(readManifest('/home/dev/Projects/vaire-all/packages/__does-not-exist__')).toBeNull();
  });
});

// feat/ext-render-mode: `vaire render -o json` sample fragments (shaped after real v0.3.2 output
// — see DESIGN.md "CLI contract nuances") drive these fixtures, so the path arithmetic matches
// what the CLI actually emits, not an assumption of it. `rewriteRenderedLinks` is pure path
// arithmetic (no filesystem access), so these run unconditionally against made-up paths.
describe('rewriteRenderedLinks', () => {
  const repo = '/home/dev/Projects/vaire-all/packages/vaire';
  const filePath = 'concepts/loose-end.md';

  test('same-package .md link -> vaire:// with the absolute path resolved against the file’s own directory', () => {
    const markdown = 'A loose end is an unresolved [Reference](./reference.md): the author knew.';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    const absPath = '/home/dev/Projects/vaire-all/packages/vaire/concepts/reference.md';
    expect(rewritten).toBe(`A loose end is an unresolved [Reference](vaire://${encodeURIComponent(absPath)}): the author knew.`);
    expect(map.get('./reference.md')).toBe(absPath);
  });

  test('same-package .md link one directory up', () => {
    const markdown = 'see [Unresolved references carry descriptors, never proposed IDs](../decisions/descriptors-never-slugs.md) for more.';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    const absPath = '/home/dev/Projects/vaire-all/packages/vaire/decisions/descriptors-never-slugs.md';
    expect(rewritten).toContain(`vaire://${encodeURIComponent(absPath)}`);
    expect(map.get('../decisions/descriptors-never-slugs.md')).toBe(absPath);
  });

  test('cross-package .md link through a dependency store root -> the real absolute filesystem path', () => {
    // Sample shape: rendering cluster:ot-k8s (acme-platform/current/clusters/ot-k8s.md)
    // links to @acme-security/standard:coding-style via a filesystem-relative path through the
    // resolved `.vaire/store` symlink target.
    const clusterRepo = '/home/dev/Projects/vaire-all/packages/acme-platform';
    const clusterFilePath = 'current/clusters/ot-k8s.md';
    const href = '../../../../../../.vaire/store/acme-security/1.2.0/standards/coding-style.md';
    const markdown = `Bound by [Coding Style — Acme Platform Coding Style Standard](${href}).`;
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo: clusterRepo, filePath: clusterFilePath });
    const absPath = '/home/dev/.vaire/store/acme-security/1.2.0/standards/coding-style.md';
    expect(rewritten).toBe(`Bound by [Coding Style — Acme Platform Coding Style Standard](vaire://${encodeURIComponent(absPath)}).`);
    expect(map.get(href)).toBe(absPath);
    expect(map.size).toBe(1);
  });

  test('an image link (non-.md) is left untouched', () => {
    const markdown = 'See the diagram: ![Topology](../assets/topology.png) for the layout.';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    expect(rewritten).toBe(markdown);
    expect(map.size).toBe(0);
  });

  test('an external https:// link is left untouched, even one ending in .md', () => {
    const markdown = 'External spec: [Design spec](https://example.com/design-spec.md).';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    expect(rewritten).toBe(markdown);
    expect(map.size).toBe(0);
  });

  test('a leftover unresolved [[...]] wikilink (render only rewrites resolvable links) is left untouched', () => {
    // Sample shape: rendering @acme-security/standard:coding-style leaves an unlinked-dependency
    // reference as a bare wikilink, not a Markdown link — this never matches the link regex.
    const markdown = 'issued by [[@acme-org/person:jane-doe]] (PLAT)';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    expect(rewritten).toBe(markdown);
    expect(map.size).toBe(0);
  });

  test('links inside a fenced code block are left untouched', () => {
    const markdown = ['See below:', '```text', '[Reference](./reference.md)', '```', 'done.'].join('\n');
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    expect(rewritten).toBe(markdown);
    expect(map.size).toBe(0);
  });

  test('several links on one line all get rewritten', () => {
    const markdown = 'See [Reference](./reference.md) and [Record](./record.md).';
    const { markdown: rewritten, map } = rewriteRenderedLinks(markdown, { repo, filePath });
    expect(map.size).toBe(2);
    expect(rewritten).toContain(
      `vaire://${encodeURIComponent('/home/dev/Projects/vaire-all/packages/vaire/concepts/reference.md')}`,
    );
    expect(rewritten).toContain(
      `vaire://${encodeURIComponent('/home/dev/Projects/vaire-all/packages/vaire/concepts/record.md')}`,
    );
  });
});

describe('frontmatterScalars', () => {
  test('parses plain and quoted scalars', () => {
    const fm = frontmatterScalars('id: loose-end\ntype: concept\nname: "Loose end"\n');
    expect(fm.id).toBe('loose-end');
    expect(fm.type).toBe('concept');
    expect(fm.name).toBe('Loose end');
  });

  test('parses a flat [a, b] list, unquoting each item', () => {
    const fm = frontmatterScalars('aliases: [unresolved reference, descriptor, "quoted item"]');
    expect(fm.aliases).toEqual(['unresolved reference', 'descriptor', 'quoted item']);
  });

  test('an empty list is []', () => {
    expect(frontmatterScalars('aliases: []').aliases).toEqual([]);
  });

  test('single-quoted scalars are unquoted too', () => {
    expect(frontmatterScalars("status: 'active'").status).toBe('active');
  });

  test('a value that is itself a Vairë ref stays a plain (unquoted) string', () => {
    const fm = frontmatterScalars('owner: "@acme-org/org:acme"');
    expect(fm.owner).toBe('@acme-org/org:acme');
  });

  test('lines with no scalar value (nested blocks) are skipped, not thrown on', () => {
    const fm = frontmatterScalars('id: x\nnested:\n  a: 1\ntype: concept\n');
    expect(fm.id).toBe('x');
    expect(fm.type).toBe('concept');
    expect(fm.nested).toBeUndefined();
  });

  test('blank lines and comments are ignored', () => {
    const fm = frontmatterScalars('# a comment\n\nid: x\n');
    expect(fm.id).toBe('x');
    expect(Object.keys(fm)).toEqual(['id']);
  });

  test('empty input -> empty object', () => {
    expect(frontmatterScalars('')).toEqual({});
  });
});

describe('findPackageRoot', () => {
  test.skipIf(!VAIRE_TEST_REPO)('finds the real package root from a node file several directories down (VAIRE_TEST_REPO)', () => {
    expect(findPackageRoot(path.join(VAIRE_TEST_REPO!, 'concepts/loose-end.md'))).toBe(VAIRE_TEST_REPO!);
  });

  test.skipIf(!VAIRE_TEST_REPO)('finds the package root when the file is directly inside it (VAIRE_TEST_REPO)', () => {
    expect(findPackageRoot(path.join(VAIRE_TEST_REPO!, 'README.md'))).toBe(VAIRE_TEST_REPO!);
  });

  test('null when no ancestor has a knowledge.toml', () => {
    expect(findPackageRoot('/home/dev/Projects/vaire-all/nonexistent-tree/deep/file.md')).toBeNull();
  });
});
