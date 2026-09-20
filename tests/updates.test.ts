import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  formatBytes,
  lockfilePins,
  mergeDepsWithUpdates,
  parseCleanDryRun,
  parsePullDryRun,
  updatesHealthIssue,
} from '../src/updates/pure';

const FIXTURES_DIR = path.join(import.meta.dir, 'fixtures');

function fixtureJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// ---- parsePullDryRun — shaped after real 0.3.2 output (fictional package names) ----------
// (`vaire pull [--dry-run] -o json --repo <package>`; see DESIGN.md "CLI contract
// nuances": the shape is undocumented, so every fixture here is what the binary actually printed,
// not a guess.)

describe('parsePullDryRun — pull-dry-run-all.json (bare `pull --dry-run`, one dep unlinked/no registry)', () => {
  const parsed = parsePullDryRun(fixtureJson('pull-dry-run-all.json'));

  test('no updates (nothing pulled)', () => {
    expect(parsed.updates).toEqual([]);
  });

  test('one error, with the registry extracted from "looked in acme"', () => {
    expect(parsed.errors).toEqual([
      {
        package: 'acme-org',
        registry: 'acme',
        message: 'registry error: no registry serves acme-org ^1 — looked in acme',
      },
    ]);
  });

  test('no upToDate entries', () => {
    expect(parsed.upToDate).toEqual([]);
  });

  test('raw is not set — the shape was recognized', () => {
    expect(parsed.raw).toBeUndefined();
  });
});

describe('parsePullDryRun — pull-dry-run-already.json (`pull acme-security --dry-run`, already at that version)', () => {
  const parsed = parsePullDryRun(fixtureJson('pull-dry-run-already.json'));

  test('no updates, no errors', () => {
    expect(parsed.updates).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  test('upToDate names the dependency (dropping the version suffix)', () => {
    expect(parsed.upToDate).toEqual(['acme-security']);
  });
});

describe('parsePullDryRun — pull-dry-run-pulled.json (`pull acme-general --dry-run`, would fetch it)', () => {
  const parsed = parsePullDryRun(fixtureJson('pull-dry-run-pulled.json'));

  test('one update, "to" from the pulled entry\'s version', () => {
    expect(parsed.updates).toEqual([{ name: 'acme-general', to: '1.2.0', citedChanges: undefined }]);
  });

  test('no errors, no citedChanges (the dry run did not report any)', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.updates[0].citedChanges).toBeUndefined();
  });
});

describe('parsePullDryRun — citedChanges extraction', () => {
  test('picks up a recognized field name on a pulled entry', () => {
    const parsed = parsePullDryRun({
      pulled: [{ package: 'acme-core', version: '2.0.0', cited_changes: ['concept:widget', 'decision:x'] }],
    });
    expect(parsed.updates).toEqual([{ name: 'acme-core', to: '2.0.0', citedChanges: ['concept:widget', 'decision:x'] }]);
  });

  test('ignores a same-named field that is not a string array', () => {
    const parsed = parsePullDryRun({ pulled: [{ package: 'acme-core', version: '2.0.0', cited_changes: 'not-an-array' }] });
    expect(parsed.updates[0].citedChanges).toBeUndefined();
  });
});

describe('parsePullDryRun — unrecognized shapes fall back to raw', () => {
  test('a JSON object with none of pulled/already/failed', () => {
    const input = { something: 'else' };
    expect(parsePullDryRun(input)).toEqual({ updates: [], errors: [], upToDate: [], raw: input });
  });

  test('a non-object value', () => {
    expect(parsePullDryRun('unexpected string')).toEqual({ updates: [], errors: [], upToDate: [], raw: 'unexpected string' });
    expect(parsePullDryRun(null)).toEqual({ updates: [], errors: [], upToDate: [], raw: null });
    expect(parsePullDryRun([1, 2, 3])).toEqual({ updates: [], errors: [], upToDate: [], raw: [1, 2, 3] });
  });

  test('string-shaped pulled/failed/already entries are tolerated too', () => {
    const parsed = parsePullDryRun({
      pulled: ['acme-core@2.0.0', 'acme-utils 3.1.0', 'bare-name'],
      already: ['acme-old 1.0.0'],
      failed: ['just a message, no structure'],
    });
    expect(parsed.updates).toEqual([
      { name: 'acme-core', to: '2.0.0', citedChanges: undefined },
      { name: 'acme-utils', to: '3.1.0', citedChanges: undefined },
      { name: 'bare-name', to: undefined, citedChanges: undefined },
    ]);
    expect(parsed.upToDate).toEqual(['acme-old']);
    expect(parsed.errors).toEqual([{ message: 'just a message, no structure', registry: undefined, package: undefined }]);
  });
});

// ---- The `--locked` refusal — a whole-call failure, not something parsePullDryRun ever sees ---
// (VaireCli.pull throws a VaireError for this; see tests/cli.test.ts and src/updates/index.ts's
// runUpdatesCheck, which turns it into `{error: {kind, message}}` instead of a parsed result.)

describe('pull-locked-error.json — captured shape of a real --locked refusal', () => {
  test('is an error envelope, not a pull result parsePullDryRun would recognize', () => {
    const envelope = fixtureJson('pull-locked-error.json') as { error: { code: number; kind: string; message: string } };
    expect(envelope.error.kind).toBe('registry');
    expect(envelope.error.message).toContain('cannot be obtained again');
    // Fed through parsePullDryRun anyway (defensively), it's just an unrecognized shape.
    expect(parsePullDryRun(envelope).raw).toBe(envelope);
  });
});

