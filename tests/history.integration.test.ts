// Runs the real `git` binary, read-only, against a real Vairë package (a real git repository —
// see DESIGN.md's "Test vault" note). Skipped entirely when `git` isn't on PATH, or when
// VAIRE_TEST_REPO isn't set (see README.md "Running the tests"), so `bun test` still passes
// with neither present. Never runs a mutating git command here.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect, test } from 'bun:test';
import { gitLog, gitStatus, isGitRepo } from '../src/history/git';

const REPO = process.env.VAIRE_TEST_REPO ?? '';
const FILE = 'concepts/loose-end.md';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = !!REPO && gitAvailable();

test.skipIf(!available)('isGitRepo is true for the vaire package', async () => {
  expect(await isGitRepo(REPO)).toBe(true);
});

test.skipIf(!available)('gitLog finds at least one commit for concepts/loose-end.md', async () => {
  const entries = await gitLog(REPO, FILE);
  expect(entries.length).toBeGreaterThanOrEqual(1);
  for (const entry of entries) {
    expect(typeof entry.hash).toBe('string');
    expect(entry.hash.length).toBeGreaterThan(0);
    expect(typeof entry.shortHash).toBe('string');
    expect(typeof entry.author).toBe('string');
    expect(typeof entry.subject).toBe('string');
    // Author date should parse as a real date (%aI, strict ISO 8601).
    expect(Number.isNaN(new Date(entry.date).getTime())).toBe(false);
  }
});

test.skipIf(!available)('gitStatus resolves without throwing for a committed, unmodified file', async () => {
  const status = await gitStatus(REPO, FILE);
  expect(status === null || typeof status === 'string').toBe(true);
});

test.skipIf(!available)('isGitRepo is false for a directory outside any git repository', async () => {
  expect(await isGitRepo(path.dirname(REPO))).toBe(false);
});
