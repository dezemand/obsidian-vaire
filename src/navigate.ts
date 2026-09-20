// Opening things: a vault file at an optional line, or a Vairë reference of any kind.
// External-page and loose-end-resolution behavior is pluggable via `plugin.hooks` so this
// module doesn't need to know about the suggest/views features that implement them.

import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type { VaireRef } from './ids';
import { resolveLocalRef, type PackageInfo } from './packages';
import type VairePlugin from './main';

export async function openFileAtLine(app: App, file: TFile, line?: number, newLeaf?: boolean): Promise<void> {
  const leaf = app.workspace.getLeaf(newLeaf);
  await leaf.openFile(file);
  if (line == null) return;
  const view = leaf.view;
  if (view instanceof MarkdownView) {
    const pos = { line, ch: 0 };
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: pos }, true);
  }
}

/**
 * Navigates to a parsed Vairë reference:
 * - loose end -> `hooks.resolveLooseEnd`, or a Notice if nothing is wired up yet.
 * - local id (no `@pkg`, `fromRepo` is a vault package) -> open the file via `LocalIndex`,
 *   or a "not found" Notice if it isn't indexed.
 * - anything else (has `@pkg`, or `fromRepo` isn't a vault package) -> `hooks.openExternal`,
 *   or a Notice saying external pages aren't available yet.
 */
export async function openRef(
  plugin: VairePlugin,
  ref: VaireRef,
  fromRepo: PackageInfo | string,
  opts: { newLeaf?: boolean; originScope?: string } = {},
): Promise<void> {
  if (ref.kind === 'loose') {
    if (plugin.hooks.resolveLooseEnd) {
      await plugin.hooks.resolveLooseEnd(ref, fromRepo);
    } else {
      new Notice('Nothing set up to resolve loose ends yet.');
    }
    return;
  }

  const repoAbsRoot = typeof fromRepo === 'string' ? fromRepo : fromRepo.absRoot;
  const fromVaultPkg =
    typeof fromRepo === 'string' ? (plugin.packages.all().find((p) => p.absRoot === fromRepo) ?? null) : fromRepo;

  if (!ref.pkg && fromVaultPkg) {
    const node = resolveLocalRef(fromVaultPkg, ref, opts.originScope);
    if (node) {
      await openFileAtLine(plugin.app, node.file, undefined, opts.newLeaf);
    } else {
      new Notice(`Not found: ${ref.full}`);
    }
    return;
  }

  if (plugin.hooks.openExternal) {
    await plugin.hooks.openExternal(ref, repoAbsRoot, opts);
  } else {
    new Notice('External pages not available yet');
  }
}
