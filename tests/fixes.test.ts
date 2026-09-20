import { describe, expect, test } from 'bun:test';
import {
  addTypeToManifest,
  findManifestDependencyLine,
  fixesFor,
  locateFrontmatterFieldLine,
  refreshDisplayOnLine,
  rewriteRefOnLine,
  stripFrontmatterBrackets,
  toLooseEndOnLine,
  type FixDescriptor,
} from '../src/diagnostics/fixes-pure';
import type { FindingLike } from '../src/views/pure-pkg';

// ---- real-shaped manifest fixtures (fictional package names) ---------------------------
// See DESIGN.md's instruction to test `addTypeToManifest` against a real-shaped
// packages/vaire/knowledge.toml contents — reproduced exactly (as of this branch) so the test
// exercises the actual formatting (trailing per-item comments, trailing commas) rather than a
// simplified stand-in.

const VAIRE_MANIFEST = `name    = "vaire"
version = "0.3.0"
description = "The Vairë knowledge system, documented as a Vairë package — philosophy, model, tools, commands, architecture, and roadmap"

# The whole tree is corpus; README.md carries no id/type and stays prose.
include = ["**/*.md"]
exclude = ["**/node_modules/**", "**/drafts/**", "**/archive/**", ".vaire/**"]

# The types this package defines — one line each in README.md §Types.
types = [
  "cli",        # a command-line tool in the Vairë toolchain
  "command",    # one subcommand of a CLI, scoped under its cli: container
  "concept",    # a core concept of the Vairë knowledge model
  "principle",  # a named principle the design serves
  "decision",   # a locked design decision, kept with its rationale
  "component",  # an architectural component inside one of the tools
  "finding",    # a \`vaire check\` finding kind and its sanctioned fix
  "skill",      # a shipped agent skill teaching part of the system
  "document",   # an authoritative design/spec document and its status
  "guide",      # a task-oriented path through the system, written for a person
  "roadmap",    # a planned line of work, not (fully) implemented yet
  "release",    # one published version: its bump and what it added, changed, retired
]
vocabulary_strict = true

# Only commands are scoped (under their cli:); anything else scoping is a mistake.
scoped_types_whitelist = ["command"]

[dependencies]
`;

const ACME_PLATFORM_MANIFEST = `name = "acme-platform"
version = "1.1.0"
description = "Smart Factory Lab's digital infrastructure"

exclude = [
    "templates/**",
    "**/drafts/**",
    "**/draft/**",
    "**/node_modules/**",
]
include = [
    "releases/**/*.md",  # release records, written by vaire release
    "current/**/*.md",
    "proposals/**/*.md",
    "decisions/**/*.md",
    "records/**/*.md",
    "archive/**/*.md",
]
types = [
    "site",
    "network",
    "network-device",
    "server",
    "vm",
    "application",
    "firewall-policy",
    "ot-asset",
    "certificate",
    "service-account",
    "aws-account",
    "aws-resource",
    "person",
    "team",
    "org",
    "project",
    "proposal",
    "decision",
    "record",
    "cluster",
    "dns-record",
    "guide",
]
vocabulary_strict = false

[dependencies]
acme-org = "^1"
acme-security = "^1"
acme-ppl = "^1"
atlas-general = "^1"
atlas-services = "^1"                # services moved out of this corpus keep tombstones here
acme-vision = "^1"  # applications/ot-assets implement CV reference components
`;

// ---- fixesFor ----------------------------------------------------------------------------
// Finding shapes below match the CLI's own `Violation`/`Warning` enums (vaire/src/index/
// check.rs), not the loosely-worded shapes DESIGN.md's "CLI contract nuances" table implies by
// analogy — notably `frontmatter_wikilink` and `unknown_type` carry no `line`.

