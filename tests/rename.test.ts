import { describe, expect, test } from 'bun:test';
import {
  joinFrontmatter,
  planRename,
  siblingPath,
  splitBacklinks,
  splitFrontmatter,
  summarizeRename,
  tombstoneBody,
  tombstoneFrontmatterText,
  withChangedIdentity,
  type PlanRenameInput,
  type RenameBacklinkRow,
  type RenameNodeInput,
} from '../src/authoring/rename-pure';
import { rewriteReference } from '../src/authoring/supersede-pure';

// ---- fixtures --------------------------------------------------------------------------------

const baseNode: RenameNodeInput = {
  path: 'concepts/reference.md',
  id: 'reference',
  type: 'concept',
  full: 'concept:reference',
  name: 'The Reference Model',
  frontmatterText: [
    'id: reference',
    'type: concept',
    'name: The Reference Model',
    '# ownership note — do not drop this comment',
    'owner: person:jane',
    'aliases:',
    '  - Ref Model',
    'updated: 2026-01-01',
  ].join('\n'),
  body: '# The Reference Model\n\nSome body text.\n',
};

const scopedNode: RenameNodeInput = {
  path: 'cli/vaire/flags/verbose.md',
  id: 'verbose',
  type: 'flag',
  scope: 'cli:vaire',
  full: 'cli:vaire/flag:verbose',
  name: 'Verbose flag',
  frontmatterText: ['id: verbose', 'type: flag', 'name: Verbose flag', 'scope: cli:vaire'].join('\n'),
  body: '# Verbose flag\n',
};

const backlinks: RenameBacklinkRow[] = [
  { id: 'concept:other', type: 'concept', path: 'concepts/other.md', ref_type: 'inline', line: 5 },
  { id: 'concept:third', type: 'concept', path: 'concepts/third.md', ref_type: 'owner', line: 2 },
  {
    id: '@dep-pkg/concept:external',
    type: 'concept',
    path: 'concepts/external.md',
    package: 'dep-pkg',
    ref_type: 'inline',
    line: 9,
  },
];

function baseInput(overrides: Partial<PlanRenameInput> = {}): PlanRenameInput {
  return {
    node: baseNode,
    newId: 'reference-model',
    newType: 'concept',
    strategy: 'tombstone',
    backlinks,
    rewriteRefs: true,
    today: '2026-09-16',
    existingFullIds: ['concept:reference', 'concept:other', 'concept:third'],
    ...overrides,
  };
}

// ---- splitFrontmatter / joinFrontmatter -------------------------------------------------------

describe('splitFrontmatter / joinFrontmatter', () => {
  test('splits a well-formed node file into frontmatter text and body', () => {
    const content = '---\nid: x\ntype: concept\n---\n# X\n\nbody\n';
    const split = splitFrontmatter(content);
    expect(split).toEqual({ frontmatterText: 'id: x\ntype: concept', body: '# X\n\nbody\n' });
  });

  test('round-trips through joinFrontmatter', () => {
    const content = '---\nid: x\ntype: concept\n---\n# X\n\nbody\n';
    const split = splitFrontmatter(content)!;
    expect(joinFrontmatter(split.frontmatterText, split.body)).toBe(content);
  });

  test('returns null for content with no frontmatter block', () => {
    expect(splitFrontmatter('# Just a heading\n\nNo frontmatter here.\n')).toBeNull();
  });

  test('non-greedy: matches the first closing fence, not a later one', () => {
    const content = '---\nid: x\n---\nbody with\n---\na literal separator\n';
    const split = splitFrontmatter(content)!;
    expect(split.frontmatterText).toBe('id: x');
    expect(split.body).toBe('body with\n---\na literal separator\n');
  });
});

// ---- withChangedIdentity ------------------------------------------------------------------

