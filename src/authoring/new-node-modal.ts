// "New Vairë node" modal: type, name, id slug, optional scope, folder — creates
// `<folder>/<id>.md` with vaire-files-shaped frontmatter + a `# Name` body, then opens it.
// Also the modal opened by "Create entity from loose end" (prefilled type/name), and by the
// synthetic "Create new node…" item in `VaireResolveModal` (src/suggest/resolve-modal.ts).
// See DESIGN.md-style conventions elsewhere in this codebase; the feature itself is specified
// in BRANCHES.md's `feat/new-node` row.

import { Modal, Notice, Setting, type TFile, type TextComponent } from 'obsidian';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { parseRef } from '../ids';
import { buildNodeFile, folderFromPattern, inferFolder, slugify, validateSlug } from './pure';
import { TemplateModal } from '../templates/template-modal';

export interface CreatedNode {
  /** Full id as it should be inserted into a `[[...]]`, including `scope/` when scoped. */
  fullId: string;
  file: TFile;
  name: string;
  type: string;
  scope?: string;
}

export interface NewNodeModalOptions {
  /** Pre-selected/typed type — e.g. a loose end's type hint. Falls back to the active node's
   *  type in this package, then the package's first declared type. */
  defaultType?: string;
  /** Pre-filled name — e.g. a loose end's descriptor. */
  defaultName?: string;
  /** Called after the file is created and opened. */
  onCreated?: (result: CreatedNode) => void;
}

/** Also used by `../templates/template-modal.ts` (`feat/record-templates`) — one implementation
 *  of "vault-relative folder a file lives in" shared by both creation flows. */
export function folderOfFile(file: TFile): string {
  return file.parent && !file.parent.isRoot() ? file.parent.path : '';
}

/** Also used by `../templates/template-modal.ts` — one implementation of "today, YYYY-MM-DD". */
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Also used by `../templates/template-modal.ts` — one implementation of "create every missing
 *  folder segment on the way to `folderPath`". */
