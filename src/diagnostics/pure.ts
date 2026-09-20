// Pure finding -> per-line diagnostic mapping for the inline-editor check feature (see
// DESIGN.md "Wave 1" / `feat/check-diagnostics` and "CLI contract nuances" for the finding
// shapes). No `obsidian`/CodeMirror imports here — `describeFinding` (src/views/pure-pkg.ts)
// is itself import-free, so this module stays plain-`bun test`-able.

import { describeFinding, type FindingLike } from '../views/pure-pkg';

export type DiagnosticSeverity = 'error' | 'warning';

/** A `check` finding tagged with the severity it should render as (violation -> error, warning -> warning). */
export interface FindingWithSeverity extends FindingLike {
  severity: DiagnosticSeverity;
}

export interface LineDiagnostic {
  /** 1-based line number, matching `Finding.line`. */
  line: number;
  severity: DiagnosticSeverity;
  message: string;
}

export interface ComputeLineDiagnosticsInput {
  /** Number of lines in the current document (`EditorState.doc.lines`). */
  lines: number;
  findings: FindingWithSeverity[];
  /** Package-relative path of the file the diagnostics are being computed for. */
  relPath: string;
}

/**
 * `findings` narrowed to the ones that belong on `relPath` at an in-range line — the shared
 * filter behind `computeLineDiagnostics` below, exposed separately so `src/diagnostics/
 * fixes.ts` can build one CodeMirror `Diagnostic` **action list** per finding without
 * re-deriving this filter. Calling this and `computeLineDiagnostics` with the same `input`
 * yields index-aligned arrays (same filter, same source order), which is what lets the caller
 * zip a `LineDiagnostic` back to the `FindingWithSeverity` it came from.
 *
 * A finding with no `path` (e.g. `missing_dependency`) or no numeric `line` (e.g. `orphan` —
 * `{kind, id, path}`; `frontmatter_wikilink`/`unknown_type` — no `line` either, see
 * `src/diagnostics/fixes-pure.ts`) cannot be placed on a specific line, so it is dropped here;
 * it still surfaces via the status bar count and the package/node views (and, for those two
 * no-`line` kinds, a fix action can still locate its own line — see
 * `locateFrontmatterFieldLine`). A `line` outside `[1, lines]` (stale check results after the
 * document shrank) is dropped too.
 */
export function findingsInRange(input: ComputeLineDiagnosticsInput): FindingWithSeverity[] {
  const { lines, findings, relPath } = input;
  return findings.filter((finding) => {
    if (finding.path !== relPath) return false;
    const line = finding.line;
    if (typeof line !== 'number' || !Number.isInteger(line)) return false;
    return line >= 1 && line <= lines;
  });
}

/**
 * Turns each in-range finding (see `findingsInRange`) into a `{line, severity, message}` ready
 * to become a CodeMirror `Diagnostic` (the impure caller in `src/diagnostics/index.ts` supplies
 * `from`/`to`/`actions`).
 */
export function computeLineDiagnostics(input: ComputeLineDiagnosticsInput): LineDiagnostic[] {
  return findingsInRange(input).map((finding) => {
    const described = describeFinding(finding);
    const message = described.detail ? `${described.title}: ${described.detail}` : described.title;
    return { line: finding.line as number, severity: finding.severity, message };
  });
}
