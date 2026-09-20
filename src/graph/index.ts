// Local graph feature entry point: view type registration + the "Open local graph" command.
// See DESIGN.md's "Local graph" feature brief and src/views/package-node.ts for the
// open-or-reveal pattern this mirrors.

import type VairePlugin from '../main';
import { exportLocalGraphToCanvas } from './export';
import { GraphView, VIEW_TYPE_GRAPH } from './graph-view';

async function openLocalGraph(plugin: VairePlugin): Promise<void> {
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH)[0];
  const leaf = existing ?? plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE_GRAPH, active: true });
  await plugin.app.workspace.revealLeaf(leaf);
}

export function registerGraph(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_GRAPH, (leaf) => new GraphView(leaf, plugin));

  // Unconditionally available, like "Open node panel" — the view itself renders "No file
  // open." / "Not a Vairë node." states rather than hiding the command from the palette.
  plugin.addCommand({
    id: 'open-local-graph',
    name: 'Open local graph',
    callback: () => void openLocalGraph(plugin),
  });

  // Unconditionally available too — `exportLocalGraphToCanvas` shows a Notice for "no active
  // file" / "not a Vairë node" itself, same reasoning as "Open local graph" above.
  plugin.addCommand({
    id: 'export-canvas',
    name: 'Export local graph to canvas',
    callback: () => void exportLocalGraphToCanvas(plugin),
  });
}
