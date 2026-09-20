// Small DOM helpers shared by the node panel's Backlinks ← section (node-view.ts) and the
// dedicated Vairë backlinks view (backlinks-view.ts). Kept out of pure-backlinks.ts so that
// module stays free of any DOM/`obsidian` dependency for `bun test`. See BRANCHES.md
// "feat/backlinks-context".

import { Notice, TFile } from 'obsidian';
import { parseRef, type IdRef } from '../ids';
import { openFileAtLine } from '../navigate';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import type { BacklinkContext, LineSnippet } from './pure-backlinks';
import { vaultPathFor } from './pure-pkg';

/** Renders a `LineSnippet` into `container`: `before` + `mark.vaire-hit` + `after`, or a muted
 *  placeholder when there is nothing to show. */
export function renderBacklinkSnippet(container: HTMLElement, snippet: LineSnippet | null): void {
  container.empty();
  if (!snippet) {
    container.createSpan({ cls: 'vaire-muted', text: '(no preview available)' });
    return;
  }
  if (snippet.before) container.appendText(snippet.before);
  if (snippet.hit) container.createEl('mark', { cls: 'vaire-hit', text: snippet.hit });
  if (snippet.after) container.appendText(snippet.after);
  if (!snippet.before && !snippet.hit && !snippet.after) {
    container.createSpan({ cls: 'vaire-muted', text: '(blank line)' });
  }
}

/**
 * The referencing node's own address as a `VaireRef`, for `createRefElement` — `@pkg/id` when
 * the context is a dependency row, else the bare (already package-local) `id`.
 */
export function refForContext(ctx: { id: string; package?: string }): IdRef | null {
  const ref = parseRef(ctx.package ? `@${ctx.package}/${ctx.id}` : ctx.id);
  return ref && ref.kind === 'id' ? ref : null;
}

/**
 * Opens the file behind a backlink context: a vault file jumps straight to `ctx.line`; a
 * dependency file (no vault presence) opens the read-only external view instead, since that
 * view has no line-level navigation of its own.
 */
export function openBacklinkContext(
  plugin: VairePlugin,
  pkg: PackageInfo,
  ctx: BacklinkContext,
  opts: { newLeaf?: boolean } = {},
): void {
  if (!ctx.package) {
    const file =
      pkg.index.get(ctx.id)?.file ?? plugin.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, ctx.path));
    if (file instanceof TFile) {
      void openFileAtLine(plugin.app, file, ctx.line - 1, opts.newLeaf);
    } else {
      new Notice(`Vairë: not found in vault: ${ctx.path}`);
    }
    return;
  }
  const ref = refForContext(ctx);
  if (ref) {
    void plugin.hooks.openExternal?.(ref, pkg.absRoot, opts);
  } else {
    new Notice(`Vairë: could not open ${ctx.id}`);
  }
}
