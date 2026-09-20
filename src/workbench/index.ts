// Loose-end workbench feature entry point: registers the view type and the
// "Open loose-end workbench" command. The package view links into this (see
// `renderUnresolved`'s header button in src/views/package-view.ts) instead of duplicating the
// open/reveal logic.

import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { VIEW_TYPE_WORKBENCH, WorkbenchView } from './workbench-view';

function activePackageOrFirst(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  const active = file ? plugin.packages.packageFor(file) : null;
  return active ?? plugin.packages.all()[0] ?? null;
}

/** Opens (or reveals an already-open) workbench leaf for `packageDir`, mirroring
 *  `openPackageIndex` in src/views/package-node.ts. */
export async function openUnresolvedWorkbench(plugin: VairePlugin, packageDir: string): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH).find((leaf) => {
    const state = leaf.getViewState().state as { packageDir?: string } | undefined;
    return state?.packageDir === packageDir;
  });
  const leaf = existing ?? plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true, state: { packageDir } });
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerWorkbench(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_WORKBENCH, (leaf) => new WorkbenchView(leaf, plugin));

  plugin.addCommand({
    id: 'vaire-open-unresolved-workbench',
    name: 'Open loose-end workbench',
    checkCallback: (checking) => {
      const pkg = activePackageOrFirst(plugin);
      if (!pkg) return false;
      if (!checking) void openUnresolvedWorkbench(plugin, pkg.dir);
      return true;
    },
  });
}
