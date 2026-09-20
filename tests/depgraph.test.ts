import { describe, expect, test } from 'bun:test';
import {
  buildDepGraph,
  buildDepOutline,
  conflicts,
  resolvedFromOf,
  type DepGraphNode,
  type DepOutlineNode,
} from '../src/depgraph/pure';
import type { DepsResult } from '../src/types';
import fixture from './fixtures/deps-acme-platform.json';

// Shaped after real `vaire deps -o json --repo <package>` output (DESIGN.md's worked example),
// with fictional package names substituted throughout: several diamond-shared dependencies plus
// two genuine cycles back to the root, `acme-platform`, via `atlas-general`/`atlas-services`.
const DEPS: DepsResult = fixture as unknown as DepsResult;

const ROOT_ABS = '/home/dev/Projects/vaire-all/packages/acme-platform';
const STORE_DIR = '/home/dev/.vaire/store';
const OPTS = { rootName: DEPS.name, rootAbs: ROOT_ABS, vaultRoots: [ROOT_ABS], storeDir: STORE_DIR };

function nodeByName(nodes: DepGraphNode[], name: string): DepGraphNode {
  const found = nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node named '${name}'`);
  return found;
}

// ---- buildDepGraph: dedup ------------------------------------------------------------------

describe('buildDepGraph — dedup by name', () => {
  const { nodes, edges } = buildDepGraph(DEPS, OPTS);

  test('every package name appears exactly once, however many times the raw tree repeats it', () => {
    const names = nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    // acme-security is a direct dep AND appears again under acme-vision; acme-org
    // is a direct dep AND appears again under acme-security (twice, in fact) — still one node each.
    expect(names.filter((n) => n === 'acme-security')).toHaveLength(1);
    expect(names.filter((n) => n === 'acme-org')).toHaveLength(1);
  });

  test('the full distinct closure is present, including the root reached back via a cycle', () => {
    expect(new Set(nodes.map((n) => n.name))).toEqual(
      new Set([
        'acme-security',
        'acme-org',
        'acme-vision',
        'acme-ppl',
        'atlas-general',
        'atlas-services',
        'acme-arch',
        'acme-general',
        'acme-it',
        'acme-platform', // the root, reached again through atlas-general/atlas-services (cycle)
      ]),
    );
  });

  test('edges are deduped too — a (parent, dependency) pair never appears twice', () => {
    const keys = edges.map((e) => `${e.source}->${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---- parents / direct -----------------------------------------------------------------------

describe('buildDepGraph — parents and direct flag', () => {
  const { nodes, edges } = buildDepGraph(DEPS, OPTS);

  test('a direct dependency of the root has `direct: true` and an edge from the root name', () => {
    const isec = nodeByName(nodes, 'acme-security');
    expect(isec.direct).toBe(true);
    expect(edges).toContainEqual({ source: 'acme-platform', target: 'acme-security' });
  });

  test('a purely transitive dependency has `direct: false`', () => {
    const archMeta = nodeByName(nodes, 'acme-arch');
    expect(archMeta.direct).toBe(false);
    expect(archMeta.parents).toEqual([{ name: 'acme-vision', constraint: '^1' }]);
  });

  test('a dependency reached via several parents lists every declaring parent', () => {
    // acme-org is declared directly by the root AND by acme-security AND by
    // acme-vision AND by acme-ppl AND by atlas-general — several incoming edges,
    // one node.
    const org = nodeByName(nodes, 'acme-org');
    expect(org.direct).toBe(true);
    const parentNames = new Set(org.parents.map((p) => p.name));
    expect(parentNames.has('acme-platform')).toBe(true);
    expect(parentNames.has('acme-security')).toBe(true);
    expect(parentNames.has('acme-vision')).toBe(true);
    expect(org.parents.length).toBeGreaterThan(1);
  });

  test('the root reached via a cycle is never `direct` and is declared by the packages that cycle back', () => {
    const root = nodeByName(nodes, 'acme-platform');
    expect(root.direct).toBe(false);
    const parentNames = new Set(root.parents.map((p) => p.name));
    expect(parentNames.has('atlas-general')).toBe(true);
    expect(parentNames.has('atlas-services')).toBe(true);
  });
});

// ---- state classification --------------------------------------------------------------------

describe('buildDepGraph — state', () => {
  const { nodes } = buildDepGraph(DEPS, OPTS);

  test('satisfied, resolved, not part of any cycle -> ok', () => {
    expect(nodeByName(nodes, 'acme-vision').state).toBe('ok');
    expect(nodeByName(nodes, 'atlas-services').state).toBe('ok');
  });

  test('"not linked" note -> unlinked', () => {
    expect(nodeByName(nodes, 'acme-org').state).toBe('unlinked');
    expect(nodeByName(nodes, 'acme-arch').state).toBe('unlinked');
    expect(nodeByName(nodes, 'acme-general').state).toBe('unlinked');
    expect(nodeByName(nodes, 'acme-it').state).toBe('unlinked');
  });

  test('a name that is *only* ever reached via a cycle occurrence -> cycle', () => {
    expect(nodeByName(nodes, 'acme-platform').state).toBe('cycle');
  });

  test('a name resolved cleanly at some occurrences but also re-entered as a cycle elsewhere in '
    + 'the closure is still flagged `cycle` overall — worth noticing even though it also resolves '
    + 'fine on its own', () => {
    // acme-ppl and atlas-general are both fully resolved & satisfied directly under the root,
    // but each is *also* re-entered (cycle: true) deeper in another branch — `cycle` wins over
    // `ok` in the merge so the loop isn't hidden by the node's other, unproblematic occurrences.
    expect(nodeByName(nodes, 'acme-ppl').state).toBe('cycle');
    expect(nodeByName(nodes, 'atlas-general').state).toBe('cycle');
  });

  test('a name never involved in any cycle occurrence stays plain `ok`', () => {
    expect(nodeByName(nodes, 'acme-security').state).toBe('ok');
  });
});

// ---- resolvedFrom -----------------------------------------------------------------------------

describe('buildDepGraph — resolvedFrom', () => {
  const { nodes } = buildDepGraph(DEPS, OPTS);

  test('a store-resolved dependency classifies as "store"', () => {
    const isec = nodeByName(nodes, 'acme-security');
    expect(isec.absRoot).toBe(`${STORE_DIR}/acme-security/1.2.0`);
    expect(isec.resolvedFrom).toBe('store');
  });

  test('an unlinked dependency (no resolved root at all) classifies as "unresolved"', () => {
    const org = nodeByName(nodes, 'acme-org');
    expect(org.absRoot).toBeUndefined();
    expect(org.resolvedFrom).toBe('unresolved');
  });

  test('the root reached via a cycle resolves to "." — the run root itself — classified as "working copy"', () => {
    const root = nodeByName(nodes, 'acme-platform');
    expect(root.absRoot).toBe(ROOT_ABS);
    expect(root.resolvedFrom).toBe('working copy');
  });
});

describe('resolvedFromOf', () => {
  test('undefined path -> unresolved', () => {
    expect(resolvedFromOf(undefined, [ROOT_ABS], STORE_DIR)).toBe('unresolved');
  });

  test('a path matching a vault root exactly -> working copy', () => {
    expect(resolvedFromOf(ROOT_ABS, [ROOT_ABS, '/home/dev/Projects/vaire-all/packages/vaire'], STORE_DIR)).toBe(
      'working copy',
    );
  });

  test('a path under the store dir -> store', () => {
    expect(resolvedFromOf(`${STORE_DIR}/acme-org/1.0.0`, [ROOT_ABS], STORE_DIR)).toBe('store');
  });

  test('anything else -> linked checkout', () => {
    expect(resolvedFromOf('/home/dev/checkouts/acme-org', [ROOT_ABS], STORE_DIR)).toBe('linked checkout');
  });
});

// ---- conflicts --------------------------------------------------------------------------------

describe('conflicts', () => {
  test('the fixture has no version conflicts', () => {
    const { nodes } = buildDepGraph(DEPS, OPTS);
    expect(conflicts(nodes)).toEqual([]);
  });

  test('a synthetic second version of the same package is flagged as a conflict', () => {
    // acme-security resolves to 1.2.0 everywhere in the fixture tree; splice in a second, differently
    // versioned occurrence (as if a second branch pinned an older release) to exercise the
    // conflict path DESIGN.md calls for.
    const withConflict: DepsResult = {
      ...DEPS,
      dependencies: [
        ...DEPS.dependencies,
        {
          name: 'conflicted-branch',
          constraint: '^1',
          version: '1.0.0',
          resolved: '../../../../.vaire/store/conflicted-branch/1.0.0',
          satisfied: true,
          dependencies: [
            {
              name: 'acme-security',
              constraint: '^1',
              version: '1.1.0',
              resolved: '../../../../.vaire/store/acme-security/1.1.0',
              satisfied: true,
            },
          ],
        },
      ],
    };
    const { nodes } = buildDepGraph(withConflict, OPTS);
    const isec = nodeByName(nodes, 'acme-security');
    expect(isec.versions.sort()).toEqual(['1.1.0', '1.2.0']);
    const flagged = conflicts(nodes);
    expect(flagged.map((n) => n.name)).toContain('acme-security');
  });
});

// ---- buildDepOutline ----------------------------------------------------------------------

function findOutline(nodes: DepOutlineNode[], name: string): DepOutlineNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const found = findOutline(n.children, name);
    if (found) return found;
  }
  return undefined;
}

