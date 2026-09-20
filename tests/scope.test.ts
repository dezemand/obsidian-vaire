import { describe, expect, test } from 'bun:test';
import { parseRef, scopeFirstCandidates, type IdRef } from '../src/ids';

// `src/packages.ts` can't be imported here — it pulls in `obsidian`, which (per the other
// test files in this repo) has no runtime module to resolve under `bun test`, only type
// declarations. So these tests exercise `scopeFirstCandidates` directly (the one place the
// scope-first-then-global order is decided, per its doc comment in src/ids.ts) and then
// replay `resolveLocalRef`'s own logic (src/packages.ts) against a fake `Map`-backed index,
// to prove the two-step rule actually resolves the way the published renderer's
// `resolve_address` does (renderer-conventions.md §2).

/** Mirrors `resolveLocalRef` (src/packages.ts) against a plain `Map<id, T>` "index". */
function resolveWithFakeIndex<T>(index: Map<string, T>, ref: IdRef, originScope?: string): T | null {
  for (const candidate of scopeFirstCandidates(ref, originScope)) {
    const hit = index.get(candidate);
    if (hit) return hit;
  }
  return null;
}

describe('scopeFirstCandidates', () => {
  test('bare ref inside a scoped node: scope-first, then global', () => {
    const ref = parseRef('record:kickoff') as IdRef;
    expect(scopeFirstCandidates(ref, 'project:atlas')).toEqual([
      'project:atlas/record:kickoff',
      'record:kickoff',
    ]);
  });

  test('no originScope: only the global candidate', () => {
    const ref = parseRef('record:kickoff') as IdRef;
    expect(scopeFirstCandidates(ref, undefined)).toEqual(['record:kickoff']);
  });

  test('a ref that already names its own scope is not further scope-widened', () => {
    const ref = parseRef('project:other/record:kickoff') as IdRef;
    expect(scopeFirstCandidates(ref, 'project:atlas')).toEqual(['project:other/record:kickoff']);
  });

  test('an @pkg/ ref widens the same way — the candidate list is package-agnostic', () => {
    const ref = parseRef('@acme-security/standard:coding-style') as IdRef;
    expect(scopeFirstCandidates(ref, 'project:atlas')).toEqual([
      'project:atlas/standard:coding-style',
      'standard:coding-style',
    ]);
  });
});

describe('resolveLocalRef behavior (replayed against a fake index map)', () => {
  test('a scoped hit wins over an identically-named global node', () => {
    const index = new Map<string, string>([
      ['project:atlas/record:kickoff', 'the scoped kickoff record'],
      ['record:kickoff', 'an unrelated global kickoff record'],
    ]);
    const ref = parseRef('record:kickoff') as IdRef;
    expect(resolveWithFakeIndex(index, ref, 'project:atlas')).toBe('the scoped kickoff record');
  });

  test('falls back to the global node when no scoped node exists', () => {
    const index = new Map<string, string>([['record:kickoff', 'the only kickoff record']]);
    const ref = parseRef('record:kickoff') as IdRef;
    expect(resolveWithFakeIndex(index, ref, 'project:atlas')).toBe('the only kickoff record');
  });

  test('null when neither the scoped nor the global candidate exists', () => {
    const index = new Map<string, string>();
    const ref = parseRef('record:kickoff') as IdRef;
    expect(resolveWithFakeIndex(index, ref, 'project:atlas')).toBeNull();
  });

  test('an unscoped node (no originScope) resolves globally, same as before this feature', () => {
    const index = new Map<string, string>([['record:kickoff', 'the only kickoff record']]);
    const ref = parseRef('record:kickoff') as IdRef;
    expect(resolveWithFakeIndex(index, ref, undefined)).toBe('the only kickoff record');
  });

  test('an explicit container-id/type:local ref only ever tries its own address', () => {
    const index = new Map<string, string>([
      ['project:atlas/record:kickoff', 'atlas kickoff'],
      ['project:other/record:kickoff', 'other kickoff'],
    ]);
    const ref = parseRef('project:other/record:kickoff') as IdRef;
    // Written from inside a *different* scope (`project:atlas`) — must not be redirected there.
    expect(resolveWithFakeIndex(index, ref, 'project:atlas')).toBe('other kickoff');
  });
});
