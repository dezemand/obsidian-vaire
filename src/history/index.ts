// History feature entry point (BRANCHES.md `feat/node-history`): registers the "Show node
// history" command. The section renderer itself (src/history/section.ts) is called directly
// from node-view.ts, per DESIGN.md's "Phase 2 ownership" pattern — this file only owns the
// command that opens the node panel and scrolls to it.

import type VairePlugin from '../main';
import { VIEW_TYPE_NODE } from '../views/node-view';

const SCROLL_DELAY_MS = 50;

/** Reveals the node panel (opening it in the right sidebar first if it isn't already), then
 *  scrolls its History section into view. Mirrors `openNodePanel` in src/views/package-node.ts —
 *  duplicated rather than imported so this feature's registration stays self-contained in
 *  src/history/, per DESIGN.md's ownership split. */
async function openNodeHistory(plugin: VairePlugin): Promise<void> {
  let leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_NODE)[0];
  if (!leaf) {
    const rightLeaf = plugin.app.workspace.getRightLeaf(false);
    if (!rightLeaf) return;
    leaf = rightLeaf;
    await leaf.setViewState({ type: VIEW_TYPE_NODE, active: true });
  }
  await plugin.app.workspace.revealLeaf(leaf);

  // The node panel's own `render()` runs synchronously off `file-open`/`active-leaf-change`, so
  // `.vaire-history` is normally already in the DOM by the time `revealLeaf` resolves — but a
  // freshly created leaf/view can still be settling its layout, so give it one tick before
  // scrolling rather than racing it.
  window.setTimeout(() => {
    const el = leaf.view.containerEl.querySelector('.vaire-history');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, SCROLL_DELAY_MS);
}

export function registerHistory(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'vaire-open-node-history',
    name: 'Show node history',
    callback: () => void openNodeHistory(plugin),
  });
}
