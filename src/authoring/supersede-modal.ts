// The supersede (tombstone) workflow's UI: pick a successor, confirm, apply. Maintainer
// action, reachable from the node panel's "Supersede…" button and the
// "vaire-supersede-node" command (both call `startSupersede`).
//
// Picking the successor reuses `VaireResolveModal` (src/suggest/resolve-modal.ts), prefilled
// with the old node's name and narrowed to same-package, non-self candidates via its `filter`
// hook. Confirming applies four things in order: (1) tombstone the old node
// (`superseded_by: <newFull>`, `updated` bumped) via `processFrontMatter`; (2) optionally
// merge the old node's name + aliases into the successor's `aliases`; (3) optionally rewrite
// `[[old]]`/frontmatter-value backlinks that live in this package (never a dependency
// backlink) to point at the new id, preserving display text; (4) rebuild the index, which
// refreshes every view via the `index-rebuilt` event. References keep resolving through the
// redirect regardless of (3) — rewriting is cosmetic, not required.

import { ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian';
import { parseRef } from '../ids';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import type { BacklinkEntry } from '../types';
import { VaireResolveModal } from '../suggest/resolve-modal';
import type { Candidate } from '../suggest/pure';
import { vaultPathFor } from '../views/pure-pkg';
import { mergeAliases, rewriteReference, summarizeSupersede, todayIso } from './supersede-pure';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Entry point for both the node panel's "Supersede…" button and the
 * "Supersede this node with…" command: opens `VaireResolveModal` (prefilled with the node's
 * own name, narrowed to same-type suggestions where the CLI can, and filtered to same-package
 * non-self candidates), then on pick opens the confirmation modal.
 */
export function startSupersede(plugin: VairePlugin, pkg: PackageInfo, oldNode: LocalNode): void {
  if (oldNode.supersededBy) {
    new Notice('Vairë: this node is already superseded.');
    return;
  }
  new VaireResolveModal(
    plugin,
    pkg,
    oldNode.name,
    oldNode.type,
    (candidate) => new SupersedeConfirmModal(plugin, pkg, oldNode, candidate).open(),
    // Same package only: a CLI candidate carries `pkg` when it's a dependency (or, with
    // "suggest from every catalog package" on, any other catalog package) — exclude those,
    // and exclude the node itself.
    (candidate) => !candidate.pkg && candidate.id !== oldNode.full,
  ).open();
}

export class SupersedeConfirmModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly oldNode: LocalNode;
  private readonly successor: Candidate;

  private mergeAliasesOpt = true;
  private rewriteRefsOpt = false;
  private backlinks: BacklinkEntry[] = [];
  private confirmBtn: ButtonComponent | null = null;
  private busy = false;

  constructor(plugin: VairePlugin, pkg: PackageInfo, oldNode: LocalNode, successor: Candidate) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.oldNode = oldNode;
    this.successor = successor;
  }

  onOpen(): void {
    this.setTitle('Supersede this node');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaire-supersede-modal');

    const summary = contentEl.createDiv({ cls: 'vaire-supersede-summary' });
    summary.createEl('code', { cls: 'vaire-nid', text: this.oldNode.full });
    summary.createSpan({ cls: 'vaire-supersede-arrow', text: '→' });
    summary.createEl('code', { cls: 'vaire-nid', text: this.successor.id });
    contentEl.createDiv({
      cls: 'vaire-muted',
      text: `${this.oldNode.name} → ${this.successor.name}`,
    });

    const backlinksSection = contentEl.createDiv({ cls: 'vaire-section vaire-supersede-backlinks' });
    backlinksSection.createEl('h3', { text: 'Backlinks that will redirect' });
    const backlinksBody = backlinksSection.createDiv();
    backlinksBody.setText('Loading…');
    void this.loadBacklinks(backlinksBody);

    new Setting(contentEl)
      .setName('Merge aliases into the successor')
      .setDesc(
        `Append "${this.oldNode.name}" and its aliases to ${this.successor.name}'s aliases, deduped.`,
      )
      .addToggle((toggle) =>
        toggle.setValue(this.mergeAliasesOpt).onChange((value) => {
          this.mergeAliasesOpt = value;
        }),
      );

    new Setting(contentEl)
      .setName('Rewrite references in this package')
      .setDesc(
        'References keep resolving through the redirect either way, so this is optional. When on, ' +
          'rewrites [[old]] / [[old|display]] wikilinks and frontmatter values in this package’s ' +
          'vault files to the new id, preserving any display text. Backlinks from other packages are ' +
          'left alone.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.rewriteRefsOpt).onChange((value) => {
          this.rewriteRefsOpt = value;
        }),
      );

    const warning = contentEl.createDiv({ cls: 'vaire-supersede-warning' });
    warning.setText(
      'This creates a tombstone — the old address keeps resolving here from now on. Removing an ' +
        'address later (deleting a tombstone) is a MAJOR release act.',
    );

    const buttons = contentEl.createDiv({ cls: 'vaire-actions vaire-supersede-buttons' });
    new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.close());
    this.confirmBtn = new ButtonComponent(buttons)
      .setButtonText('Supersede')
      .setCta()
      .onClick(() => void this.onConfirm());
    this.confirmBtn.setDisabled(true); // re-enabled once the backlink count is known
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadBacklinks(body: HTMLElement): Promise<void> {
    try {
      const result = await this.plugin.cli.backlinks(this.pkg.absRoot, this.oldNode.full);
      this.backlinks = result.backlinks;
      this.renderBacklinks(body);
    } catch (err) {
      body.empty();
      body.createDiv({ cls: 'vaire-error', text: `Could not load backlinks — ${errMessage(err)}` });
    }
    if (!this.busy) this.confirmBtn?.setDisabled(false);
  }

  private renderBacklinks(body: HTMLElement): void {
    body.empty();
    if (this.backlinks.length === 0) {
      body.createDiv({ cls: 'vaire-empty', text: 'No backlinks — nothing points at this node yet.' });
      return;
    }
    body.createDiv({
      cls: 'vaire-muted',
      text: `${this.backlinks.length} backlink${this.backlinks.length === 1 ? '' : 's'} — all will keep resolving through the redirect.`,
    });
    const list = body.createDiv({ cls: 'vaire-supersede-backlink-list' });
    for (const b of this.backlinks) {
      const row = list.createDiv({ cls: 'vaire-backlink-row' });
      const ref = parseRef(b.id);
      if (ref) row.appendChild(createRefElement(this.plugin, ref, { repo: this.pkg.absRoot }));
      else row.createSpan({ text: b.id });
      row.createSpan({ cls: 'vaire-muted', text: `${b.ref_type} · ${b.path}:${b.line}` });
    }
  }

  private async onConfirm(): Promise<void> {
    this.busy = true;
    this.confirmBtn?.setDisabled(true);
    try {
      await this.performSupersede();
      this.close();
    } catch (err) {
      new Notice(`Vairë: supersede failed — ${errMessage(err)}`);
      this.busy = false;
      this.confirmBtn?.setDisabled(false);
    }
  }

  private async performSupersede(): Promise<void> {
    const oldFull = this.oldNode.full;
    const newFull = this.successor.id;

    await this.plugin.app.fileManager.processFrontMatter(this.oldNode.file, (fm) => {
      fm.superseded_by = newFull;
      fm.updated = todayIso();
    });

    let aliasesMerged = false;
    if (this.mergeAliasesOpt) {
      const successorNode = this.pkg.index.get(this.successor.id);
      if (successorNode) {
        await this.plugin.app.fileManager.processFrontMatter(successorNode.file, (fm) => {
          fm.aliases = mergeAliases(fm as Record<string, unknown>, {
            name: this.oldNode.name,
            aliases: this.oldNode.aliases,
          });
        });
        aliasesMerged = true;
      }
    }

    let referencesRewritten = 0;
    if (this.rewriteRefsOpt) {
      referencesRewritten = await this.rewriteBacklinks(oldFull, newFull);
    }

    await this.plugin.rebuildIndex(this.pkg);

    new Notice(
      `Vairë: superseded — ${summarizeSupersede({
        oldFull,
        newFull,
        backlinksCount: this.backlinks.length,
        aliasesMerged,
        referencesRewritten,
      })}`,
    );
  }

  /** Rewrites the referencing line of every backlink that lives in a vault file within this
   *  package (dependency backlinks — those carrying a `package` — are skipped: "in this
   *  package" is the checkbox's whole scope). Returns how many lines actually changed. */
  private async rewriteBacklinks(oldFull: string, newFull: string): Promise<number> {
    let count = 0;
    for (const b of this.backlinks) {
      if (b.package) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(vaultPathFor(this.pkg.dir, b.path));
      if (!(file instanceof TFile)) continue;

      let changed = false;
      await this.plugin.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        const idx = b.line - 1;
        if (idx < 0 || idx >= lines.length) return data;
        const rewritten = rewriteReference(lines[idx], oldFull, newFull);
        if (rewritten !== lines[idx]) {
          lines[idx] = rewritten;
          changed = true;
        }
        return lines.join('\n');
      });
      if (changed) count++;
    }
    return count;
  }
}
