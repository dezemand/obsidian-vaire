import { describe, expect, test } from 'bun:test';
import { computeLineDiagnostics, findingsInRange, type FindingWithSeverity } from '../src/diagnostics/pure';

const RELPATH = 'archive/applications/5s-cleaning.md';

describe('computeLineDiagnostics', () => {
  test('drift: {kind, id, to, path, line} tagged as a warning', () => {
    const findings: FindingWithSeverity[] = [
      {
        kind: 'drift',
        id: 'application:5s-cleaning',
        to: 'record:2026-07-14-portainer-container-inventory',
        path: RELPATH,
        line: 19,
        severity: 'warning',
      },
    ];
    const result = computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH });
    expect(result).toEqual([
      {
        line: 19,
        severity: 'warning',
        message: 'drift: application:5s-cleaning → record:2026-07-14-portainer-container-inventory',
      },
    ]);
  });

  test('dangling_ref: {kind, from, to, path, line} tagged as a violation (error)', () => {
    const findings: FindingWithSeverity[] = [
      {
        kind: 'dangling_ref',
        from: 'application:5s-cleaning',
        to: 'record:nope',
        path: RELPATH,
        line: 7,
        severity: 'error',
      },
    ];
    const result = computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH });
    expect(result).toEqual([
      { line: 7, severity: 'error', message: 'dangling reference: application:5s-cleaning → record:nope' },
    ]);
  });

  test('orphan: {kind, id, path} has no line, so it cannot be placed and is skipped', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'orphan', id: 'concept:unused', path: RELPATH, severity: 'warning' },
    ];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('missing_dependency: {kind, package, note} has no path or line, so it is skipped', () => {
    const findings: FindingWithSeverity[] = [
      {
        kind: 'missing_dependency',
        package: 'acme-org',
        note: "dependency error: dependency 'acme-org' is not linked",
        severity: 'error',
      },
    ];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('a line beyond the current document length is skipped (stale check after edits)', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'drift', id: 'a', to: 'b', path: RELPATH, line: 999, severity: 'warning' },
    ];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('line 0 or negative is skipped (findings are 1-based)', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'drift', id: 'a', to: 'b', path: RELPATH, line: 0, severity: 'warning' },
      { kind: 'drift', id: 'a', to: 'b', path: RELPATH, line: -3, severity: 'warning' },
    ];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('a finding for another file in the same package is skipped', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'drift', id: 'a', to: 'b', path: 'other/file.md', line: 3, severity: 'warning' },
    ];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('findings without a path at all are skipped', () => {
    const findings: FindingWithSeverity[] = [{ kind: 'orphan', id: 'concept:unused', line: 3, severity: 'warning' }];
    expect(computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH })).toEqual([]);
  });

  test('mixed violations and warnings for the same file both come through, in order', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'dangling_ref', from: 'a', to: 'b', path: RELPATH, line: 5, severity: 'error' },
      { kind: 'drift', id: 'c', to: 'd', path: RELPATH, line: 10, severity: 'warning' },
      { kind: 'orphan', id: 'e', path: RELPATH, severity: 'warning' }, // dropped: no line
      { kind: 'drift', id: 'f', to: 'g', path: 'unrelated.md', line: 2, severity: 'warning' }, // dropped: other file
    ];
    const result = computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH });
    expect(result.map((d) => d.line)).toEqual([5, 10]);
    expect(result.map((d) => d.severity)).toEqual(['error', 'warning']);
  });

  test('an unknown finding kind falls back to describeFinding’s generic rendering', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'unused_dependency', package: 'acme-ppl', path: RELPATH, line: 1, severity: 'warning' },
    ];
    const result = computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('unused_dependency');
    expect(result[0].message).toContain('acme-ppl');
  });

  test('a line exactly at the last line of the document is in range', () => {
    const findings: FindingWithSeverity[] = [{ kind: 'drift', id: 'a', to: 'b', path: RELPATH, line: 40, severity: 'error' }];
    const result = computeLineDiagnostics({ lines: 40, findings, relPath: RELPATH });
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(40);
  });

  test('empty findings list produces no diagnostics', () => {
    expect(computeLineDiagnostics({ lines: 40, findings: [], relPath: RELPATH })).toEqual([]);
  });
});

describe('findingsInRange', () => {
  test('is index-aligned with computeLineDiagnostics for the same input (used to attach fix actions per diagnostic)', () => {
    const findings: FindingWithSeverity[] = [
      { kind: 'dangling_ref', from: 'a', to: 'b', path: RELPATH, line: 5, severity: 'error' },
      { kind: 'orphan', id: 'e', path: RELPATH, severity: 'warning' }, // dropped: no line
      { kind: 'drift', id: 'c', to: 'd', path: RELPATH, line: 10, severity: 'warning' },
      { kind: 'drift', id: 'f', to: 'g', path: 'unrelated.md', line: 2, severity: 'warning' }, // dropped: other file
    ];
    const input = { lines: 40, findings, relPath: RELPATH };
    const inRange = findingsInRange(input);
    const lineDiagnostics = computeLineDiagnostics(input);
    expect(inRange).toHaveLength(lineDiagnostics.length);
    expect(inRange.map((f) => f.line)).toEqual(lineDiagnostics.map((d) => d.line));
    expect(inRange.map((f) => f.kind)).toEqual(['dangling_ref', 'drift']);
  });

  test('empty when nothing is in range', () => {
    expect(findingsInRange({ lines: 40, findings: [], relPath: RELPATH })).toEqual([]);
  });
});