describe('buildDepOutline', () => {
  const outline = buildDepOutline(DEPS, OPTS);

  test('mirrors the CLI\'s raw top-level nesting, one row per declared direct dependency', () => {
    expect(outline.map((n) => n.name)).toEqual([
      'acme-security',
      'acme-org',
      'acme-vision',
      'acme-ppl',
      'atlas-general',
      'atlas-services',
    ]);
  });

  test('the first occurrence of a name is expanded with its children', () => {
    const isec = outline.find((n) => n.name === 'acme-security')!;
    expect(isec.seeAbove).toBe(false);
    expect(isec.children.map((c) => c.name)).toEqual(['acme-org']);
  });

  test('a repeated occurrence of the same name collapses to a childless "see above" leaf', () => {
    // acme-security is nested again under acme-vision — same package, second time.
    const pnl = outline.find((n) => n.name === 'acme-vision')!;
    const nestedIsec = pnl.children.find((c) => c.name === 'acme-security')!;
    expect(nestedIsec.seeAbove).toBe(true);
    expect(nestedIsec.children).toEqual([]);
    // Its own row data (constraint/version/state) is still present, just not expanded further.
    expect(nestedIsec.version).toBe('1.2.0');
    expect(nestedIsec.state).toBe('ok');
  });

  test('a CLI-marked cycle occurrence back to the root collapses to "see above" too', () => {
    const root = findOutline(outline, 'acme-platform');
    expect(root).toBeDefined();
    expect(root!.seeAbove).toBe(true);
    expect(root!.children).toEqual([]);
    expect(root!.state).toBe('cycle');
  });

  test('an unlinked leaf has no children regardless of seeAbove (it was never fully shown, there '
    + 'is nothing to point back to, but it has no `dependencies` in the CLI output either way)', () => {
    // Depth-first pre-order visits acme-security (row 1) and its child acme-org *before* the
    // top-level acme-org row (row 2) — so the nested occurrence is the true first sighting of
    // 'acme-org', not the top-level one.
    const isec = outline.find((n) => n.name === 'acme-security')!;
    const nestedOrg = isec.children.find((c) => c.name === 'acme-org')!;
    expect(nestedOrg.seeAbove).toBe(false);
    expect(nestedOrg.children).toEqual([]);
    expect(nestedOrg.state).toBe('unlinked');

    const topOrg = outline.find((n) => n.name === 'acme-org')!;
    expect(topOrg.seeAbove).toBe(true); // already shown, above, as acme-security's child
    expect(topOrg.children).toEqual([]);
    expect(topOrg.state).toBe('unlinked');
  });

  test('every direct-dependency row has `direct: true`; nested rows do not', () => {
    for (const n of outline) expect(n.direct).toBe(true);
    const nested = outline.find((n) => n.name === 'acme-security')!.children[0];
    expect(nested.direct).toBe(false);
  });
});
