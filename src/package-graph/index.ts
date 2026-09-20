// Whole-package graph feature entry point: view type registration + the "Open package graph"
// command. Mirrors src/graph/index.ts (local graph) and src/views/package-node.ts's
// open-or-reveal-a-leaf-per-package pattern (`openPackageIndex`).

import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { PackageGraphView, VIEW_TYPE_PACKAGE_GRAPH } from './view';

function activePackageOrFirst(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  const active = file ? plugin.packages.packageFor(file) : null;
  return active ?? plugin.packages.all()[0] ?? null;
}

/** Exported for the package view's "Graph" header button. One leaf per package: reuses an
 *  existing package-graph leaf already showing `packageDir` instead of opening a duplicate. */
export async function openPackageGraph(plugin: VairePlugin, packageDir: string): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PACKAGE_GRAPH).find((leaf) => {
    const state = leaf.getViewState().state as { packageDir?: string } | undefined;
    return state?.packageDir === packageDir;
  });
  const leaf = existing ?? plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE_PACKAGE_GRAPH, active: true, state: { packageDir } });
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerPackageGraph(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_PACKAGE_GRAPH, (leaf) => new PackageGraphView(leaf, plugin));

  plugin.addCommand({
    id: 'vaire-open-package-graph',
    name: 'Open package graph',
    checkCallback: (checking) => {
      const pkg = activePackageOrFirst(plugin);
      if (!pkg) return false;
      if (!checking) void openPackageGraph(plugin, pkg.dir);
      return true;
    },
  });
}

// Re-exported so other modules (e.g. a future health/status surface) don't need to know this
// lives under src/package-graph specifically.
export { VIEW_TYPE_PACKAGE_GRAPH };
