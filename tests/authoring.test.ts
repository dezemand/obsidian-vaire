import { describe, expect, test } from 'bun:test';
import { buildNodeFile, folderFromPattern, inferFolder, slugify, validateSlug } from '../src/authoring/pure';

describe('slugify', () => {
  test('lowercases and dashes spaces', () => {
    expect(slugify('Ingest API')).toBe('ingest-api');
  });

  test('ASCII-folds diacritics', () => {
    expect(slugify('Café Müller')).toBe('cafe-muller');
  });

  test('strips punctuation, collapsing runs into a single dash', () => {
    expect(slugify("O'Brien & Sons, Inc.")).toBe('o-brien-sons-inc');
  });

  test('trims leading/trailing dashes produced by leading/trailing punctuation', () => {
    expect(slugify('  --Hello World!--  ')).toBe('hello-world');
  });

  test('leading digits are preserved (digits are valid slug leaders)', () => {
    expect(slugify('2026 Report')).toBe('2026-report');
    expect(validateSlug(slugify('2026 Report'))).toBe(true);
  });

  test('a name that is entirely punctuation slugifies to the empty string', () => {
    expect(slugify('!!!')).toBe('');
  });

  test('multiple internal spaces/punctuation collapse to one dash', () => {
    expect(slugify('a   b---c')).toBe('a-b-c');
  });
});

describe('validateSlug', () => {
  test('accepts lowercase alphanumeric-and-dash slugs', () => {
    expect(validateSlug('ingest-api')).toBe(true);
    expect(validateSlug('2026-report')).toBe(true);
    expect(validateSlug('a')).toBe(true);
    expect(validateSlug('a1')).toBe(true);
  });

  test('rejects the empty string', () => {
    expect(validateSlug('')).toBe(false);
  });

  test('rejects uppercase, spaces, and other punctuation', () => {
    expect(validateSlug('Ingest-Api')).toBe(false);
    expect(validateSlug('ingest api')).toBe(false);
    expect(validateSlug('ingest_api')).toBe(false);
    expect(validateSlug('ingest:api')).toBe(false);
    expect(validateSlug('ingest/api')).toBe(false);
  });

  test('rejects a leading dash', () => {
    expect(validateSlug('-ingest')).toBe(false);
  });
});

describe('inferFolder', () => {
  test('returns the majority folder', () => {
    const nodes = [{ folder: 'concepts' }, { folder: 'concepts' }, { folder: 'notes' }];
    expect(inferFolder(nodes)).toBe('concepts');
  });

  test('ties break alphabetically (first folder name wins)', () => {
    const nodes = [{ folder: 'zeta' }, { folder: 'alpha' }];
    expect(inferFolder(nodes)).toBe('alpha');
  });

  test('a three-way tie also breaks alphabetically', () => {
    const nodes = [{ folder: 'notes' }, { folder: 'concepts' }, { folder: 'archive' }];
    expect(inferFolder(nodes)).toBe('archive');
  });

  test('empty input returns null', () => {
    expect(inferFolder([])).toBeNull();
  });

  test('a single node of the type is its own folder', () => {
    expect(inferFolder([{ folder: 'concepts' }])).toBe('concepts');
  });

  test('the vault-root folder ("") counts like any other folder', () => {
    const nodes = [{ folder: '' }, { folder: '' }, { folder: 'concepts' }];
    expect(inferFolder(nodes)).toBe('');
  });
});

describe('folderFromPattern', () => {
  test('substitutes {type}', () => {
    expect(folderFromPattern('{type}s', 'concept')).toBe('concepts');
  });

  test('a pattern with no {type} placeholder is returned unchanged', () => {
    expect(folderFromPattern('nodes', 'concept')).toBe('nodes');
  });

  test('multiple {type} placeholders all get substituted', () => {
    expect(folderFromPattern('{type}/{type}s', 'concept')).toBe('concept/concepts');
  });

  test('a nested pattern', () => {
    expect(folderFromPattern('knowledge/{type}', 'decision')).toBe('knowledge/decision');
  });
});

describe('buildNodeFile', () => {
  test('unscoped node — exact output', () => {
    const content = buildNodeFile({ id: 'ingest-api', type: 'system', name: 'Ingest API', today: '2026-09-15' });
    expect(content).toBe(
      '---\n' +
        'id: ingest-api\n' +
        'type: system\n' +
        'name: Ingest API\n' +
        'updated: 2026-09-15\n' +
        '---\n' +
        '# Ingest API\n' +
        '\n',
    );
  });

  test('scoped node — scope line appears between name and updated', () => {
    const content = buildNodeFile({
      id: 'add',
      type: 'command',
      name: 'add',
      scope: 'cli:vaire',
      today: '2026-09-15',
    });
    expect(content).toBe(
      '---\n' +
        'id: add\n' +
        'type: command\n' +
        'name: add\n' +
        'scope: cli:vaire\n' +
        'updated: 2026-09-15\n' +
        '---\n' +
        '# add\n' +
        '\n',
    );
  });

  test('a name needing YAML quoting (contains ": ") is double-quoted', () => {
    const content = buildNodeFile({ id: 'x', type: 'concept', name: 'Node: Special', today: '2026-09-15' });
    expect(content).toContain('name: "Node: Special"\n');
    // The body H1 keeps the raw (unquoted) name.
    expect(content).toContain('# Node: Special\n');
  });

  test('body is exactly "# <name>\\n\\n" at the end of the file', () => {
    const content = buildNodeFile({ id: 'x', type: 'concept', name: 'X', today: '2026-09-15' });
    expect(content.endsWith('# X\n\n')).toBe(true);
    expect(content.split('---\n')[2]).toBe('# X\n\n');
  });
});