describe('withChangedIdentity', () => {
  test('replaces id/type/updated in place, leaving every other line untouched', () => {
    const result = withChangedIdentity(baseNode.frontmatterText, 'reference-model', 'entity', '2026-09-16');
    expect(result.split('\n')).toEqual([
      'id: reference-model',
      'type: entity',
      'name: The Reference Model',
      '# ownership note — do not drop this comment',
      'owner: person:jane',
      'aliases:',
      '  - Ref Model',
      'updated: 2026-09-16',
    ]);
  });

  test('preserves key order — id/type/updated stay where they were, not moved to the top', () => {
    const text = 'name: Foo\nid: foo\ntype: concept\nupdated: 2020-01-01\nowner: person:x';
    const result = withChangedIdentity(text, 'bar', 'concept', '2026-09-16');
    expect(result.split('\n')).toEqual(['name: Foo', 'id: bar', 'type: concept', 'updated: 2026-09-16', 'owner: person:x']);
  });

  test('appends updated: when the frontmatter has none', () => {
    const text = 'id: foo\ntype: concept\nname: Foo';
    const result = withChangedIdentity(text, 'bar', 'concept', '2026-09-16');
    expect(result.split('\n')).toEqual(['id: bar', 'type: concept', 'name: Foo', 'updated: 2026-09-16']);
  });

  test('does not touch a list item that merely starts with "id:" or "type:" inside its text', () => {
    const text = 'id: foo\ntype: concept\nnotes:\n  - id: not a top-level key';
    const result = withChangedIdentity(text, 'bar', 'concept', '2026-09-16');
    // the indented list item is untouched; only the true top-level id:/type: lines change
    expect(result).toContain('  - id: not a top-level key');
    expect(result.split('\n')[0]).toBe('id: bar');
  });
});

// ---- tombstoneBody / tombstoneFrontmatterText -----------------------------------------------

describe('tombstoneBody', () => {
  test('exact redirect note', () => {
    expect(tombstoneBody('The Reference Model', 'concept:reference-model')).toBe(
      '# The Reference Model\n\nMoved to [[concept:reference-model]].\n',
    );
  });
});

describe('tombstoneFrontmatterText', () => {
  test('minimal frontmatter: id, type, name, superseded_by, updated — no scope when unscoped', () => {
    const text = tombstoneFrontmatterText({
      id: 'reference',
      type: 'concept',
      name: 'The Reference Model',
      supersededBy: 'concept:reference-model',
      updated: '2026-09-16',
    });
    expect(text.split('\n')).toEqual([
      'id: reference',
      'type: concept',
      'name: The Reference Model',
      'superseded_by: concept:reference-model',
      'updated: 2026-09-16',
    ]);
  });

  test('includes scope for a scoped node', () => {
    const text = tombstoneFrontmatterText({
      id: 'verbose',
      type: 'flag',
      name: 'Verbose flag',
      scope: 'cli:vaire',
      supersededBy: 'cli:vaire/flag:loud',
      updated: '2026-09-16',
    });
    expect(text.split('\n')).toEqual([
      'id: verbose',
      'type: flag',
      'name: Verbose flag',
      'scope: cli:vaire',
      'superseded_by: cli:vaire/flag:loud',
      'updated: 2026-09-16',
    ]);
  });

  test('quotes a name that needs it', () => {
    const text = tombstoneFrontmatterText({
      id: 'x',
      type: 'concept',
      name: '',
      supersededBy: 'concept:y',
      updated: '2026-09-16',
    });
    expect(text).toContain('name: ""');
  });
});

// ---- splitBacklinks ---------------------------------------------------------------------------

describe('splitBacklinks', () => {
  test('rows without a package are in-vault; rows with one are external', () => {
    const { inVault, external } = splitBacklinks(backlinks);
    expect(inVault.map((b) => b.id)).toEqual(['concept:other', 'concept:third']);
    expect(external.map((b) => b.id)).toEqual(['@dep-pkg/concept:external']);
  });

  test('empty input', () => {
    expect(splitBacklinks([])).toEqual({ inVault: [], external: [] });
  });
});

// ---- siblingPath --------------------------------------------------------------------------

describe('siblingPath', () => {
  test('keeps the same folder', () => {
    expect(siblingPath('concepts/reference.md', 'reference-model')).toBe('concepts/reference-model.md');
  });

  test('a root-level file stays at the root', () => {
    expect(siblingPath('reference.md', 'reference-model')).toBe('reference-model.md');
  });

  test('a nested folder is preserved in full', () => {
    expect(siblingPath('cli/vaire/flags/verbose.md', 'loud')).toBe('cli/vaire/flags/loud.md');
  });
});

// ---- planRename — tombstone strategy -----------------------------------------------------

