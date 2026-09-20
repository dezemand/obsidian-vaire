// Registers the persistent search panel view and its "Open search panel" command. Kept
// separate from package-node.ts (which just calls registerSearchPanel) so that file's own
// diff stays small — see DESIGN.md's search-panel feature spec. The existing "Vairë: search"
// modal command (src/suggest/search-modal.ts, registered by the suggestions pass) is
// unrelated and untouched by this.

import type VairePlugin from '../main';
import { SearchView, VIEW_TYPE_SEARCH } from './search-view';

async function openSearchPanel(plugin: VairePlugin): Promise<void> {
  let leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH)[0];
  if (!leaf) {
    const rightLeaf = plugin.app.workspace.getRightLeaf(false);
    if (!rightLeaf) return;
    leaf = rightLeaf;
    await leaf.setViewState({ type: VIEW_TYPE_SEARCH, active: true });
  }
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerSearchPanel(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_SEARCH, (leaf) => new SearchView(leaf, plugin));

  plugin.addCommand({
    id: 'open-search-panel',
    name: 'Open search panel',
    callback: () => void openSearchPanel(plugin),
  });
}
