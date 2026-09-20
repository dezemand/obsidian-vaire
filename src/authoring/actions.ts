// Shared authoring flows — prompt/modal + `processFrontMatter` — used by both the node panel's
// icon buttons (src/views/node-view.ts) and the standalone commands (src/authoring/index.ts),
// so each flow has exactly one implementation. See DESIGN.md and the vaire-contributing skill:
// both flows are additive-only, and `updated` is only bumped when the edit actually changed
// something and the `bumpUpdatedOnEdit` setting is on.

import { Notice } from 'obsidian';
import { promptText } from '../ui/prompt-modal';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { addAlias, addEdge, todayIso } from './frontmatter-edit';
import { EdgeModal } from './edge-modal';

/** Prompts for an alias and appends it to `node`'s frontmatter, deduped case-insensitively. */
export async function addAliasToNode(plugin: VairePlugin, node: LocalNode): Promise<void> {
  const alias = await promptText(plugin.app, {
    title: 'Add alias',
    placeholder: 'alternate name people use for this node',
    submitLabel: 'Add alias',
  });
  if (alias === null) return;
  const trimmed = alias.trim();
  if (!trimmed) return;

  let changed = false;
  await plugin.app.fileManager.processFrontMatter(node.file, (fm: Record<string, unknown>) => {
    changed = addAlias(fm, trimmed).changed;
    if (changed && plugin.settings.bumpUpdatedOnEdit) fm.updated = todayIso();
  });
  new Notice(changed ? `Vairë: added alias "${trimmed}"` : 'Vairë: that alias is already there');
}

/** Opens the Add Edge modal for `node` and applies whatever it submits. */
export function addEdgeToNode(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): void {
  new EdgeModal(plugin, pkg, node.type, (key, value) => {
    void applyEdge(plugin, node, key, value);
  }).open();
}

async function applyEdge(plugin: VairePlugin, node: LocalNode, key: string, value: string): Promise<void> {
  let changed = false;
  await plugin.app.fileManager.processFrontMatter(node.file, (fm: Record<string, unknown>) => {
    changed = addEdge(fm, key, value).changed;
    if (changed && plugin.settings.bumpUpdatedOnEdit) fm.updated = todayIso();
  });
  new Notice(changed ? `Vairë: added edge "${key}"` : 'Vairë: nothing changed — that edge already had that value');
}
