// Small modal for adding one frontmatter edge to a node — opened from the node panel's "Add
// edge" action and the "Add edge to this node" command (src/authoring/actions.ts /
// src/authoring/index.ts). See DESIGN.md "Suggestions" §2 for `VaireResolveModal`, and the
// vaire-contributing/vaire-files skills for the additive-only edge shape this produces (a
// scalar, a list, or a `?type: descriptor` loose end — never an edit to an existing value).

import { Modal, Notice, Setting } from 'obsidian';
import { VaireResolveModal } from '../suggest/resolve-modal';
import type { Candidate } from '../suggest/pure';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { edgeKeysForType, looseEndText, type FrontmatterLike } from './frontmatter-edit';

export class EdgeModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly nodeType: string;
  private readonly onSubmit: (key: string, value: string) => void;

  private key = '';
  private target = '';
  private looseEnd = false;
  private looseType = '';
  private descriptor = '';

  private fieldsHost: HTMLElement | null = null;

  constructor(plugin: VairePlugin, pkg: PackageInfo, nodeType: string, onSubmit: (key: string, value: string) => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.nodeType = nodeType;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.setTitle('Add edge');
    const { contentEl } = this;

    const keyListId = 'vaire-edge-key-options';
    const keyDatalist = contentEl.createEl('datalist', { attr: { id: keyListId } });
    const nodesOfType: FrontmatterLike[] = this.pkg.index.byType().get(this.nodeType) ?? [];
    for (const key of edgeKeysForType(nodesOfType)) keyDatalist.createEl('option', { attr: { value: key } });

    new Setting(contentEl)
      .setName('Key')
      .setDesc('Frontmatter field name for this edge, e.g. "participants". Reuse an existing one when it fits.')
      .addText((text) => {
        text.setPlaceholder('key').setValue(this.key);
        text.inputEl.setAttr('list', keyListId);
        text.onChange((v) => (this.key = v));
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl)
      .setName('Loose end')
      .setDesc('Not sure which node this is yet — store "?type: descriptor" instead of an id (vaire-files: never guess an id).')
      .addToggle((toggle) =>
        toggle.setValue(this.looseEnd).onChange((value) => {
          this.looseEnd = value;
          this.renderFields();
        }),
      );

    this.fieldsHost = contentEl.createDiv();
    this.renderFields();

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Add edge')
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private renderFields(): void {
    const host = this.fieldsHost;
    if (!host) return;
    host.empty();

    if (this.looseEnd) {
      const typeListId = 'vaire-edge-loose-type-options';
      const typeDatalist = host.createEl('datalist', { attr: { id: typeListId } });
      for (const t of this.pkg.types) typeDatalist.createEl('option', { attr: { value: t } });

      new Setting(host)
        .setName('Type')
        .setDesc('Type hint, if known. Leave empty for "unknown type" (?).')
        .addText((text) => {
          text.setPlaceholder('type').setValue(this.looseType);
          text.inputEl.setAttr('list', typeListId);
          text.onChange((v) => (this.looseType = v));
        });

      new Setting(host)
        .setName('Descriptor')
        .setDesc('What you actually observed — never a guessed name or slug (vaire-contributing).')
        .addText((text) =>
          text
            .setPlaceholder('someone from ops')
            .setValue(this.descriptor)
            .onChange((v) => (this.descriptor = v)),
        );
      return;
    }

    new Setting(host)
      .setName('Target')
      .setDesc("The target node's id (type:id), or @pkg/type:id for a dependency.")
      .addText((text) => {
        text.setPlaceholder('type:id').setValue(this.target);
        text.onChange((v) => (this.target = v));
      })
      .addButton((btn) =>
        btn
          .setButtonText('Pick…')
          .setTooltip('Search for the target node')
          .onClick(() => {
            new VaireResolveModal(this.plugin, this.pkg, this.target, undefined, (candidate: Candidate) => {
              this.target = candidate.id;
              this.renderFields();
            }).open();
          }),
      );
  }

  private submit(): void {
    const key = this.key.trim();
    if (!key) {
      new Notice('Vairë: an edge needs a key');
      return;
    }

    if (this.looseEnd) {
      if (!this.descriptor.trim()) {
        new Notice('Vairë: a loose end needs a descriptor');
        return;
      }
      const value = looseEndText(this.looseType || undefined, this.descriptor);
      this.close();
      this.onSubmit(key, value);
      return;
    }

    const value = this.target.trim();
    if (!value) {
      new Notice('Vairë: an edge needs a target');
      return;
    }
    this.close();
    this.onSubmit(key, value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
