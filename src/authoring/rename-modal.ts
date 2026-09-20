// "Rename node id…" modal's UI: pick a new id/type, compare the two rename strategies side by
// side, confirm, apply. Reachable from the node panel's Identity section ("Rename id…" button)
// and the "vaire-rename-node-id" command (both call `startRename`). See rename-pure.ts for why
// the two strategies exist and exactly what each one writes; see the vaire-versioning skill for
// why the choice matters (an address *is* the identity — a rename is a removal + an addition,
// and removal is MAJOR for anyone outside this package unless a tombstone keeps the old address
// resolving).

import { ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { parseRef } from '../ids';
import type { BacklinkEntry } from '../types';
import { vaultPathFor } from '../views/pure-pkg';
import { todayIso } from './frontmatter-edit';
import { validateSlug } from './pure';
import { rewriteReference } from './supersede-pure';
import {
  joinFrontmatter,
  planRename,
  siblingPath,
  splitBacklinks,
  splitFrontmatter,
  summarizeRename,
  type RenamePlan,
  type RenameReferenceRewrite,
  type RenameStrategy,
} from './rename-pure';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Entry point for both the node panel's "Rename id…" button and the "Rename node id…"
 *  command. */
export function startRename(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): void {
  if (node.supersededBy) {
    new Notice('Vairë: this node is already a tombstone.');
    return;
  }
  new RenameNodeModal(plugin, pkg, node).open();
}

export class RenameNodeModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly node: LocalNode;

  private newId: string;
  private newType: string;
  private strategy: RenameStrategy = 'tombstone';
  private rewriteRefsOpt = true;

  private backlinks: BacklinkEntry[] = [];
  private backlinksLoaded = false;

  private idErrorEl!: HTMLElement;
  private confirmBtn: ButtonComponent | null = null;
  private inVaultBody!: HTMLElement;
  private externalBody!: HTMLElement;
  private danglingBody!: HTMLElement;
  private busy = false;

  constructor(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.node = node;
    this.newId = node.id;
    this.newType = node.type;
  }

  private typeOptions(): string[] {
    const options = [...this.pkg.types];
    if (this.newType && !options.includes(this.newType)) options.unshift(this.newType);
    return options;
  }

  private newFull(): string {
    return this.node.scope ? `${this.node.scope}/${this.newType}:${this.newId}` : `${this.newType}:${this.newId}`;
  }

  onOpen(): void {
    this.setTitle('Rename node id');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaire-rename-modal');

    const summary = contentEl.createDiv({ cls: 'vaire-rename-summary' });
    summary.createEl('code', { cls: 'vaire-nid', text: this.node.full });
    summary.createSpan({ cls: 'vaire-rename-arrow', text: '→' });
    const newIdEl = summary.createEl('code', { cls: 'vaire-nid' });
    newIdEl.setText(this.newFull());

    new Setting(contentEl).setName('New id').addText((text) => {
      text.setPlaceholder('id-slug').setValue(this.newId);
      text.inputEl.addClass('vaire-rename-wide');
      text.onChange((value) => {
        this.newId = value.trim();
        newIdEl.setText(this.newFull());
        this.revalidate();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    this.idErrorEl = contentEl.createDiv({ cls: 'vaire-new-node-error' });

    const typeSetting = new Setting(contentEl).setName('New type').setDesc('Defaults to the current type.');
    if (this.pkg.types.length > 0) {
      typeSetting.addDropdown((dropdown) => {
        for (const t of this.typeOptions()) dropdown.addOption(t, t);
        dropdown.setValue(this.newType);
        dropdown.onChange((value) => {
          this.newType = value;
          newIdEl.setText(this.newFull());
          this.revalidate();
        });
      });
    } else {
      typeSetting.addText((text) => {
        text.setValue(this.newType);
        text.onChange((value) => {
          this.newType = value.trim();
          newIdEl.setText(this.newFull());
          this.revalidate();
        });
      });
    }

    const backlinksSection = contentEl.createDiv({ cls: 'vaire-section vaire-rename-backlinks' });
    backlinksSection.createEl('h3', { text: 'Backlinks' });
    const inVaultGroup = backlinksSection.createDiv({ cls: 'vaire-rename-backlink-group' });
    inVaultGroup.createEl('h4', { text: 'In this package' });
    this.inVaultBody = inVaultGroup.createDiv();
    this.inVaultBody.setText('Loading…');
    const externalGroup = backlinksSection.createDiv({ cls: 'vaire-rename-backlink-group' });
    externalGroup.createEl('h4', { text: 'Dependency / other package' });
    this.externalBody = externalGroup.createDiv();
    this.externalBody.setText('Loading…');
    void this.loadBacklinks();

    const strategies = contentEl.createDiv({ cls: 'vaire-rename-strategies' });
    this.renderTombstoneCard(strategies);
    this.renderRewriteInPlaceCard(strategies);

    const buttons = contentEl.createDiv({ cls: 'vaire-actions vaire-rename-buttons' });
    new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.close());
    this.confirmBtn = new ButtonComponent(buttons)
      .setButtonText('Rename')
      .setCta()
      .onClick(() => void this.onConfirm());
    this.confirmBtn.setDisabled(true); // re-enabled once backlinks are known and the input validates

    this.revalidate();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ---- strategy cards ---------------------------------------------------------------------

  private renderTombstoneCard(host: HTMLElement): void {
    const card = host.createDiv({ cls: 'vaire-rename-strategy-card' });
    const label = card.createEl('label', { cls: 'vaire-rename-strategy-header' });
    const radio = label.createEl('input', { type: 'radio', attr: { name: 'vaire-rename-strategy' } });
    radio.checked = this.strategy === 'tombstone';
    radio.addEventListener('change', () => {
      if (radio.checked) {
        this.strategy = 'tombstone';
        this.revalidate();
      }
    });
    label.createSpan({ cls: 'vaire-rename-strategy-title', text: 'Tombstone (release-safe) — default' });
    card.createEl('p', {
      cls: 'vaire-muted',
      text:
        `A new file is written at the new id; ${this.node.full} becomes a tombstone that redirects to it. ` +
        'The old address keeps resolving — dependents outside this package need no change (MINOR-compatible).',
    });
    new Setting(card)
      .setName('Rewrite in-vault references')
      .setDesc('Also rewrite [[old]] wikilinks and frontmatter values in this package to the new id. Cosmetic — they’d keep resolving through the redirect either way.')
      .addToggle((toggle) =>
        toggle.setValue(this.rewriteRefsOpt).onChange((value) => {
          this.rewriteRefsOpt = value;
        }),
      );
  }

  private renderRewriteInPlaceCard(host: HTMLElement): void {
    const card = host.createDiv({ cls: 'vaire-rename-strategy-card' });
    const label = card.createEl('label', { cls: 'vaire-rename-strategy-header' });
    const radio = label.createEl('input', { type: 'radio', attr: { name: 'vaire-rename-strategy' } });
    radio.checked = this.strategy === 'rewrite-in-place';
    radio.addEventListener('change', () => {
      if (radio.checked) {
        this.strategy = 'rewrite-in-place';
        this.revalidate();
      }
    });
    label.createSpan({ cls: 'vaire-rename-strategy-title', text: 'Rewrite in place — breaking' });
    card.createEl('p', {
      cls: 'vaire-muted',
      text:
        `The file itself is renamed and its id/type changed. Every in-vault reference to ${this.node.full} is ` +
        'rewritten to the new id.',
    });
    const warning = card.createDiv({ cls: 'vaire-rename-warning' });
    warning.setText(
      'The old address disappears — this is a MAJOR change for anything outside this package. Backlinks below will dangle:',
    );
    this.danglingBody = card.createDiv({ cls: 'vaire-rename-dangling' });
    this.danglingBody.setText('Loading…');
  }

  // ---- backlinks ----------------------------------------------------------------------------

  private async loadBacklinks(): Promise<void> {
    try {
      const result = await this.plugin.cli.backlinks(this.pkg.absRoot, this.node.full);
      this.backlinks = result.backlinks;
      this.backlinksLoaded = true;
      this.renderBacklinkLists();
    } catch (err) {
      this.inVaultBody.empty();
      this.inVaultBody.createDiv({ cls: 'vaire-error', text: `Could not load backlinks — ${errMessage(err)}` });
      this.externalBody.empty();
      this.danglingBody.empty();
    }
    this.revalidate();
  }

  private renderBacklinkLists(): void {
    const { inVault, external } = splitBacklinks(this.backlinks);

    this.inVaultBody.empty();
    if (inVault.length === 0) {
      this.inVaultBody.createDiv({ cls: 'vaire-empty', text: 'None.' });
    } else {
      this.renderBacklinkRows(this.inVaultBody, inVault);
    }

    this.externalBody.empty();
    if (external.length === 0) {
      this.externalBody.createDiv({ cls: 'vaire-empty', text: 'None.' });
    } else {
      this.renderBacklinkRows(this.externalBody, external);
    }

    this.danglingBody.empty();
    if (external.length === 0) {
      this.danglingBody.createDiv({ cls: 'vaire-empty', text: 'Nothing — no backlinks from outside this package.' });
    } else {
      this.renderBacklinkRows(this.danglingBody, external);
    }
  }

  private renderBacklinkRows(container: HTMLElement, rows: BacklinkEntry[]): void {
    for (const b of rows) {
      const row = container.createDiv({ cls: 'vaire-backlink-row' });
      const ref = parseRef(b.id);
      if (ref) row.appendChild(createRefElement(this.plugin, ref, { repo: this.pkg.absRoot }));
      else row.createSpan({ text: b.id });
      const pkgSuffix = b.package ? ` · @${b.package}` : '';
      row.createSpan({ cls: 'vaire-muted', text: `${b.ref_type} · ${b.path}:${b.line}${pkgSuffix}` });
    }
  }

  // ---- validation -----------------------------------------------------------------------------

  private revalidate(): { ok: boolean } {
    let error = '';
    const newId = this.newId.trim();
    const newType = this.newType.trim();

    if (!newId || !validateSlug(newId)) {
      error = 'Id must be lowercase letters, digits and dashes, starting with a letter or digit.';
    } else if (!newType || !validateSlug(newType)) {
      error = 'Type must be lowercase letters, digits and dashes.';
    } else {
      const full = this.newFull();
      if (full === this.node.full) {
        error = 'Choose a different id or type.';
      } else if (this.pkg.index.get(full)) {
        error = `${full} already exists.`;
      } else {
        const targetPath = vaultPathFor(this.pkg.dir, siblingPath(this.relativePath(), newId));
        const existingFile = this.plugin.app.vault.getAbstractFileByPath(targetPath);
        if (existingFile && existingFile.path !== this.node.file.path) {
          error = `A file already exists at ${targetPath}.`;
        }
      }
    }

    this.idErrorEl.setText(error);
    const ok = !error && this.backlinksLoaded;
    if (this.confirmBtn) this.confirmBtn.setDisabled(!ok);
    return { ok };
  }

  private relativePath(): string {
    const dir = this.pkg.dir;
    const path = this.node.file.path;
    return dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
  }

  // ---- confirm --------------------------------------------------------------------------------

  private async onConfirm(): Promise<void> {
    if (this.busy) return;
    const { ok } = this.revalidate();
    if (!ok) return;

    this.busy = true;
    this.confirmBtn?.setDisabled(true);
    try {
      const plan = planRename({
        node: {
          path: this.relativePath(),
          id: this.node.id,
          type: this.node.type,
          scope: this.node.scope,
          full: this.node.full,
          name: this.node.name,
          frontmatterText: await this.readFrontmatterText(),
          body: await this.readBody(),
        },
        newId: this.newId.trim(),
        newType: this.newType.trim(),
        strategy: this.strategy,
        backlinks: this.backlinks,
        rewriteRefs: this.rewriteRefsOpt,
        today: todayIso(),
        existingFullIds: this.pkg.index.all().map((n) => n.full),
      });

      const openFile = await this.applyPlan(plan);
      await this.plugin.rebuildIndex(this.pkg);

      new Notice(
        `Vairë: renamed — ${summarizeRename({
          oldFull: plan.oldFull,
          newFull: plan.newFull,
          strategy: plan.strategy,
          filesWritten: plan.writes.length + plan.renames.length + (plan.tombstone ? 1 : 0),
          referencesRewritten: plan.referenceRewrites.length,
          danglingCount: plan.strategy === 'rewrite-in-place' ? plan.externalBacklinks.length : 0,
        })}`,
      );

      this.close();
      if (openFile) await this.plugin.app.workspace.getLeaf(false).openFile(openFile);
    } catch (err) {
      new Notice(`Vairë: rename failed — ${errMessage(err)}`);
      this.busy = false;
      this.confirmBtn?.setDisabled(false);
    }
  }

  private splitOnceCache: { frontmatterText: string; body: string } | null = null;

  private async ensureSplit(): Promise<{ frontmatterText: string; body: string }> {
    if (this.splitOnceCache) return this.splitOnceCache;
    const raw = await this.plugin.app.vault.read(this.node.file);
    const split = splitFrontmatter(raw);
    if (!split) throw new Error(`${this.node.file.path} has no frontmatter block.`);
    this.splitOnceCache = split;
    return split;
  }

  private async readFrontmatterText(): Promise<string> {
    return (await this.ensureSplit()).frontmatterText;
  }

  private async readBody(): Promise<string> {
    return (await this.ensureSplit()).body;
  }

  // ---- applying the plan ----------------------------------------------------------------------

  /** Executes `plan` against the live vault, returning the file to open afterward. */
  private async applyPlan(plan: RenamePlan): Promise<TFile | null> {
    const { app } = this.plugin;
    let openFile: TFile | null = null;

    for (const w of plan.writes) {
      const created = await app.vault.create(vaultPathFor(this.pkg.dir, w.path), w.content);
      openFile = created;
    }

    for (const m of plan.renames) {
      const target = vaultPathFor(this.pkg.dir, m.newPath);
      await app.fileManager.renameFile(this.node.file, target);
      openFile = this.node.file;
    }

    for (const fr of plan.frontmatterRewrites) {
      const file = app.vault.getAbstractFileByPath(vaultPathFor(this.pkg.dir, fr.path));
      if (!(file instanceof TFile)) continue;
      await app.vault.process(file, (data) => {
        const split = splitFrontmatter(data);
        if (!split) return data;
        return joinFrontmatter(fr.frontmatterText, split.body);
      });
    }

    if (plan.tombstone) {
      const tombstone = plan.tombstone;
      const file = app.vault.getAbstractFileByPath(vaultPathFor(this.pkg.dir, tombstone.path));
      if (file instanceof TFile) {
        await app.fileManager.processFrontMatter(file, (fm) => {
          for (const key of Object.keys(fm)) {
            if (key !== 'id' && key !== 'type' && key !== 'name' && key !== 'scope') delete fm[key];
          }
          fm.id = tombstone.keep.id;
          fm.type = tombstone.keep.type;
          fm.name = tombstone.keep.name;
          if (tombstone.keep.scope) fm.scope = tombstone.keep.scope;
          else delete fm.scope;
          fm.superseded_by = tombstone.supersededBy;
          fm.updated = tombstone.updated;
        });
        await app.vault.process(file, (data) => {
          const split = splitFrontmatter(data);
          if (!split) return data;
          return joinFrontmatter(split.frontmatterText, tombstone.body);
        });
      }
    }

    await this.applyReferenceRewrites(plan.referenceRewrites);

    return openFile;
  }

  /** Mirrors `SupersedeConfirmModal.rewriteBacklinks` (supersede-modal.ts): rewrite the
   *  referencing line of every row that lives in a vault file within this package. `rw.path` is
   *  already the file's *post-rename* location — `planRename` (rename-pure.ts) routes a
   *  self-referencing row (the node linking to itself) at the new path instead of the old one,
   *  since the old path no longer holds that content by the time this runs (tombstone: it's now
   *  the tombstone; rewrite-in-place: the file was renamed away). A row whose file still can't
   *  be found is silently skipped rather than failing the whole rename. */
  private async applyReferenceRewrites(rewrites: RenameReferenceRewrite[]): Promise<number> {
    let count = 0;
    for (const rw of rewrites) {
      const file = this.plugin.app.vault.getAbstractFileByPath(vaultPathFor(this.pkg.dir, rw.path));
      if (!(file instanceof TFile)) continue;

      let changed = false;
      await this.plugin.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        const idx = rw.line - 1;
        if (idx < 0 || idx >= lines.length) return data;
        const rewritten = rewriteReference(lines[idx], rw.oldFull, rw.newFull);
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
