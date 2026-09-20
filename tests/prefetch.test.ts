import { describe, expect, test } from 'bun:test';
import { extractRenderedLinks, hrefMatchesPath } from '../src/render/prefetch-pure';
import { resolveMemoKey } from '../src/cli';

// A trimmed real `render` sample (from `vaire render record:2026-07-14-coding-style-4-4-intake` in
// packages/acme-platform) plus a few synthetic additions covering the edge cases this
// module must get right: a display with parentheses/spaces, an image link (ignored), and a
// link-shaped snippet inside a code span/fence (ignored).
const RENDER_SAMPLE = `---
id: 2026-07-14-coding-style-4-4-intake
type: record
references: ["@acme-security/standard:coding-style"]
---
# Record: Coding Style v4.4 intake

The [Coding Style — Acme Global Industrial Network Standard](../../../../../../.vaire/store/acme-security/1.2.0/standards/coding-style.md) node — previously describing only the v3.1 three-layer fragment from
the INFA deck — was rewritten against the full v4.4 text.

Supersedes the v3.1 description sourced in
[Record: policy-deck rendering & extraction (INFA + industrial networking)](./2026-07-14-policy-deck-extraction.md) (that record remains accurate about the
deck's content).

See the ![architecture diagram](./diagrams/purdue.png) for the zone layout.

Inline code mentioning a fake link: \`[not a link](./nope.md)\` should be ignored.

\`\`\`
[also not a link](./nope-either.md)
\`\`\`
`;

describe('extractRenderedLinks', () => {
  const links = extractRenderedLinks(RENDER_SAMPLE);

  test('extracts a same-package link', () => {
    const hit = links.find((l) => l.href === './2026-07-14-policy-deck-extraction.md');
    expect(hit).toBeDefined();
  });

  test('extracts a dependency link into .vaire/store', () => {
    const hit = links.find((l) => l.href === '../../../../../../.vaire/store/acme-security/1.2.0/standards/coding-style.md');
    expect(hit).toBeDefined();
    expect(hit?.display).toBe('Coding Style — Acme Global Industrial Network Standard');
  });

  test('keeps a display containing parentheses and spaces intact', () => {
    const hit = links.find((l) => l.href === './2026-07-14-policy-deck-extraction.md');
    expect(hit?.display).toBe('Record: policy-deck rendering & extraction (INFA + industrial networking)');
  });

  test('ignores image links', () => {
    expect(links.some((l) => l.href.includes('purdue.png'))).toBe(false);
  });

  test('ignores a link-shaped snippet inside an inline code span', () => {
    expect(links.some((l) => l.href === './nope.md')).toBe(false);
  });

  test('ignores a link-shaped snippet inside a fenced code block', () => {
    expect(links.some((l) => l.href === './nope-either.md')).toBe(false);
  });

  test('only real links are returned (nothing extra)', () => {
    expect(links).toHaveLength(2);
  });
});

describe('extractRenderedLinks — additional shapes', () => {
  test('a link on its own line with no surrounding prose', () => {
    const links = extractRenderedLinks('[Reference](./concepts/reference.md)');
    expect(links).toEqual([{ display: 'Reference', href: './concepts/reference.md' }]);
  });

  test('multiple links on one line', () => {
    const links = extractRenderedLinks('See [A](./a.md) and [B](./b.md).');
    expect(links).toEqual([
      { display: 'A', href: './a.md' },
      { display: 'B', href: './b.md' },
    ]);
  });

  test('an inline code span between two real links does not swallow them', () => {
    const links = extractRenderedLinks('[A](./a.md) then `[x](./x.md)` then [B](./b.md)');
    expect(links.map((l) => l.href)).toEqual(['./a.md', './b.md']);
  });

  test('empty markdown yields no links', () => {
    expect(extractRenderedLinks('')).toEqual([]);
  });
});

describe('hrefMatchesPath', () => {
  test('same-package relative href matches a bare relative path', () => {
    expect(hrefMatchesPath('./concepts/x.md', 'concepts/x.md')).toBe(true);
  });

  test('a dependency href into .vaire/store matches the dependency-relative path', () => {
    expect(
      hrefMatchesPath('../../.vaire/store/acme-security/1.2.0/standards/coding-style.md', 'standards/coding-style.md'),
    ).toBe(true);
  });

  test('the deep six-level-up dependency href from the render sample', () => {
    expect(
      hrefMatchesPath(
        '../../../../../../.vaire/store/acme-security/1.2.0/standards/coding-style.md',
        'standards/coding-style.md',
      ),
    ).toBe(true);
  });

  test('mismatched trailing segments do not match', () => {
    expect(hrefMatchesPath('./concepts/x.md', 'concepts/y.md')).toBe(false);
  });

  test('a shorter href than the path never matches', () => {
    expect(hrefMatchesPath('./x.md', 'concepts/x.md')).toBe(false);
  });

  test('an unrelated path with the same basename in a different directory does not match', () => {
    expect(hrefMatchesPath('./other/x.md', 'concepts/x.md')).toBe(false);
  });
});

describe('resolveMemoKey', () => {
  test('joins absRoot and id with a NUL separator, matching resolveViaCli', () => {
    expect(resolveMemoKey('/home/dev/Projects/vaire-all/packages/acme-platform', '@acme-security/standard:coding-style')).toBe(
      '/home/dev/Projects/vaire-all/packages/acme-platform\u0000@acme-security/standard:coding-style',
    );
  });

  test('distinct absRoots never collide for the same id', () => {
    const a = resolveMemoKey('/repo/a', 'concept:x');
    const b = resolveMemoKey('/repo/b', 'concept:x');
    expect(a).not.toBe(b);
  });
});
