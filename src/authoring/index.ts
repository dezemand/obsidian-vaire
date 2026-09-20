// Authoring feature entry point: maintainer/contributor actions that write to the corpus
// rather than just read it. Two independent registration functions, both called from
// `main.ts`:
//  - `registerAuthoring`: every command that doesn't tombstone a node —
//      "New Vairë node" and "Create entity from loose end at cursor" (new-node-modal.ts /
//      pure.ts; the "Create new node…" item inside `VaireResolveModal`
//      (src/suggest/resolve-modal.ts) opens `NewNodeModal` directly and does not go through
//      this module — it's wired where the modal already has the loose end's location);
//      "Add alias to this node" / "Add edge to this node" (actions.ts, also called directly
//      by the node panel's own "Add alias"/"Add edge" buttons — src/views/node-view.ts — so
//      there is exactly one implementation of each); "Insert loose end" (type-picker-
//      modal.ts); and "Rename node id…" (rename-modal.ts / rename-pure.ts — also reachable
//      from the node panel's "Rename id…" button).
//  - `registerSupersede`: "Supersede this node with…", the tombstone workflow (supersede-
//    modal.ts / supersede-pure.ts).

import { parseRef } from '../ids';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { applyResolution } from '../suggest';
import { findLooseEndAt, looseEndTypeInsertText } from '../suggest/pure';
import { addAliasToNode, addEdgeToNode } from './actions';
import { NewNodeModal } from './new-node-modal';
import { startRename } from './rename-modal';
import { startSupersede } from './supersede-modal';
import { TypePickerModal } from './type-picker-modal';

function activePackage(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  return file ? plugin.packages.packageFor(file) : null;
}

/** The package "New node" targets: the active file's package, or the vault's sole package. */
function targetPackage(plugin: VairePlugin): PackageInfo | null {
  const active = activePackage(plugin);
  if (active) return active;
  const all = plugin.packages.all();
  return all.length === 1 ? all[0] : null;
}

function currentNode(plugin: VairePlugin): { pkg: PackageInfo; node: LocalNode } | null {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return null;
  const pkg = plugin.packages.packageFor(file);
  if (!pkg) return null;
  const node = pkg.index.byFile(file);
  if (!node) return null;
  return { pkg, node };
}

export function registerAuthoring(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'vaire-new-node',
    name: 'New Vairë node',
    checkCallback: (checking) => {
      const pkg = targetPackage(plugin);
      if (!pkg) return false;
      if (!checking) new NewNodeModal(plugin, pkg, {}).open();
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-create-entity-from-loose-end',
    name: 'Create entity from loose end at cursor',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg || !file) return false;
      const cursor = editor.getCursor();
      const occurrence = findLooseEndAt(editor.getLine(cursor.line), cursor.ch);
      if (!occurrence) return false;

      if (!checking) {
        const parsed = parseRef(occurrence.inner);
        if (parsed?.kind === 'loose') {
          const line = cursor.line;
          const descriptor = parsed.descriptor;
          new NewNodeModal(plugin, pkg, {
            defaultType: parsed.typeHint,
            defaultName: descriptor,
            onCreated: (result) => {
              void applyResolution(plugin, file, line, descriptor, {
                id: result.fullId,
                name: result.name,
                type: result.type,
                source: 'local',
              });
            },
          }).open();
        }
      }
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-add-alias',
    name: 'Add alias to this node',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found) return false;
      if (!checking) void addAliasToNode(plugin, found.node);
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-add-edge',
    name: 'Add edge to this node',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found) return false;
      if (!checking) addEdgeToNode(plugin, found.pkg, found.node);
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-rename-node-id',
    name: 'Rename node id…',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found || found.node.supersededBy) return false;
      if (!checking) startRename(plugin, found.pkg, found.node);
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-insert-loose-end',
    name: 'Insert loose end',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg) return false;
      if (!checking) {
        new TypePickerModal(plugin.app, pkg.types, (type) => {
          const cursor = editor.getCursor();
          const text = `[[?${looseEndTypeInsertText(type)}]]`;
          editor.replaceRange(text, cursor);
          editor.setCursor({ line: cursor.line, ch: cursor.ch + text.length - 2 });
        }).open();
      }
      return true;
    },
  });
}

export function registerSupersede(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'vaire-supersede-node',
    name: 'Supersede this node with…',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg || !file) return false;
      const node = pkg.index.byFile(file);
      if (!node || node.supersededBy) return false;
      if (!checking) startSupersede(plugin, pkg, node);
      return true;
    },
  });
}

export { startSupersede } from './supersede-modal';
export { startRename } from './rename-modal';
