import { describe, expect, test } from 'bun:test';
import { parseEmbedSrc, sectionUnderHeading } from '../src/render/pure';

describe('sectionUnderHeading', () => {
  const body = [
    '# Title',
    '',
    'Intro paragraph.',
    '',
    '## Section A',
    '',
    'Content A line 1.',
    '',
    '### Sub A1',
    '',
    'Nested content.',
    '',
    '## Section B',
    '',
    'Content B.',
    '',
  ].join('\n');

  test('returns the exact heading and everything up to the next same-level heading', () => {
    expect(sectionUnderHeading(body, 'Section A')).toBe(
      ['## Section A', '', 'Content A line 1.', '', '### Sub A1', '', 'Nested content.'].join('\n'),
    );
  });

  test('includes nested (deeper-level) subheadings in the section', () => {
    const section = sectionUnderHeading(body, 'Section A')!;
    expect(section).toContain('### Sub A1');
    expect(section).toContain('Nested content.');
  });

  test('stops at the next heading of the same level', () => {
    const section = sectionUnderHeading(body, 'Section A')!;
    expect(section).not.toContain('Section B');
    expect(section).not.toContain('Content B.');
  });

  test('a section with no following heading runs to the end of the document', () => {
    expect(sectionUnderHeading(body, 'Section B')).toBe(['## Section B', '', 'Content B.'].join('\n'));
  });

  test('stops at a shallower (higher-level) heading too, not just an equal one', () => {
    const doc = ['## Section A', '', 'content', '', '# Title Two', '', 'more'].join('\n');
    expect(sectionUnderHeading(doc, 'Section A')).toBe(['## Section A', '', 'content'].join('\n'));
  });

  test('missing heading returns null', () => {
    expect(sectionUnderHeading(body, 'Does Not Exist')).toBeNull();
  });

  test('matches heading text exactly, not as a substring', () => {
    const doc = ['## Section', '', 'first', '', '## Section Two', '', 'second'].join('\n');
    expect(sectionUnderHeading(doc, 'Section')).toBe(['## Section', '', 'first'].join('\n'));
    expect(sectionUnderHeading(doc, 'Section Two')).toBe(['## Section Two', '', 'second'].join('\n'));
  });

  test('duplicate heading text matches the first occurrence', () => {
    const doc = ['## Notes', '', 'first notes', '', '## Notes', '', 'second notes'].join('\n');
    expect(sectionUnderHeading(doc, 'Notes')).toBe(['## Notes', '', 'first notes'].join('\n'));
  });

  test('ignores heading-looking lines inside fenced code blocks', () => {
    const doc = ['## Real Heading', '', '```', '# not a heading', '```', '', 'content'].join('\n');
    const section = sectionUnderHeading(doc, 'Real Heading')!;
    expect(section).toContain('# not a heading');
    expect(section).toContain('content');
  });

  test('empty heading returns null', () => {
    expect(sectionUnderHeading(body, '')).toBeNull();
    expect(sectionUnderHeading(body, '   ')).toBeNull();
  });
});

describe('parseEmbedSrc', () => {
  test('a plain id ref with no heading', () => {
    const parsed = parseEmbedSrc('concept:reference');
    expect(parsed).not.toBeNull();
    expect(parsed?.heading).toBeUndefined();
    expect(parsed?.ref).toMatchObject({ kind: 'id', type: 'concept', id: 'reference', full: 'concept:reference' });
  });

  test('splits off a #Heading fragment', () => {
    const parsed = parseEmbedSrc('concept:reference#Some Heading');
    expect(parsed?.ref).toMatchObject({ full: 'concept:reference' });
    expect(parsed?.heading).toBe('Some Heading');
  });

  test('an @pkg ref with a heading', () => {
    const parsed = parseEmbedSrc('@acme-security/standard:coding-style#Usage');
    expect(parsed?.ref).toMatchObject({ kind: 'id', pkg: 'acme-security', full: '@acme-security/standard:coding-style' });
    expect(parsed?.heading).toBe('Usage');
  });

  test('a scoped (container) ref with a heading', () => {
    const parsed = parseEmbedSrc('cli:vaire/standard:coding-style#Usage notes');
    expect(parsed?.ref).toMatchObject({ kind: 'id', scope: 'cli:vaire', full: 'cli:vaire/standard:coding-style' });
    expect(parsed?.heading).toBe('Usage notes');
  });

  test('trims surrounding whitespace around both the ref and the heading', () => {
    const parsed = parseEmbedSrc('  concept:reference  #  Some Heading  ');
    expect(parsed?.ref).toMatchObject({ full: 'concept:reference' });
    expect(parsed?.heading).toBe('Some Heading');
  });

  test('a loose end is still recognized (no heading makes sense for it, but parsing is separate from embedding)', () => {
    const parsed = parseEmbedSrc('?person: someone from logistics');
    expect(parsed?.ref).toMatchObject({ kind: 'loose', descriptor: 'someone from logistics' });
    expect(parsed?.heading).toBeUndefined();
  });

  test('null for an ordinary (non-Vairë) note embed target', () => {
    expect(parseEmbedSrc('Some Note')).toBeNull();
    expect(parseEmbedSrc('folder/Some Note')).toBeNull();
  });

  test('null for an empty or whitespace-only src', () => {
    expect(parseEmbedSrc('')).toBeNull();
    expect(parseEmbedSrc('   ')).toBeNull();
  });

  test('null when the src is only a #heading with nothing before it', () => {
    expect(parseEmbedSrc('#Heading')).toBeNull();
  });
});