describe('fixesFor', () => {
  const cases: Array<{ finding: FindingLike; expected: FixDescriptor[] }> = [
    {
      finding: { kind: 'dangling_ref', from: 'application:a', to: 'record:nope', path: 'a.md', line: 3 },
      expected: [
        { id: 'resolve', label: 'Resolve…', needs: 'line' },
        { id: 'loose-end', label: 'Turn into loose end', needs: 'line' },
      ],
    },
    {
      finding: { kind: 'frontmatter_wikilink', id: 'department:hr', field: 'owner', path: 'a.md' },
      expected: [{ id: 'strip-brackets', label: 'Strip brackets', needs: 'line' }],
    },
    {
      finding: { kind: 'unknown_type', id: 'department:hr', field: 'owner', value: 'team:alpha', path: 'a.md' },
      expected: [{ id: 'add-type', label: 'Add type to knowledge.toml', needs: 'manifest' }],
    },
    {
      finding: { kind: 'orphan', id: 'concept:unused', path: 'a.md' },
      expected: [
        { id: 'open-node', label: 'Open node', needs: 'file' },
        { id: 'find-references', label: 'Find references…', needs: 'file' },
      ],
    },
    {
      finding: { kind: 'missing_dependency', package: 'acme-org', note: 'not linked' },
      expected: [
        { id: 'link-from-catalog', label: 'Link from catalog…', needs: 'deps' },
        { id: 'pull', label: 'Pull', needs: 'deps' },
      ],
    },
    {
      finding: { kind: 'drift', id: 'application:a', to: 'record:b', path: 'a.md', line: 5 },
      expected: [
        { id: 'refresh-display', label: 'Refresh display text', needs: 'line' },
        { id: 'open-target', label: 'Open target', needs: 'file' },
      ],
    },
    {
      finding: { kind: 'unused_dependency', package: 'acme-ppl' },
      expected: [{ id: 'open-manifest', label: 'Open knowledge.toml', needs: 'manifest' }],
    },
    {
      finding: { kind: 'dependency_version_mismatch', package: 'acme-ppl', constraint: '^1', version: '2.0.0' },
      expected: [{ id: 'pull', label: 'Pull', needs: 'deps' }],
    },
    {
      finding: { kind: 'undeclared_import', package: 'acme-core', from: 'a:b', to: '@acme-core/c:d', path: 'a.md', line: 2 },
      expected: [{ id: 'declare-dependency', label: 'Declare dependency', needs: 'deps' }],
    },
    {
      finding: { kind: 'duplicate_id', id: 'department:hr', paths: ['a.md', 'b.md'] },
      expected: [{ id: 'open-both', label: 'Open both files', needs: 'file' }],
    },
  ];

  for (const { finding, expected } of cases) {
    test(`${finding.kind}`, () => {
      expect(fixesFor(finding)).toEqual(expected);
    });
  }

  test('kinds with no sanctioned mechanical fix get none', () => {
    for (const kind of ['unreferenceable_id', 'malformed_diagram_ref', 'scoped_type_not_permitted', 'something_new']) {
      expect(fixesFor({ kind })).toEqual([]);
    }
  });

  test('"Create entity…" is never included here — the impure caller appends it only when plugin.hooks.createNode exists', () => {
    const fixes = fixesFor({ kind: 'dangling_ref', from: 'a:b', to: 'c:d', path: 'a.md', line: 1 });
    expect(fixes.find((f) => f.id === 'create-entity')).toBeUndefined();
  });
});

// ---- rewriteRefOnLine ---------------------------------------------------------------------

describe('rewriteRefOnLine', () => {
  test('plain [[to]] -> [[picked|to]] (to itself becomes the preserved wording)', () => {
    expect(rewriteRefOnLine('See [[record:nope]] for details.', 'record:nope', 'record:actual')).toBe(
      'See [[record:actual|record:nope]] for details.',
    );
  });

  test('[[to|Display]] -> [[picked|Display]] (display text preserved)', () => {
    expect(rewriteRefOnLine('See [[record:nope|the inventory]] here.', 'record:nope', 'record:actual')).toBe(
      'See [[record:actual|the inventory]] here.',
    );
  });

  test('no matching occurrence on the line -> unchanged (stale finding)', () => {
    const line = 'See [[record:other]] here.';
    expect(rewriteRefOnLine(line, 'record:nope', 'record:actual')).toBe(line);
  });

  test('only the matching wikilink among several on the line is rewritten', () => {
    const line = '[[record:nope]] and [[record:other|kept]] both here.';
    expect(rewriteRefOnLine(line, 'record:nope', 'record:actual')).toBe(
      '[[record:actual|record:nope]] and [[record:other|kept]] both here.',
    );
  });
});