export async function ensureFolder(plugin: VairePlugin, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const parts = folderPath.split('/').filter((p) => p.length > 0);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

export class NewNodeModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly opts: NewNodeModalOptions;

  private type: string;
  private name: string;
  private id: string;
  private containerScope = '';
  private folder: string;

  private idTouched = false;
  private folderTouched = false;
  private submitting = false;

  private typeErrorEl!: HTMLElement;
  private idErrorEl!: HTMLElement;
  private scopeErrorEl!: HTMLElement;
  private scopeSetting!: Setting;
  private createButton!: HTMLButtonElement;
  private idText: TextComponent | null = null;
  private folderText: TextComponent | null = null;
  private scopeText: TextComponent | null = null;

  constructor(plugin: VairePlugin, pkg: PackageInfo, opts: NewNodeModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.opts = opts;

    this.name = opts.defaultName ?? '';
    this.id = this.name ? slugify(this.name) : '';
    this.type = this.resolveDefaultType();
    this.folder = this.computeDefaultFolder(this.type);
  }

  private resolveDefaultType(): string {
    if (this.opts.defaultType && this.opts.defaultType.trim()) return this.opts.defaultType.trim();
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const activeNode = activeFile ? this.pkg.index.byFile(activeFile) : null;
    if (activeNode) return activeNode.type;
    return this.pkg.types[0] ?? '';
  }

  private typeOptions(): string[] {
    const options = [...this.pkg.types];
    if (this.type && !options.includes(this.type)) options.unshift(this.type);
    return options;
  }

  private computeDefaultFolder(type: string): string {
    if (!type) return '';
    if (this.plugin.settings.newNodePlacement === 'pattern') {
      return folderFromPattern(this.plugin.settings.newNodeFolderPattern, type);
    }
    const nodesOfType = this.pkg.index.byType().get(type) ?? [];
    const inferred = inferFolder(nodesOfType.map((n) => ({ folder: folderOfFile(n.file) })));
    return inferred ?? folderFromPattern(this.plugin.settings.newNodeFolderPattern, type);
  }

  onOpen(): void {
    this.setTitle('New Vairë node');
    const { contentEl } = this;
    contentEl.addClass('vaire-new-node-modal');

    // ---- Type -----------------------------------------------------------------------------
    const typeSetting = new Setting(contentEl).setName('Type');
    if (this.pkg.types.length > 0) {
      typeSetting.addDropdown((dropdown) => {
        for (const t of this.typeOptions()) dropdown.addOption(t, t);
        dropdown.setValue(this.type);
        dropdown.onChange((value) => {
          this.type = value;
          this.onTypeChanged();
        });
      });
    } else {
      typeSetting.setDesc('No types declared in knowledge.toml — enter one.');
      typeSetting.addText((text) => {
        text.setPlaceholder('type').setValue(this.type);
        text.onChange((value) => {
          this.type = value.trim();
          this.onTypeChanged();
        });
      });
    }
    this.typeErrorEl = contentEl.createDiv({ cls: 'vaire-new-node-error' });

    // ---- Name -------------------------------------------------------------------------------
    new Setting(contentEl).setName('Name').addText((text) => {
      text.setPlaceholder('Display name').setValue(this.name);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.name = value;
        if (!this.idTouched) {
          this.id = slugify(value);
          this.idText?.setValue(this.id);
        }
        this.revalidate();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    // ---- Id ---------------------------------------------------------------------------------
    const idSetting = new Setting(contentEl).setName('Id').setDesc('Lowercase letters, digits and dashes.');
    idSetting.addText((text) => {
      this.idText = text;
      text.setPlaceholder('id-slug').setValue(this.id);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.idTouched = true;
        this.id = value;
        this.revalidate();
      });
    });
    this.idErrorEl = contentEl.createDiv({ cls: 'vaire-new-node-error' });

    // ---- Scope (only for types in scoped_types_whitelist) -----------------------------------
    this.scopeSetting = new Setting(contentEl)
      .setName('Scope')
      .setDesc('Container id (type:id) this node is scoped under.');
    this.scopeSetting.addText((text) => {
      this.scopeText = text;
      text.setPlaceholder('type:id').setValue(this.containerScope);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.containerScope = value.trim();
        this.revalidate();
      });
    });
    this.scopeErrorEl = contentEl.createDiv({ cls: 'vaire-new-node-error' });

    // ---- Folder -----------------------------------------------------------------------------
    new Setting(contentEl).setName('Folder').addText((text) => {
      this.folderText = text;
      text.setPlaceholder('folder').setValue(this.folder);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.folderTouched = true;
        this.folder = value;
      });
    });

    this.updateScopeVisibility();

    // ---- Actions ------------------------------------------------------------------------------
    const actions = new Setting(contentEl);
    // feat/record-templates: same creation pipeline (collision checks, folder inference,
    // rebuildIndex), just starting from a template's placeholders instead of a blank `# Name`
    // body — see ../templates/template-modal.ts.
    actions.addButton((btn) =>
      btn
        .setButtonText('Use template…')
        .setTooltip('Start from a package or builtin template instead of a blank node')
        .onClick(() => {
          this.close();
          new TemplateModal(this.plugin, this.pkg, {
            defaultType: this.type,
            defaultName: this.name,
            defaultDescriptor: this.opts.defaultName,
            onCreated: this.opts.onCreated,
          }).open();
        }),
    );
    actions.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((btn) => {
      btn.setButtonText('Create').setCta();
      this.createButton = btn.buttonEl;
      btn.onClick(() => void this.handleSubmit());
      return btn;
    });

    this.revalidate();
  }

  private onTypeChanged(): void {
    this.updateScopeVisibility();
    if (!this.folderTouched) {
      this.folder = this.computeDefaultFolder(this.type);
      this.folderText?.setValue(this.folder);
    }
    this.revalidate();
  }

  private updateScopeVisibility(): void {
    const shouldShow = this.pkg.scopedTypesWhitelist.includes(this.type);
    this.scopeSetting.settingEl.toggleClass('vaire-hidden', !shouldShow);
    this.scopeErrorEl.toggleClass('vaire-hidden', !shouldShow);
    if (!shouldShow && this.containerScope) {
      this.containerScope = '';
      this.scopeText?.setValue('');
    }
  }

  private fullId(): string {
    return this.containerScope ? `${this.containerScope}/${this.type}:${this.id}` : `${this.type}:${this.id}`;
  }

  private filePath(): string {
    const trimmedFolder = this.folder.replace(/\/+$/, '');
    return trimmedFolder ? `${trimmedFolder}/${this.id}.md` : `${this.id}.md`;
  }

  /** Recomputes validation state and updates the inline error text + Create button state. */
  private revalidate(): { ok: boolean } {
    let typeError = '';
    let idError = '';
    let scopeError = '';

    if (!this.type || !validateSlug(this.type)) {
      typeError = 'Type must be lowercase letters, digits and dashes.';
    }

    if (!this.name.trim()) {
      idError = 'Name is required.';
    } else if (!this.id) {
      idError = 'Id is required.';
    } else if (!validateSlug(this.id)) {
      idError = 'Id must be lowercase letters, digits and dashes, starting with a letter or digit.';
    } else if (!typeError && this.pkg.index.get(this.fullId())) {
      idError = `${this.fullId()} already exists.`;
    } else if (!typeError && this.plugin.app.vault.getAbstractFileByPath(this.filePath())) {
      idError = `A file already exists at ${this.filePath()}.`;
    }

    if (this.containerScope && !(parseRef(this.containerScope)?.kind === 'id')) {
      scopeError = 'Scope must be a valid container id (type:id).';
    }

    if (this.typeErrorEl) this.typeErrorEl.setText(typeError);
    if (this.idErrorEl) this.idErrorEl.setText(idError);
    if (this.scopeErrorEl) this.scopeErrorEl.setText(scopeError);

    const ok = !typeError && !idError && !scopeError;
    if (this.createButton) this.createButton.disabled = !ok;
    return { ok };
  }

  private async handleSubmit(): Promise<void> {
    if (this.submitting) return;
    const { ok } = this.revalidate();
    if (!ok) return;

    this.submitting = true;
    if (this.createButton) this.createButton.disabled = true;

    try {
      const scope = this.containerScope || undefined;
      const filePath = this.filePath();
      await ensureFolder(this.plugin, this.folder);

      // Re-check right before writing — the folder/index may have changed while the modal was open.
      if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
        this.idErrorEl.setText(`A file already exists at ${filePath}.`);
        return;
      }

      const content = buildNodeFile({ id: this.id, type: this.type, name: this.name, scope, today: todayISO() });
      const file = await this.plugin.app.vault.create(filePath, content);

      void this.plugin.rebuildIndex(this.pkg);

      await this.plugin.app.workspace.getLeaf(true).openFile(file);
      this.close();
      this.opts.onCreated?.({ fullId: this.fullId(), file, name: this.name, type: this.type, scope });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Vairë: could not create the node — ${message}`);
    } finally {
      this.submitting = false;
      if (this.createButton) this.createButton.disabled = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
