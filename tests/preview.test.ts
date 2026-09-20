import { describe, expect, test } from 'bun:test';
import { aliasesFrom, createTtlCache, firstParagraph, scalarField } from '../src/render/preview-pure';

describe('firstParagraph', () => {
  test('skips a single leading H1 and returns the paragraph after it', () => {
    const body = '# Title\n\nThis is the first paragraph. It has some text.\n\nSecond paragraph, not included.';
    expect(firstParagraph(body)).toBe('This is the first paragraph. It has some text.');
  });

  test('no leading heading at all — starts right at the paragraph', () => {
    const body = 'Just a paragraph with no heading at all, plain and simple.';
    expect(firstParagraph(body)).toBe('Just a paragraph with no heading at all, plain and simple.');
  });

  test('skips fenced code blocks (``` and ~~~) before the paragraph', () => {
    const body = '# Title\n\n```js\nconst x = 1;\nfunction f() {}\n```\n\nAfter the fence, this is the real paragraph.';
    expect(firstParagraph(body)).toBe('After the fence, this is the real paragraph.');

    const tilde = '~~~\nraw block\n~~~\n\nParagraph after a tilde fence.';
    expect(firstParagraph(tilde)).toBe('Paragraph after a tilde fence.');
  });

  test('skips intermediate headings of any level before the paragraph', () => {
    const body = '# Title\n\n## Overview\n\nThe actual paragraph text lives here.';
    expect(firstParagraph(body)).toBe('The actual paragraph text lives here.');
  });

  test('a leading bullet list is folded into the first paragraph, markers stripped', () => {
    const body = '# Title\n\n- First item\n- Second item\n\nAfter list paragraph, not included.';
    expect(firstParagraph(body)).toBe('First item Second item');
  });

  test('a leading numbered list is folded the same way', () => {
    const body = '1. One\n2. Two\n3. Three\n\nAfter.';
    expect(firstParagraph(body)).toBe('One Two Three');
  });

  test('wikilinks with a display alias collapse to the display text', () => {
    const body = '# Title\n\nSee [[concept:reference|Reference]] for context.';
    expect(firstParagraph(body)).toBe('See Reference for context.');
  });

  test('wikilinks without a display alias collapse to the bare target text', () => {
    const body = '# Title\n\nSee [[concept:reference]] for context.';
    expect(firstParagraph(body)).toBe('See concept:reference for context.');
  });

  test('a mix of aliased and bare wikilinks in the same paragraph', () => {
    const body = 'Related to [[concept:reference]] and [[concept:other|Other Thing]] both.';
    expect(firstParagraph(body)).toBe('Related to concept:reference and Other Thing both.');
  });

  test('bold and italic markers are stripped', () => {
    const body = '# Title\n\nThis is **bold**, *italic*, __also bold__, _also italic_ and `inline code`.';
    expect(firstParagraph(body)).toBe('This is bold, italic, also bold, also italic and inline code.');
  });

  test('collapses internal whitespace runs to single spaces', () => {
    const body = 'Line one with   extra space\nLine two continues the same paragraph.';
    expect(firstParagraph(body)).toBe('Line one with extra space Line two continues the same paragraph.');
  });

  test('truncates to ~400 characters with a trailing ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const result = firstParagraph(long);
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result.endsWith('…')).toBe(true);
    expect(long.startsWith(result.slice(0, -1))).toBe(true);
  });

  test('does not truncate text at or under the limit', () => {
    const body = 'short paragraph';
    expect(firstParagraph(body)).toBe('short paragraph');
    expect(firstParagraph(body).endsWith('…')).toBe(false);
  });

  test('a custom maxLen is respected', () => {
    const body = 'one two three four five';
    expect(firstParagraph(body, 8)).toBe('one two…');
  });

  test('no paragraph text at all (only headings) -> empty string', () => {
    const body = '# Title\n\n## Just headings\n### more headings\n';
    expect(firstParagraph(body)).toBe('');
  });

  test('CRLF line endings are tolerated', () => {
    const body = '# Title\r\n\r\nA paragraph with CRLF endings.\r\n\r\nSecond paragraph.';
    expect(firstParagraph(body)).toBe('A paragraph with CRLF endings.');
  });
});

