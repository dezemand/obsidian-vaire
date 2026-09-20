// Dependency graph feature entry point: view type registration + the "Open dependency view"
// command, mirroring the open-or-reveal-by-packageDir pattern `src/views/package-node.ts` uses
// for the package index. See DESIGN.md's dependency-graph feature brief.

import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { DepGraphView, VIEW_TYPE_DEPGRAPH } from './dep-view';

function activePackageOrFirst(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  const active = file ? plugin.packages.packageFor(file) : null;
  return active ?? plugin.packages.all()[0] ?? null;
}

/** Opens (or reveals, if already open for this package) the dependency view for `packageDir`.
 *  Exported so the package view's "Open graph" button (src/views/package-view.ts) can reuse it
 *  without duplicating the leaf-finding logic. */
export async function openDependencyView(plugin: VairePlugin, packageDir: string): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_DEPGRAPH).find((leaf) => {
    const state = leaf.getViewState().state as { packageDir?: string } | undefined;
    return state?.packageDir === packageDir;
  });
  const leaf = existing ?? plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE_DEPGRAPH, active: true, state: { packageDir } });
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerDepGraph(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_DEPGRAPH, (leaf) => new DepGraphView(leaf, plugin));

  plugin.addCommand({
    id: 'vaire-open-dependency-view',
    name: 'Open dependency view',
    checkCallback: (checking) => {
      const pkg = activePackageOrFirst(plugin);
      if (!pkg) return false;
      if (!checking) void openDependencyView(plugin, pkg.dir);
      return true;
    },
  });
}
