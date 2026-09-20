// Checks `fingerprint()` (src/cache/fingerprint.ts) against a real package's `.vaire/index.db`
// instead of a synthetic file, the same "skip if the fixture isn't there" pattern as
// tests/cli.integration.test.ts — except this one needs no `vaire` binary, just the built
// index that a `vaire index` run leaves on disk, so it's skipped unless VAIRE_TEST_REPO is set
// (see README.md "Running the tests") and points at an already-indexed package.

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from 'bun:test';
import { fingerprint } from '../src/cache/fingerprint';

const REPO = process.env.VAIRE_TEST_REPO ?? '';
const INDEX_DB = REPO ? path.join(REPO, '.vaire', 'index.db') : '';
const available = !!REPO && existsSync(INDEX_DB);

test.skipIf(!available)('fingerprint() is stable across two reads of the same index', () => {
  const first = fingerprint(REPO);
  const second = fingerprint(REPO);
  expect(first).not.toBeNull();
  expect(first).toBe(second);
  // `mtime:size`, both numeric-looking, joined by a colon.
  expect(first).toMatch(/^\d+(\.\d+)?:\d+$/);
});

test.skipIf(!available)('fingerprint() differs from an unrelated/nonexistent root', () => {
  expect(fingerprint(REPO)).not.toBe(fingerprint('/no/such/vaire/package/root'));
});

test('fingerprint() of a root with no .vaire/index.db is null', () => {
  expect(fingerprint('/definitely/not/a/real/path/xyz')).toBeNull();
});
