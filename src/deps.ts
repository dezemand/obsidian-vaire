// Dependency tree flattening and state classification. See DESIGN.md §3 "Dependencies".

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DepNode, DepsResult } from './types';
import type { VaireCli } from './cli';
import type { PackageInfo } from './packages';

export interface DepRow {
  name: string;
  constraint: string;
  version?: string;
  /** As reported by the CLI, relative to the root package's dir. */
  resolved?: string;
  /** `resolved` joined onto the root package's absolute path and normalized. */
  absRoot?: string;
  satisfied: boolean;
  note?: string;
  depth: number;
  parent: string;
}

/**
 * Flattens the `deps` tree (depth-first) into rows. `resolved` paths in the tree are all
 * relative to the same root — the package `cli.deps` was run against — regardless of depth,
 * so every row's `absRoot` is joined onto that one `absRoot`, not onto its parent's.
 */
export function flattenDeps(result: DepsResult, absRoot: string): DepRow[] {
  const rows: DepRow[] = [];

  function walk(nodes: DepNode[] | undefined, parent: string, depth: number): void {
    if (!nodes) return;
    for (const node of nodes) {
      rows.push({
        name: node.name,
        constraint: node.constraint,
        version: node.version,
        resolved: node.resolved,
        absRoot: node.resolved ? path.normalize(path.join(absRoot, node.resolved)) : undefined,
        satisfied: node.satisfied ?? false,
        note: node.note,
        depth,
        parent,
      });
      walk(node.dependencies, node.name, depth + 1);
    }
  }

  walk(result.dependencies, result.name, 1);
  return rows;
}

export type DepState = 'ok' | 'unlinked' | 'mismatch' | 'error';

/**
 * Classifies one flattened dependency row. Pure (no `this`/fs access) so it can be reused
 * outside a `DepsModel` instance — see `src/health/pure.ts`, which derives "unsatisfied /
 * unlinked dependency" health issues from the same rows without needing a full model.
 */
export function depRowState(row: DepRow): DepState {
  if (row.satisfied) return 'ok';
  if (row.note?.includes('not linked')) return 'unlinked';
  if (row.version) return 'mismatch';
  return 'error';
}

export class DepsModel {
  readonly pkg: PackageInfo;
  readonly rows: DepRow[];

  private constructor(pkg: PackageInfo, rows: DepRow[]) {
    this.pkg = pkg;
    this.rows = rows;
  }

  static async load(cli: VaireCli, pkg: PackageInfo): Promise<DepsModel> {
    const result = await cli.deps(pkg.absRoot);
    return new DepsModel(pkg, flattenDeps(result, pkg.absRoot));
  }

  /**
   * The dependency root for `name`, in order: the realpath of the `.vaire/packages/<name>`
   * link if it exists, else the first row for `name` with a resolved `absRoot`, else `null`
   * (callers fall back to a catalog sighting via `cli.catalogList()`).
   */
  rootOf(name: string): string | null {
    const linked = path.join(this.pkg.absRoot, '.vaire', 'packages', name);
    try {
      if (fs.existsSync(linked)) return fs.realpathSync(linked);
    } catch {
      // fall through to the deps-tree fallback
    }
    const row = this.rows.find((r) => r.name === name && r.absRoot);
    return row?.absRoot ?? null;
  }

  state(row: DepRow): DepState {
    return depRowState(row);
  }
}
