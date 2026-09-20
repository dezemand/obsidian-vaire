// Pure package-health assessment. See DESIGN.md "JSON shapes" (`status`, `deps`) and the
// package-health feature note. No `obsidian` import (and no fs access of its own — the one
// `node:fs` touch in this file tree lives in `deps.ts`'s `DepsModel.rootOf`, which this module
// does not call) so it stays unit-testable with plain `bun test`, independent of a vault.

import { flattenDeps, depRowState } from '../deps';
import type { DepsResult, StatusResult, Sighting } from '../types';

export type HealthSeverity = 'error' | 'warning' | 'info';

/**
 * What kind of fix (if any) the package view should offer for an issue. `'link_or_pull'`
 * issues carry `depName` so the action can call `linkFromCatalog`/`pullDependency` (both in
 * `src/views/deps-actions.ts`) for that specific dependency. `'open_index'` issues have no
 * fix the plugin can perform itself; the caller offers a way to go look (e.g. the health-check
 * Notice's "Open package index" link — see `src/health/index.ts`).
 */
export type HealthActionKind = 'rebuild_index' | 'link_or_pull' | 'open_index';

export interface HealthIssue {
  /** `'updates_available'` is never produced by `assessHealth` below — it comes from
   *  `src/updates/pure.ts`'s `updatesHealthIssue`, appended by `renderHealthStrip` (src/health/
   *  index.ts) when `VaireSettings.updateCheck === 'on-open'`. Declared here anyway so this
   *  module stays the one place `HealthIssue`'s shape is defined. */
  kind: 'index_not_built' | 'index_stale' | 'dependency' | 'pending_release' | 'embeddings_stale' | 'updates_available';
  severity: HealthSeverity;
  message: string;
  action: HealthActionKind;
  /** Set only for `kind: 'dependency'` issues — the unsatisfied dependency's name. */
  depName?: string;
}

/** The bits of a `VaireError` (src/cli.ts) that matter here — kept structural so this module
 *  doesn't need to import `cli.ts` (and its `node:child_process`/`node:fs` imports) just for a
 *  type. */
export interface StatusErrorLike {
  kind: string;
  message: string;
}

export interface HealthInput {
  /** `cli.status(pkg.absRoot)` result, when the call succeeded. */
  status?: StatusResult;
  /** `cli.deps(pkg.absRoot)` result, when the call succeeded. */
  deps?: DepsResult;
  /** The error `cli.status` threw, if it did (both `status` and `statusError` absent/undefined
   *  simply means "not checked yet" — no issue is derived from that alone). */
  statusError?: StatusErrorLike | null;
}

/**
 * Derives health issues for one package from independently-fetched `status`/`deps` results
 * (or their absence/errors — both calls are expected to have been made with errors tolerated,
 * per DESIGN.md's package-health feature note). Pure and total: never throws.
 *
 * - **Index not built**: `statusError.kind === 'index_not_built'`, or a successful `status`
 *   response with `schema_version: null` (the shape `status` itself returns for an unbuilt
 *   index — see DESIGN.md "CLI contract nuances"). When this fires, the other `status`-derived
 *   checks (stale index, pending release, embeddings) are skipped — they're meaningless
 *   against a status response that has nothing else built yet.
 * - **Index stale**: `commits_behind_head > 0`.
 * - **Pending release**: `pending_release.would_be !== 'none'` — informational.
 * - **Embeddings not cached**: `embeddings.cached < embeddings.sections`.
 * - **Dependency issues**: one issue per *directly declared* (depth 1) flattened `deps` row
 *   whose state (`depRowState`, src/deps.ts) isn't `'ok'` — deeper (transitive) rows are
 *   skipped because the fix actions (`vaire add`/`vaire pull`) only apply to a package's own
 *   declared dependencies, the same restriction the package view's dependency table already
 *   applies (see `renderDepActions` in `src/views/package-view.ts`).
 */
export function assessHealth(input: HealthInput): HealthIssue[] {
  const issues: HealthIssue[] = [];

  const indexNotBuilt =
    input.statusError?.kind === 'index_not_built' || (input.status != null && input.status.schema_version == null);

  if (indexNotBuilt) {
    issues.push({
      kind: 'index_not_built',
      severity: 'error',
      message: 'Index has not been built yet.',
      action: 'rebuild_index',
    });
  } else if (input.status) {
    const status = input.status;

    if (status.commits_behind_head > 0) {
      issues.push({
        kind: 'index_stale',
        severity: 'warning',
        message: `Index is ${status.commits_behind_head} commit(s) behind HEAD.`,
        action: 'rebuild_index',
      });
    }

    if (status.pending_release && status.pending_release.would_be !== 'none') {
      const pr = status.pending_release;
      issues.push({
        kind: 'pending_release',
        severity: 'info',
        message: `Pending ${pr.would_be} release since ${pr.since} (+${pr.added} ~${pr.changed} -${pr.retired} ×${pr.removed}).`,
        action: 'open_index',
      });
    }

    if (status.embeddings && status.embeddings.cached < status.embeddings.sections) {
      issues.push({
        kind: 'embeddings_stale',
        severity: 'info',
        message: `Embeddings not fully cached (${status.embeddings.cached}/${status.embeddings.sections}).`,
        action: 'open_index',
      });
    }
  }

  if (input.deps) {
    // The absolute root passed to `flattenDeps` only affects each row's `absRoot` field, which
    // `depRowState` never reads — an empty string is fine for classification purposes here.
    const rows = flattenDeps(input.deps, '');
    for (const row of rows) {
      if (row.depth !== 1) continue;
      const state = depRowState(row);
      if (state === 'ok') continue;
      issues.push({
        kind: 'dependency',
        severity: state === 'unlinked' ? 'warning' : 'error',
        message: `Dependency '${row.name}' is ${state}${row.note ? ` — ${row.note}` : ''}`,
        action: 'link_or_pull',
        depName: row.name,
      });
    }
  }

  return issues;
}

/**
 * Vault package absolute roots that have no `cli.catalogList()` sighting at that exact path
 * (regardless of the sighting's `state` — a `missing` sighting still means the catalog already
 * knows about that path and it's not this feature's job to re-add it). Drives catalog
 * auto-registration (`cli.catalogAdd`) — see `src/health/index.ts`.
 */
export function missingFromCatalog(vaultRoots: string[], sightings: Sighting[]): string[] {
  const known = new Set(sightings.map((s) => s.path));
  return vaultRoots.filter((root) => !known.has(root));
}