// ---- updatesHealthIssue -------------------------------------------------------------------

describe('updatesHealthIssue', () => {
  test('null when there are no updates', () => {
    expect(updatesHealthIssue({ updates: [], errors: [], upToDate: [] })).toBeNull();
  });

  test('one info-severity issue naming every updatable dependency', () => {
    const issue = updatesHealthIssue({
      updates: [{ name: 'acme-general', to: '1.2.0' }, { name: 'acme-it', to: '1.3.1' }],
      errors: [],
      upToDate: [],
    });
    expect(issue).toEqual({
      kind: 'updates_available',
      severity: 'info',
      message: "2 dependency update(s) available: acme-general, acme-it",
      action: 'open_index',
    });
  });
});

// ---- parseCleanDryRun — shaped after real 0.3.2 output --------------------------------------

describe('parseCleanDryRun — clean-dry-run.json (nothing to remove)', () => {
  const parsed = parseCleanDryRun(fixtureJson('clean-dry-run.json'));

  test('empty removed list, kept count passed through', () => {
    expect(parsed.removed).toEqual([]);
    expect(parsed.kept).toBe(6);
    expect(parsed.totalSizeBytes).toBeUndefined();
  });
});

describe('parseCleanDryRun — a hypothetical non-empty removed list (shape not captured live)', () => {
  test('object entries with a size field sum into totalSizeBytes', () => {
    const parsed = parseCleanDryRun({
      removed: [
        { package: 'acme-old', version: '1.0.0', size: 1024 },
        { package: 'acme-older', version: '0.9.0', size: 2048 },
      ],
      kept: 4,
    });
    expect(parsed.removed).toEqual([
      { name: 'acme-old', version: '1.0.0', sizeBytes: 1024 },
      { name: 'acme-older', version: '0.9.0', sizeBytes: 2048 },
    ]);
    expect(parsed.totalSizeBytes).toBe(3072);
  });

  test('string entries ("name version") are tolerated, with no size', () => {
    const parsed = parseCleanDryRun({ removed: ['acme-old 1.0.0'] });
    expect(parsed.removed).toEqual([{ name: 'acme-old', version: '1.0.0' }]);
    expect(parsed.totalSizeBytes).toBeUndefined();
  });

  test('unrecognized shape (no removed array) falls back to raw', () => {
    const input = { ok: true };
    expect(parseCleanDryRun(input)).toEqual({ removed: [], raw: input });
  });
});

// ---- formatBytes ----------------------------------------------------------------------------

describe('formatBytes', () => {
  test('bytes, KB, MB, GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  test('negative/non-finite input reads as "?"', () => {
    expect(formatBytes(-1)).toBe('?');
    expect(formatBytes(NaN)).toBe('?');
  });
});

// ---- lockfilePins — shaped after a real knowledge.lock (fictional package names) ---------

describe('lockfilePins — a real-shaped knowledge.lock', () => {
  test('no entries are pinned in this lockfile (none of its deps are), so this returns []', () => {
    expect(lockfilePins(fixtureText('knowledge.lock'))).toEqual([]);
  });

  test('a malformed lockfile degrades to [] rather than throwing', () => {
    expect(lockfilePins('this is not valid TOML {{{')).toEqual([]);
  });

  test('recognizes a "pinned = true" entry (the field name is a guess — see pure.ts\'s doc comment)', () => {
    const text = `
lockfile_version = 1

[[package]]
name = "acme-core"
version = "1.4.2"
source = "registry"
pinned = true

[[package]]
name = "acme-utils"
version = "2.0.0"
source = "registry"
`;
    expect(lockfilePins(text)).toEqual([{ name: 'acme-core', version: '1.4.2' }]);
  });
});

// ---- mergeDepsWithUpdates ---------------------------------------------------------------------

describe('mergeDepsWithUpdates', () => {
  const depRows = [
    { name: 'acme-security', version: '1.2.0' },
    { name: 'acme-org', version: undefined },
    { name: 'acme-general', version: '1.1.0' },
  ];

  test('joins update/error info onto every dep row by name; a dep with neither is untouched', () => {
    const parsed = parsePullDryRun({
      pulled: [{ package: 'acme-general', version: '1.2.0' }],
      already: ['acme-security 1.2.0'],
      failed: [{ package: 'acme-org', reason: 'registry error: no registry serves acme-org ^1 — looked in acme' }],
    });
    expect(mergeDepsWithUpdates(depRows, parsed)).toEqual([
      { name: 'acme-security', current: '1.2.0', available: undefined, citedChanges: undefined, error: undefined },
      {
        name: 'acme-org',
        current: undefined,
        available: undefined,
        citedChanges: undefined,
        error: 'registry error: no registry serves acme-org ^1 — looked in acme',
      },
      { name: 'acme-general', current: '1.1.0', available: '1.2.0', citedChanges: undefined, error: undefined },
    ]);
  });

  test('an update/error for a name not in depRows (a transitive dep) is simply not joined to anything', () => {
    const parsed = parsePullDryRun({ pulled: [{ package: 'not-a-direct-dep', version: '9.9.9' }] });
    const merged = mergeDepsWithUpdates(depRows, parsed);
    expect(merged.every((r) => r.available === undefined)).toBe(true);
  });
});