// ---- toLooseEndOnLine ----------------------------------------------------------------------

describe('toLooseEndOnLine', () => {
  test('[[type:id-with-hyphens]] -> [[?type: id with hyphens]] (hyphens become spaces)', () => {
    expect(toLooseEndOnLine('per [[record:2026-07-14-inventory]] above', 'record:2026-07-14-inventory')).toBe(
      'per [[?record: 2026 07 14 inventory]] above',
    );
  });

  test('[[type:id|Display]] -> [[?type: Display]] (author wording wins over derived id words)', () => {
    expect(toLooseEndOnLine('per [[record:2026-07-14-inventory|the inventory]] above', 'record:2026-07-14-inventory')).toBe(
      'per [[?record: the inventory]] above',
    );
  });

  test('no matching occurrence on the line -> unchanged', () => {
    const line = 'per [[record:other]] above';
    expect(toLooseEndOnLine(line, 'record:2026-07-14-inventory')).toBe(line);
  });
});

// ---- refreshDisplayOnLine ------------------------------------------------------------------

describe('refreshDisplayOnLine', () => {
  test('stale |Display is replaced with the current name', () => {
    expect(refreshDisplayOnLine('see [[record:b|Old Name]] here', 'record:b', 'New Name')).toBe(
      'see [[record:b|New Name]] here',
    );
  });

  test('display already matches -> unchanged (no-op, not just idempotent)', () => {
    const line = 'see [[record:b|New Name]] here';
    expect(refreshDisplayOnLine(line, 'record:b', 'New Name')).toBe(line);
  });

  test('no |display at all -> unchanged (never invents display text)', () => {
    const line = 'see [[record:b]] here';
    expect(refreshDisplayOnLine(line, 'record:b', 'New Name')).toBe(line);
  });

  test('no matching occurrence on the line -> unchanged', () => {
    const line = 'see [[record:other|X]] here';
    expect(refreshDisplayOnLine(line, 'record:b', 'New Name')).toBe(line);
  });
});

// ---- stripFrontmatterBrackets --------------------------------------------------------------

describe('stripFrontmatterBrackets', () => {
  test('unwraps a plain [[type:id]] value', () => {
    expect(stripFrontmatterBrackets('owner: [[department:hr]]')).toBe('owner: department:hr');
  });

  test('a leading-@ (cross-package) value is quoted once unwrapped', () => {
    expect(stripFrontmatterBrackets('managed_by: [[@acme-core/team:platform]]')).toBe(
      'managed_by: "@acme-core/team:platform"',
    );
  });

  test('no brackets on the line -> unchanged', () => {
    const line = 'owner: department:hr';
    expect(stripFrontmatterBrackets(line)).toBe(line);
  });
});

// ---- addTypeToManifest ---------------------------------------------------------------------