describe('planRename — tombstone strategy', () => {
  test('writes the new file with the old frontmatter (id/type/updated changed) and the old body verbatim', () => {
    const plan = planRename(baseInput());
    expect(plan.strategy).toBe('tombstone');
    expect(plan.oldFull).toBe('concept:reference');
    expect(plan.newFull).toBe('concept:reference-model');
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].path).toBe('concepts/reference-model.md');
    expect(plan.writes[0].content).toBe(
      joinFrontmatter(withChangedIdentity(baseNode.frontmatterText, 'reference-model', 'concept', '2026-09-16'), baseNode.body),
    );
  });

  test('turns the old file into a minimal tombstone: id/type/name/scope kept, superseded_by + updated added', () => {
    const plan = planRename(baseInput());
    expect(plan.tombstone).toEqual({
      path: 'concepts/reference.md',
      keep: { id: 'reference', type: 'concept', name: 'The Reference Model', scope: undefined },
      supersededBy: 'concept:reference-model',
      updated: '2026-09-16',
      body: tombstoneBody('The Reference Model', 'concept:reference-model'),
    });
  });

  test('never renames the old file and never touches its frontmatter as raw text', () => {
    const plan = planRename(baseInput());
    expect(plan.renames).toEqual([]);
    expect(plan.frontmatterRewrites).toEqual([]);
  });

  test('rewriteRefs on (default): in-vault backlinks are rewritten, external ones are not touched', () => {
    const plan = planRename(baseInput({ rewriteRefs: true }));
    expect(plan.referenceRewrites).toEqual([
      { path: 'concepts/other.md', line: 5, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
      { path: 'concepts/third.md', line: 2, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
    ]);
  });

  test('rewriteRefs off: no reference rewrites at all, but backlinks are still split for display', () => {
    const plan = planRename(baseInput({ rewriteRefs: false }));
    expect(plan.referenceRewrites).toEqual([]);
    expect(plan.inVaultBacklinks).toHaveLength(2);
    expect(plan.externalBacklinks).toHaveLength(1);
  });

  test('external (dependency/other-package) backlinks are listed but never scheduled for rewriting', () => {
    const plan = planRename(baseInput({ rewriteRefs: true }));
    expect(plan.externalBacklinks).toEqual([backlinks[2]]);
    expect(plan.referenceRewrites.some((r) => r.path === 'concepts/external.md')).toBe(false);
  });

  test('a type change is reflected in the new full id and the new file content', () => {
    const plan = planRename(baseInput({ newId: 'reference', newType: 'entity' }));
    expect(plan.newFull).toBe('entity:reference');
    // same id, so the write path is unchanged; only the frontmatter's type line differs
    expect(plan.writes[0].path).toBe('concepts/reference.md');
    expect(plan.writes[0].content).toContain('type: entity');
  });

  test('a scoped node keeps its scope in the new full id, the new file path, and the tombstone', () => {
    const plan = planRename({
      node: scopedNode,
      newId: 'loud',
      newType: 'flag',
      strategy: 'tombstone',
      backlinks: [],
      rewriteRefs: true,
      today: '2026-09-16',
      existingFullIds: ['cli:vaire/flag:verbose'],
    });
    expect(plan.newFull).toBe('cli:vaire/flag:loud');
    expect(plan.writes[0].path).toBe('cli/vaire/flags/loud.md');
    expect(plan.tombstone?.keep.scope).toBe('cli:vaire');
    expect(plan.tombstone?.supersededBy).toBe('cli:vaire/flag:loud');
  });
});

// ---- planRename — rewrite-in-place strategy -----------------------------------------------

