// Template feature entry point (`feat/record-templates` — see BRANCHES.md and DESIGN.md-style
// conventions in ../authoring/index.ts). Registers the "New Vairë node from template…" command;
// the New-node modal's own "Use template…" button (../authoring/new-node-modal.ts) opens
// `TemplateModal` directly and does not go through this module, same convention as the loose-end
// "Create new node…" entry point noted in ../authoring/index.ts's doc comment.

import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { TemplateModal } from './template-modal';

/** The package "New node from template" targets: the active file's package, or the vault's
 *  sole package — same rule as `../authoring/index.ts`'s `targetPackage`. */
function targetPackage(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  const active = file ? plugin.packages.packageFor(file) : null;
  if (active) return active;
  const all = plugin.packages.all();
  return all.length === 1 ? all[0] : null;
}

export function registerTemplates(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'vaire-new-from-template',
    name: 'New Vairë node from template…',
    checkCallback: (checking) => {
      const pkg = targetPackage(plugin);
      if (!pkg) return false;
      if (!checking) new TemplateModal(plugin, pkg, {}).open();
      return true;
    },
  });
}

export { TemplateModal } from './template-modal';