describe('addTypeToManifest', () => {
  test('appends to a multi-line array with per-item trailing comments (packages/vaire/knowledge.toml)', () => {
    const result = addTypeToManifest(VAIRE_MANIFEST, 'finding-fix');
    expect(result).toContain('"release",    # one published version: its bump and what it added, changed, retired\n  "finding-fix",\n]');
    // every other line is untouched — same line count plus exactly one inserted line.
    expect(result.split('\n').length).toBe(VAIRE_MANIFEST.split('\n').length + 1);
    expect(result).toContain('vocabulary_strict = true');
    expect(result).toContain('scoped_types_whitelist = ["command"]');
  });

  test('appends to a multi-line array with no comments and an already-comma-terminated last item (acme-platform)', () => {
    const result = addTypeToManifest(ACME_PLATFORM_MANIFEST, 'switch');
    expect(result).toContain('    "guide",\n    "switch",\n]');
    expect(result.split('\n').length).toBe(ACME_PLATFORM_MANIFEST.split('\n').length + 1);
  });

  test('already-declared type -> unchanged (no duplicate insertion)', () => {
    expect(addTypeToManifest(VAIRE_MANIFEST, 'cli')).toBe(VAIRE_MANIFEST);
    expect(addTypeToManifest(ACME_PLATFORM_MANIFEST, 'server')).toBe(ACME_PLATFORM_MANIFEST);
  });

  test('single-line array gains a new entry', () => {
    expect(addTypeToManifest('types = ["a", "b"]\n', 'c')).toBe('types = ["a", "b", "c"]\n');
  });

  test('single-line empty array gains its first entry with no leading comma', () => {
    expect(addTypeToManifest('types = []\n', 'a')).toBe('types = ["a"]\n');
  });

  test('single-line array: already-declared type -> unchanged', () => {
    const text = 'types = ["a", "b"]\n';
    expect(addTypeToManifest(text, 'b')).toBe(text);
  });

  test('no `types = [` array at all -> unchanged (needs a human, not a quick fix)', () => {
    const text = 'name = "x"\nversion = "1.0.0"\n';
    expect(addTypeToManifest(text, 'a')).toBe(text);
  });
});

// ---- locateFrontmatterFieldLine -------------------------------------------------------------

describe('locateFrontmatterFieldLine', () => {
  const file = `---
id: hr
type: department
name: Human Resources
owner: [[org:smart-factory-lab]]
aliases: [HR]
---
# Human Resources

Owns onboarding. See owner: for details (not frontmatter, must not match).
`;

  test('finds a top-level frontmatter key and returns its 1-based line number', () => {
    expect(locateFrontmatterFieldLine(file, 'owner')).toBe(5);
    expect(locateFrontmatterFieldLine(file, 'id')).toBe(2);
    expect(locateFrontmatterFieldLine(file, 'aliases')).toBe(6);
  });

  test('a field not present in frontmatter -> null', () => {
    expect(locateFrontmatterFieldLine(file, 'nonexistent')).toBeNull();
  });

  test('text that merely looks like the key in the body (past the closing ---) is not matched', () => {
    // "owner:" appears in the prose body too, but locateFrontmatterFieldLine must stop at the
    // frontmatter's closing delimiter — this file's frontmatter `owner:` is still found once,
    // at line 5, not the body occurrence.
    expect(locateFrontmatterFieldLine(file, 'owner')).toBe(5);
  });

  test('no frontmatter block at all -> null', () => {
    expect(locateFrontmatterFieldLine('# Just a heading\n\nNo frontmatter here.\n', 'owner')).toBeNull();
  });

  test('unterminated frontmatter (no closing ---) -> null', () => {
    expect(locateFrontmatterFieldLine('---\nid: hr\ntype: department\n', 'id')).toBeNull();
  });
});

// ---- findManifestDependencyLine --------------------------------------------------------------

describe('findManifestDependencyLine', () => {
  test('finds an entry with a trailing comment (real-shaped acme-platform manifest)', () => {
    expect(findManifestDependencyLine(ACME_PLATFORM_MANIFEST, 'atlas-services')).toBe(50);
    expect(findManifestDependencyLine(ACME_PLATFORM_MANIFEST, 'acme-vision')).toBe(51);
  });

  test('finds a plain entry with no trailing comment', () => {
    expect(findManifestDependencyLine(ACME_PLATFORM_MANIFEST, 'acme-org')).toBe(46);
  });

  test('a name not declared -> null', () => {
    expect(findManifestDependencyLine(ACME_PLATFORM_MANIFEST, 'nonexistent')).toBeNull();
  });

  test('no [dependencies] table at all -> null', () => {
    expect(findManifestDependencyLine('name = "x"\n', 'anything')).toBeNull();
  });
});