describe('planRename — rewrite-in-place strategy', () => {
  test('renames the file and rewrites its frontmatter text in place, no tombstone, no new file', () => {
    const plan = planRename(baseInput({ strategy: 'rewrite-in-place', rewriteRefs: false }));
    expect(plan.strategy).toBe('rewrite-in-place');
    expect(plan.writes).toEqual([]);
    expect(plan.tombstone).toBeNull();
    expect(plan.renames).toEqual([{ oldPath: 'concepts/reference.md', newPath: 'concepts/reference-model.md' }]);
    expect(plan.frontmatterRewrites).toEqual([
      {
        path: 'concepts/reference-model.md',
        frontmatterText: withChangedIdentity(baseNode.frontmatterText, 'reference-model', 'concept', '2026-09-16'),
      },
    ]);
  });

  test('always rewrites in-vault references, regardless of the rewriteRefs flag (no redirect to fall back on)', () => {
    const planFlagOff = planRename(baseInput({ strategy: 'rewrite-in-place', rewriteRefs: false }));
    const planFlagOn = planRename(baseInput({ strategy: 'rewrite-in-place', rewriteRefs: true }));
    expect(planFlagOff.referenceRewrites).toHaveLength(2);
    expect(planFlagOn.referenceRewrites).toEqual(planFlagOff.referenceRewrites);
  });

  test('external backlinks are surfaced as the dangling-after-rename list', () => {
    const plan = planRename(baseInput({ strategy: 'rewrite-in-place' }));
    expect(plan.externalBacklinks).toEqual([backlinks[2]]);
  });
});

// ---- planRename — validation ----------------------------------------------------------------

describe('planRename — validation', () => {
  test('rejects a new id that collides with an existing one in the package', () => {
    expect(() => planRename(baseInput({ existingFullIds: ['concept:reference', 'concept:reference-model'] }))).toThrow(
      /already exists/,
    );
  });

  test('rejects a no-op rename (same id and type)', () => {
    expect(() => planRename(baseInput({ newId: 'reference', newType: 'concept' }))).toThrow();
  });

  test('rejects an invalid new id', () => {
    expect(() => planRename(baseInput({ newId: 'Not A Slug' }))).toThrow(/id/i);
  });

  test('rejects an invalid new type', () => {
    expect(() => planRename(baseInput({ newType: 'Not A Slug' }))).toThrow(/type/i);
  });

  test('an empty new id is rejected', () => {
    expect(() => planRename(baseInput({ newId: '' }))).toThrow();
  });
});

// ---- planRename — self-referencing node (feat/rename-id self-reference bug) -----------------
//
// A node that links to itself in its own body (`[[concept:reference]]` inside
// concepts/reference.md's own body) appears as a backlink row whose `path` equals the node's
// own pre-rename path. By the time reference rewrites are applied, that content no longer
// lives at the old path: tombstone strategy has already moved it to the new file
// (`writes[0]`), and rewrite-in-place has already renamed the file there (`renames[0]`).
// `planRename` must route that row's rewrite at the post-rename path, or the self-reference is
// silently left pointing at the old id (see the applyReferenceRewrites "file not found, skip"
// fallback in rename-modal.ts).

const selfRefNode: RenameNodeInput = {
  path: 'concepts/reference.md',
  id: 'reference',
  type: 'concept',
  full: 'concept:reference',
  name: 'The Reference Model',
  frontmatterText: ['id: reference', 'type: concept', 'name: The Reference Model', 'updated: 2026-01-01'].join('\n'),
  body: '# The Reference Model\n\nSee also [[concept:reference]] for details.\n',
};

// Line 9 of the raw file (joinFrontmatter(frontmatterText, body)):
//   1 ---                                            6 ---
//   2 id: reference                                  7 # The Reference Model
//   3 type: concept                                  8 (blank)
//   4 name: The Reference Model                       9 See also [[concept:reference]] for details.
//   5 updated: 2026-01-01
const selfBacklinkRow: RenameBacklinkRow = {
  id: 'concept:reference',
  type: 'concept',
  path: selfRefNode.path,
  ref_type: 'inline',
  line: 9,
};

