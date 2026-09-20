// Package index view + node panel registration: view types, commands, ribbon icon.
// See DESIGN.md "§6 Package view and node panel" and "Phase 2 ownership".

import { Notice } from 'obsidian';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { registerBacklinkContextCache } from './backlinks-data';
import { BacklinksView, VIEW_TYPE_BACKLINKS } from './backlinks-view';
import { NodeView, VIEW_TYPE_NODE } from './node-view';
import { PackageView, VIEW_TYPE_PACKAGE } from './package-view';
import { registerSearchPanel } from './search-register';

function activePackageOrFirst(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  const active = file ? plugin.packages.packageFor(file) : null;
  return active ?? plugin.packages.all()[0] ?? null;
}

/** Exported for `src/diagnostics/index.ts`'s status bar and "Open in package index" lint action. */
export async function openPackageIndex(plugin: VairePlugin, packageDir: string): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PACKAGE).find((leaf) => {
    const state = leaf.getViewState().state as { packageDir?: string } | undefined;
    return state?.packageDir === packageDir;
  });
  const leaf = existing ?? plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE_PACKAGE, active: true, state: { packageDir } });
  await plugin.app.workspace.revealLeaf(leaf);
}

async function openNodePanel(plugin: VairePlugin): Promise<void> {
  let leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_NODE)[0];
  if (!leaf) {
    const rightLeaf = plugin.app.workspace.getRightLeaf(false);
    if (!rightLeaf) return;
    leaf = rightLeaf;
    await leaf.setViewState({ type: VIEW_TYPE_NODE, active: true });
  }
  await plugin.app.workspace.revealLeaf(leaf);
}

async function openBacklinksView(plugin: VairePlugin): Promise<void> {
  let leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_BACKLINKS)[0];
  if (!leaf) {
    const rightLeaf = plugin.app.workspace.getRightLeaf(false);
    if (!rightLeaf) return;
    leaf = rightLeaf;
    await leaf.setViewState({ type: VIEW_TYPE_BACKLINKS, active: true });
  }
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerPackageAndNodeViews(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_PACKAGE, (leaf) => new PackageView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_NODE, (leaf) => new NodeView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_BACKLINKS, (leaf) => new BacklinksView(leaf, plugin));
  registerBacklinkContextCache(plugin);
  registerSearchPanel(plugin);

  plugin.addCommand({
    id: 'vaire-open-package-index',
    name: 'Open package index',
    checkCallback: (checking) => {
      const pkg = activePackageOrFirst(plugin);
      if (!pkg) return false;
      if (!checking) void openPackageIndex(plugin, pkg.dir);
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-open-node-panel',
    name: 'Open node panel',
    callback: () => void openNodePanel(plugin),
  });

  plugin.addCommand({
    id: 'vaire-open-backlinks',
    name: 'Open Vairë backlinks',
    callback: () => void openBacklinksView(plugin),
  });

  plugin.addRibbonIcon('package', 'Vairë: open package index', () => {
    const pkg = activePackageOrFirst(plugin);
    if (pkg) void openPackageIndex(plugin, pkg.dir);
    else new Notice('Vairë: no package found in this vault.');
  });
}
