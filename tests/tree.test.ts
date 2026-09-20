import { describe, expect, test } from 'bun:test';
import { buildTree, filterTree, pathToNode, type NodeLike, type TreeNode } from '../src/tree/pure';

function node(overrides: Partial<NodeLike> & Pick<NodeLike, 'type' | 'full' | 'name' | 'path'>): NodeLike {
  return { aliases: [], ...overrides };
}

// Fixture: a `cli:vaire` container node plus several `command` nodes scoped under it, some
// unscoped nodes of other types, and one superseded command.
const container = node({ type: 'cli', full: 'cli:vaire', name: 'vaire CLI', path: 'cli/vaire.md' });
const cmdAdd = node({ type: 'command', full: 'command:add', name: 'add', scope: 'cli:vaire', path: 'commands/add.md' });
const cmdBacklinks = node({
  type: 'command',
  full: 'command:backlinks',
  name: 'backlinks',
  scope: 'cli:vaire',
  path: 'commands/backlinks.md',
});
const cmdOld = node({
  type: 'command',
  full: 'command:old',
  name: 'old-add',
  scope: 'cli:vaire',
  path: 'commands/old.md',
  supersededBy: 'command:add',
});
const concept = node({ type: 'concept', full: 'concept:reference', name: 'Reference', path: 'concepts/reference.md' });
const guide = node({ type: 'guide', full: 'guide:getting-started', name: 'Getting started', path: 'guides/start.md' });

const fixture: NodeLike[] = [container, cmdAdd, cmdBacklinks, cmdOld, concept, guide];

function findByKeyPrefix(tree: TreeNode[], prefix: string): TreeNode | undefined {
  for (const n of tree) {
    if (n.key.startsWith(prefix)) return n;
    const sub = findByKeyPrefix(n.children, prefix);
    if (sub) return sub;
  }
  return undefined;
}

describe('buildTree: nested vs flat scoped layout', () => {
  test('nested: scoped command nodes are not in their own type group, but under the container', () => {
    const tree = buildTree(fixture, { scopedLayout: 'nested', groupBy: 'type' });
    expect(tree.map((g) => g.type)).toEqual(['cli', 'concept', 'guide']);

    const cliGroup = tree.find((g) => g.type === 'cli')!;
    expect(cliGroup.children.map((n) => n.fullId)).toEqual(['cli:vaire']);

    const containerRow = cliGroup.children[0];
    expect(containerRow.fullId).toBe('cli:vaire');
    // Child-count badge: 3 scoped command nodes (including the superseded one).
    expect(containerRow.count).toBe(3);
    expect(containerRow.children.map((g) => g.type)).toEqual(['command']);

    const commandGroup = containerRow.children[0];
    expect(commandGroup.count).toBe(3);
    // Active nodes sorted by name, superseded last.
    expect(commandGroup.children.map((n) => n.fullId)).toEqual(['command:add', 'command:backlinks', 'command:old']);
    expect(commandGroup.children.map((n) => n.gone)).toEqual([false, false, true]);
  });

  test('flat: every node appears in its own type group; scoped nodes carry scopedInName', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    expect(tree.map((g) => g.type).sort()).toEqual(['cli', 'command', 'concept', 'guide']);

    const commandGroup = tree.find((g) => g.type === 'command')!;
    expect(commandGroup.count).toBe(3);
    const add = commandGroup.children.find((n) => n.fullId === 'command:add')!;
    expect(add.scopedInName).toBe('vaire CLI');
    expect(add.missingContainer).toBeFalsy();

    // The container itself has no nested children in flat layout (no count badge either).
    const cliGroup = tree.find((g) => g.type === 'cli')!;
    const containerRow = cliGroup.children[0];
    expect(containerRow.children).toEqual([]);
    expect(containerRow.count).toBeUndefined();
  });
});

describe('buildTree: scoped node with a missing container', () => {
  const orphan = node({
    type: 'command',
    full: 'command:orphan',
    name: 'orphan-cmd',
    scope: 'cli:nonexistent',
    path: 'commands/orphan.md',
  });
  const withOrphan = [...fixture, orphan];

  test('nested layout: falls back to its own type group with missingContainer set', () => {
    const tree = buildTree(withOrphan, { scopedLayout: 'nested', groupBy: 'type' });
    const commandGroup = tree.find((g) => g.type === 'command');
    expect(commandGroup).toBeDefined();
    const row = commandGroup!.children.find((n) => n.fullId === 'command:orphan')!;
    expect(row).toBeDefined();
    expect(row.missingContainer).toBe(true);
    expect(row.scopedInName).toBeUndefined();

    // It must not be nested under the real container's children.
    const cliGroup = tree.find((g) => g.type === 'cli')!;
    const containerRow = cliGroup.children[0];
    const nestedCommandGroup = containerRow.children.find((g) => g.type === 'command')!;
    expect(nestedCommandGroup.children.map((n) => n.fullId)).not.toContain('command:orphan');
  });

  test('flat layout: also falls back with missingContainer set (no suffix to show)', () => {
    const tree = buildTree(withOrphan, { scopedLayout: 'flat', groupBy: 'type' });
    const commandGroup = tree.find((g) => g.type === 'command')!;
    const row = commandGroup.children.find((n) => n.fullId === 'command:orphan')!;
    expect(row.missingContainer).toBe(true);
    expect(row.scopedInName).toBeUndefined();
  });
});