describe('aliasesFrom', () => {
  test('array of strings', () => {
    expect(aliasesFrom({ aliases: ['A', 'B'] })).toEqual(['A', 'B']);
  });

  test('a single string alias', () => {
    expect(aliasesFrom({ aliases: 'Solo' })).toEqual(['Solo']);
  });

  test('non-string items in the array are dropped', () => {
    expect(aliasesFrom({ aliases: ['A', 42, null] as unknown[] })).toEqual(['A']);
  });

  test('missing/undefined frontmatter -> empty array', () => {
    expect(aliasesFrom(undefined)).toEqual([]);
    expect(aliasesFrom({})).toEqual([]);
  });
});

describe('scalarField', () => {
  test('a non-empty string field, trimmed', () => {
    expect(scalarField({ status: '  active  ' }, 'status')).toBe('active');
  });

  test('missing field -> undefined', () => {
    expect(scalarField({}, 'status')).toBeUndefined();
    expect(scalarField(undefined, 'status')).toBeUndefined();
  });

  test('a blank or non-string field -> undefined', () => {
    expect(scalarField({ status: '   ' }, 'status')).toBeUndefined();
    expect(scalarField({ status: 42 }, 'status')).toBeUndefined();
  });
});

describe('createTtlCache', () => {
  test('returns the cached value on repeated get() within the TTL, computing only once', async () => {
    let now = 1_000;
    const cache = createTtlCache<number>(1_000, () => now);
    let calls = 0;
    const compute = () => {
      calls++;
      return Promise.resolve(42);
    };

    expect(await cache.get('k', compute)).toBe(42);
    now += 500;
    expect(await cache.get('k', compute)).toBe(42);
    expect(calls).toBe(1);
  });

  test('recomputes once the TTL has elapsed', async () => {
    let now = 1_000;
    const cache = createTtlCache<number>(1_000, () => now);
    let calls = 0;
    const compute = () => Promise.resolve(++calls);

    expect(await cache.get('k', compute)).toBe(1);
    now += 1_001;
    expect(await cache.get('k', compute)).toBe(2);
    expect(calls).toBe(2);
  });

  test('an in-flight (not yet expired) entry is reused even before it resolves', async () => {
    const cache = createTtlCache<number>(1_000);
    let calls = 0;
    let resolveFirst: (v: number) => void = () => {};
    const first = new Promise<number>((res) => {
      resolveFirst = res;
    });
    const compute = () => {
      calls++;
      return calls === 1 ? first : Promise.resolve(-1);
    };

    const p1 = cache.get('k', compute);
    const p2 = cache.get('k', compute);
    resolveFirst(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(calls).toBe(1);
  });

  test('different keys are cached independently', async () => {
    const cache = createTtlCache<string>(1_000);
    let calls = 0;
    const a = await cache.get('a', () => {
      calls++;
      return Promise.resolve('A');
    });
    const b = await cache.get('b', () => {
      calls++;
      return Promise.resolve('B');
    });
    expect(a).toBe('A');
    expect(b).toBe('B');
    expect(calls).toBe(2);
  });

  test('clear() drops every entry so the next get() recomputes', async () => {
    const cache = createTtlCache<number>(60_000);
    let calls = 0;
    const compute = () => Promise.resolve(++calls);

    expect(await cache.get('k', compute)).toBe(1);
    cache.clear();
    expect(await cache.get('k', compute)).toBe(2);
    expect(calls).toBe(2);
  });

  test('a rejected compute() is evicted immediately, so the next get() retries rather than replaying the failure', async () => {
    const cache = createTtlCache<number>(60_000);
    let calls = 0;
    const compute = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(99);
    };

    let firstErrored = false;
    try {
      await cache.get('k', compute);
    } catch {
      firstErrored = true;
    }
    expect(firstErrored).toBe(true);

    expect(await cache.get('k', compute)).toBe(99);
    expect(calls).toBe(2);
  });
});
