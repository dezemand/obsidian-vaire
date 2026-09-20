// Runs the real `vaire` binary, read-only, against a real Vairë package. Skipped entirely when
// the binary isn't on PATH (or at the usual fallback locations), or when VAIRE_TEST_REPO isn't
// set (see README.md "Running the tests"), so `bun test` still passes with neither present.
//
// Never runs `index`, `add`, `pull`, or any catalog/registry mutation here — this suite
// must not change anything on disk or in the CLI's index/catalog/registry state.

import { expect, test } from 'bun:test';
import { VaireCli } from '../src/cli';

const REPO = process.env.VAIRE_TEST_REPO ?? '';

const cli = new VaireCli(() => ({ binaryPath: '' }));
const available = !!REPO && (await cli.available());

test.skipIf(!available)('status', async () => {
  const result = await cli.status(REPO);
  expect(result.repo).toBe(REPO);
  expect(typeof result.nodes.total).toBe('number');
  expect(result.nodes.total).toBeGreaterThan(0);
  expect(typeof result.edges).toBe('number');
  expect(typeof result.nodes.by_type).toBe('object');
});

test.skipIf(!available)('resolve concept:reference', async () => {
  const result = await cli.resolve(REPO, 'concept:reference');
  expect(result.id).toBe('concept:reference');
  expect(result.type).toBe('concept');
  expect(typeof result.path).toBe('string');
  expect(result.frontmatter).toBeTruthy();
  expect(result.superseded_by === null || typeof result.superseded_by === 'string').toBe(true);
});

test.skipIf(!available)('suggest "loose end"', async () => {
  const result = await cli.suggest(REPO, 'loose end');
  expect(result.descriptor).toBe('loose end');
  expect(Array.isArray(result.suggestions)).toBe(true);
  expect(result.suggestions.length).toBeGreaterThan(0);
  expect(typeof result.count).toBe('number');
  for (const s of result.suggestions) {
    expect(typeof s.id).toBe('string');
    expect(typeof s.type).toBe('string');
    expect(typeof s.name).toBe('string');
    expect(typeof s.score).toBe('number');
  }
});

test.skipIf(!available)('search "reference graph"', async () => {
  const result = await cli.search(REPO, 'reference graph');
  expect(result.query).toBe('reference graph');
  expect(Array.isArray(result.results)).toBe(true);
  expect(result.results.length).toBeGreaterThan(0);
  for (const hit of result.results) {
    expect(typeof hit.id).toBe('string');
    expect(typeof hit.type).toBe('string');
    expect(typeof hit.score).toBe('number');
    expect(Array.isArray(hit.anchors)).toBe(true);
  }
});

test.skipIf(!available)('deps', async () => {
  const result = await cli.deps(REPO);
  expect(result.name).toBe('vaire');
  expect(Array.isArray(result.dependencies)).toBe(true);
});