describe('buildTree: folder grouping', () => {
  test('mirrors the directory layout, with node names/types instead of file names', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'folder' });
    const labels = tree.map((n) => n.label).sort();
    expect(labels).toEqual(['cli', 'commands', 'concepts', 'guides']);

    const commandsFolder = tree.find((n) => n.label === 'commands')!;
    expect(commandsFolder.kind).toBe('folder');
    expect(commandsFolder.count).toBe(3);
    expect(commandsFolder.children.map((n) => n.fullId)).toEqual(['command:add', 'command:backlinks', 'command:old']);
    // Node rows carry their type, for a type badge, not a filename.
    expect(commandsFolder.children[0].type).toBe('command');
  });

  test('nested layout still nests scoped children under the container, by type, inside folder mode', () => {
    const tree = buildTree(fixture, { scopedLayout: 'nested', groupBy: 'folder' });
    const cliFolder = tree.find((n) => n.label === 'cli')!;
    const containerRow = cliFolder.children.find((n) => n.fullId === 'cli:vaire')!;
    expect(containerRow.count).toBe(3);
    expect(containerRow.children.map((g) => g.type)).toEqual(['command']);
    // The scoped commands' own folder ("commands") gets no group at all — they were consumed
    // as the container's children instead of top-level folder entries.
    expect(tree.find((n) => n.label === 'commands')).toBeUndefined();
  });

  test('a node directly at the package root (no directory) is a top-level leaf, not a folder', () => {
    const rootNode = node({ type: 'readme', full: 'readme:root', name: 'Root doc', path: 'root.md' });
    const tree = buildTree([rootNode], { scopedLayout: 'flat', groupBy: 'folder' });
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('node');
    expect(tree[0].fullId).toBe('readme:root');
  });
});

describe('buildTree: superseded ordering', () => {
  test('active nodes sort by name first; superseded nodes are appended after, faded', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    const commandGroup = tree.find((g) => g.type === 'command')!;
    // "old-add" would sort before "backlinks" alphabetically if not demoted for being superseded.
    expect(commandGroup.children.map((n) => n.fullId)).toEqual(['command:add', 'command:backlinks', 'command:old']);
    expect(commandGroup.children.map((n) => n.gone)).toEqual([false, false, true]);
  });

  test('ties on name are broken by full id', () => {
    const a = node({ type: 'concept', full: 'concept:z-dup', name: 'Duplicate', path: 'concepts/z-dup.md' });
    const b = node({ type: 'concept', full: 'concept:a-dup', name: 'duplicate', path: 'concepts/a-dup.md' });
    const tree = buildTree([a, b], { scopedLayout: 'flat', groupBy: 'type' });
    expect(tree[0].children.map((n) => n.fullId)).toEqual(['concept:a-dup', 'concept:z-dup']);
  });
});

describe('filterTree', () => {
  test('empty text is a no-op', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    const result = filterTree(tree, '   ');
    expect(result.tree).toBe(tree);
    expect(result.expandKeys.size).toBe(0);
  });

  test('matches by name, id, and prunes non-matching branches, reporting ancestor keys to expand', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    const result = filterTree(tree, 'backlinks');
    // Only the `command` group survives, with only the matching node inside it.
    expect(result.tree.map((g) => g.type)).toEqual(['command']);
    expect(result.tree[0].children.map((n) => n.fullId)).toEqual(['command:backlinks']);
    expect(result.expandKeys.has('type:command')).toBe(true);
  });

  test('matches by alias', () => {
    const aliased = node({
      type: 'concept',
      full: 'concept:x',
      name: 'Something',
      path: 'concepts/x.md',
      aliases: ['secret-name'],
    });
    const tree = buildTree([aliased], { scopedLayout: 'flat', groupBy: 'type' });
    const result = filterTree(tree, 'secret-name');
    expect(result.tree[0].children.map((n) => n.fullId)).toEqual(['concept:x']);
  });

  test('auto-expands through nested container groups when a scoped child matches', () => {
    const tree = buildTree(fixture, { scopedLayout: 'nested', groupBy: 'type' });
    const result = filterTree(tree, 'command:add');
    const cliGroup = result.tree.find((g) => g.type === 'cli')!;
    expect(cliGroup).toBeDefined();
    const containerRow = cliGroup.children[0];
    expect(containerRow.fullId).toBe('cli:vaire');
    const commandGroup = containerRow.children[0];
    expect(commandGroup.children.map((n) => n.fullId)).toEqual(['command:add']);
    // Ancestor keys are all reported for force-expansion.
    expect(result.expandKeys.has('type:cli')).toBe(true);
    expect(result.expandKeys.has(containerRow.key)).toBe(true);
    expect(result.expandKeys.has(commandGroup.key)).toBe(true);
  });

  test('no matches yields an empty tree', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    const result = filterTree(tree, 'nonexistent-xyz');
    expect(result.tree).toEqual([]);
  });
});

describe('pathToNode', () => {
  test('finds the ancestor key path down to a node, including nested container groups', () => {
    const tree = buildTree(fixture, { scopedLayout: 'nested', groupBy: 'type' });
    const path = pathToNode(tree, 'node:command:add');
    expect(path).not.toBeNull();
    // type:cli -> node:cli:vaire -> container:cli:vaire/type:command -> node:command:add
    expect(path).toEqual(['type:cli', 'node:cli:vaire', 'container:cli:vaire/type:command', 'node:command:add']);
  });

  test('returns null for an unknown key', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    expect(pathToNode(tree, 'node:nope:nope')).toBeNull();
  });

  test('finds a top-level node directly', () => {
    const tree = buildTree(fixture, { scopedLayout: 'flat', groupBy: 'type' });
    const path = pathToNode(tree, 'node:concept:reference');
    expect(path).toEqual(['type:concept', 'node:concept:reference']);
  });
});
