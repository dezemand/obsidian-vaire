// Vairë explorer feature entry point (feat/type-tree). See BRANCHES.md.

import { TreeView, VIEW_TYPE_TREE } from './tree-view';
import type VairePlugin from '../main';

async function openTree(plugin: VairePlugin): Promise<void> {
  let leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TREE)[0];
  if (!leaf) {
    const leftLeaf = plugin.app.workspace.getLeftLeaf(false);
    if (!leftLeaf) return;
    leaf = leftLeaf;
    await leaf.setViewState({ type: VIEW_TYPE_TREE, active: true });
  }
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerTree(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_TREE, (leaf) => new TreeView(leaf, plugin));

  plugin.addCommand({
    id: 'open-tree',
    name: 'Open node explorer',
    callback: () => void openTree(plugin),
  });
}
