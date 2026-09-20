// Pure helpers for the package view's Release section: version comparison (for sorting the
// changelog), turning a `vaire release [--dry-run]` plan into renderable text, and the
// summary-writing hints shown beside the Cut-release textarea. No `obsidian` import, so these
// stay unit-testable with plain `bun test` — see tests/release.test.ts. Mirrors the pattern of
// src/views/pure-pkg.ts and src/deps.ts: the UI in section.ts/release-modal.ts is a thin,
// untested shell around these functions.
//
// Sources: vaire/spec/registry.md §3.1 (the bump table), vaire/spec/cli.md §4.7 (`vaire
// release` JSON shape and `status`/`outcome` semantics), and the vaire-versioning /
// vaire-release-summary skills (what a release means and what a summary should say).

import type { ReleasePlan } from '../types';

/**
 * Parses "MAJOR.MINOR.PATCH" (a leading "v" is tolerated, as in a git tag). Vairë versions
 * never carry pre-release/build metadata (see vaire-versioning: "Don't use pre-releases or
 * build metadata"), so a plain three-part split is enough; a missing or non-numeric
 * component reads as 0 rather than throwing, so a malformed string just sorts low.
 */
function parseVersion(version: string): [number, number, number] {
  const cleaned = version.trim().replace(/^v/i, '');
  const parts = cleaned.split('.');
  const at = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [at(0), at(1), at(2)];
}

/**
 * Pure semver-ish compare for sorting a changelog: negative when `a` < `b`, positive when
 * `a` > `b`, `0` when equal. Sort descending (newest first) with `(a, b) => compareVersions(b,
 * a)` or by reversing the arguments.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export interface PlanCounts {
  added: number;
  changed: number;
  retired: number;
  removed: number;
}

/** Length of each of the plan's four id lists, tolerant of a missing/malformed field. */
export function countsOf(plan: ReleasePlan): PlanCounts {
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return {
    added: len(plan.added),
    changed: len(plan.changed),
    retired: len(plan.retired),
    removed: len(plan.removed),
  };
}

export interface DescribedPlan {
  title: string;
  lines: string[];
}

/**
 * Turns a `vaire release --dry-run` (or a completed `vaire release`) JSON payload into a
 * renderable `{title, lines}`. Per registry.md §3.1 / cli.md §4.7:
 * - `status: "nothing"` (or `outcome.kind === "nothing"`) — a clean no-op, nothing changed.
 * - `status: "blocked"` — the classifier saw entities removed/retired (a MAJOR) and refuses
 *   without an explicit `--major`; MAJOR is *never* taken automatically.
 * - otherwise — the computed (or, for a completed release, the actual) version and bump,
 *   plus the four list counts.
 */
export function describePlan(plan: ReleasePlan): DescribedPlan {
  const version = typeof plan.version === 'string' && plan.version ? plan.version : '?';
  const outcomeKind = plan.outcome?.kind;

  if (plan.status === 'nothing' || outcomeKind === 'nothing') {
    return { title: 'Nothing to release', lines: [`No entities have changed since v${version}.`] };
  }

  if (plan.status === 'blocked') {
    const lines = [
      'The classifier saw entities removed or retired — a MAJOR change. MAJOR is never taken automatically.',
      'Check "This is a MAJOR release" to acknowledge --major and see the real plan.',
    ];
    if (plan.notes_required) {
      lines.push(
        'A MAJOR also needs invalidated-assumptions notes (--notes <file>), which this UI does not collect — run `vaire release --major --notes <file>` from a terminal instead.',
      );
    }
    return { title: 'MAJOR release blocked', lines };
  }

  const bump = typeof plan.bump === 'string' ? plan.bump : outcomeKind === 'bump' ? plan.outcome?.bump : undefined;
  const bumpLabel = bump ? bump.toUpperCase() : outcomeKind === 'initial' ? 'INITIAL' : undefined;
  const verb = plan.status === 'released' ? 'Released' : 'Would release';
  const title = `${verb} v${version}${bumpLabel ? ` · ${bumpLabel}` : ''}`;

  const c = countsOf(plan);
  const lines = [`+${c.added} added · ~${c.changed} changed · ↓${c.retired} retired · −${c.removed} removed`];
  if (plan.notes_required) {
    lines.push('This MAJOR still needs invalidated-assumptions notes (--notes) before it can actually be cut.');
  }
  return { title, lines };
}

/** Length of a frontmatter edge list (a release record's `added`/`changed`/`retired`),
 * tolerant of it being absent entirely (an empty list is often omitted from frontmatter). */
export function frontmatterEdgeCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Three short reminders shown beside the Cut-release summary textarea, distilled from the
 * vaire-release-summary skill: lead with consequence, cite only addresses that resolve, never
 * invent what a diff doesn't support.
 */
export function summaryHints(): string[] {
  return [
    'Lead with consequence, not inventory — the record already lists every address; say what changed for a reader, not which ids changed.',
    'Reference entities as [[type:id]] so the summary becomes real graph edges — only addresses that resolve; name a removed entity in `code`, never as a link.',
    'Say what a consumer should do, if anything — and never invent a reason a diff does not support. A thin, honest summary beats a confident wrong one.',
  ];
}