describe('planRename — self-referencing node', () => {
  test('tombstone: the self-reference rewrite targets the new (moved) file, not the old path that becomes the tombstone', () => {
    const plan = planRename({
      node: selfRefNode,
      newId: 'reference-model',
      newType: 'concept',
      strategy: 'tombstone',
      backlinks: [selfBacklinkRow],
      rewriteRefs: true,
      today: '2026-09-16',
      existingFullIds: ['concept:reference'],
    });

    expect(plan.writes[0].path).toBe('concepts/reference-model.md');
    expect(plan.referenceRewrites).toEqual([
      { path: 'concepts/reference-model.md', line: 9, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
    ]);

    // Applying that rewrite (as rename-modal.ts's applyReferenceRewrites does) against the
    // moved content lands on the self-reference line and points it at the new id.
    const lines = plan.writes[0].content.split('\n');
    const rw = plan.referenceRewrites[0];
    expect(lines[rw.line - 1]).toBe('See also [[concept:reference]] for details.');
    lines[rw.line - 1] = rewriteReference(lines[rw.line - 1], rw.oldFull, rw.newFull);
    expect(lines.join('\n')).toContain('See also [[concept:reference-model]] for details.');

    // The old file's tombstone body already points at the new id by construction, independent
    // of the reference-rewrite mechanism.
    expect(plan.tombstone?.body).toBe('# The Reference Model\n\nMoved to [[concept:reference-model]].\n');
  });

  test('rewrite-in-place: the self-reference rewrite targets the renamed file, not the pre-rename path', () => {
    const plan = planRename({
      node: selfRefNode,
      newId: 'reference-model',
      newType: 'concept',
      strategy: 'rewrite-in-place',
      backlinks: [selfBacklinkRow],
      rewriteRefs: false, // ignored for rewrite-in-place — always rewritten
      today: '2026-09-16',
      existingFullIds: ['concept:reference'],
    });

    expect(plan.renames).toEqual([{ oldPath: 'concepts/reference.md', newPath: 'concepts/reference-model.md' }]);
    expect(plan.referenceRewrites).toEqual([
      { path: 'concepts/reference-model.md', line: 9, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
    ]);

    // Simulate rename-modal.ts's applyPlan: rename (no content change), then the frontmatter
    // rewrite, then the reference rewrite — all three targeting the renamed file's path.
    let content = joinFrontmatter(plan.frontmatterRewrites[0].frontmatterText, selfRefNode.body);
    const lines = content.split('\n');
    const rw = plan.referenceRewrites[0];
    expect(lines[rw.line - 1]).toBe('See also [[concept:reference]] for details.');
    lines[rw.line - 1] = rewriteReference(lines[rw.line - 1], rw.oldFull, rw.newFull);
    content = lines.join('\n');

    expect(content).toContain('See also [[concept:reference-model]] for details.');
    expect(content).not.toContain('[[concept:reference]]');
  });

  test('a non-self backlink row (different path) is unaffected by the self-reference fix-up', () => {
    const otherRow: RenameBacklinkRow = { id: 'concept:other', type: 'concept', path: 'concepts/other.md', ref_type: 'inline', line: 3 };
    const plan = planRename({
      node: selfRefNode,
      newId: 'reference-model',
      newType: 'concept',
      strategy: 'tombstone',
      backlinks: [selfBacklinkRow, otherRow],
      rewriteRefs: true,
      today: '2026-09-16',
      existingFullIds: ['concept:reference'],
    });

    expect(plan.referenceRewrites).toEqual([
      { path: 'concepts/reference-model.md', line: 9, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
      { path: 'concepts/other.md', line: 3, oldFull: 'concept:reference', newFull: 'concept:reference-model' },
    ]);
  });
});

// ---- summarizeRename ------------------------------------------------------------------------

describe('summarizeRename', () => {
  test('tombstone: old address still resolves, no dangling', () => {
    expect(
      summarizeRename({
        oldFull: 'concept:reference',
        newFull: 'concept:reference-model',
        strategy: 'tombstone',
        filesWritten: 2,
        referencesRewritten: 2,
        danglingCount: 0,
      }),
    ).toBe('concept:reference → concept:reference-model · old address still resolves · 2 files · 2 references rewritten');
  });

  test('rewrite-in-place: old address removed, dangling count shown', () => {
    expect(
      summarizeRename({
        oldFull: 'concept:reference',
        newFull: 'concept:reference-model',
        strategy: 'rewrite-in-place',
        filesWritten: 1,
        referencesRewritten: 2,
        danglingCount: 1,
      }),
    ).toBe('concept:reference → concept:reference-model · old address removed · 1 file · 2 references rewritten · 1 backlink now dangling');
  });

  test('singular file count and no references-rewritten clause when zero', () => {
    expect(
      summarizeRename({
        oldFull: 'concept:reference',
        newFull: 'concept:reference-model',
        strategy: 'tombstone',
        filesWritten: 1,
        referencesRewritten: 0,
        danglingCount: 0,
      }),
    ).toBe('concept:reference → concept:reference-model · old address still resolves · 1 file');
  });
});
