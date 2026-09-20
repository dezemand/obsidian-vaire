// "New Vairë node from template" modal: pick a template (package-curated or a builtin preset —
// see pure.ts's `listTemplateOptions` doc comment for the `templateSource` trade-off), fill its
// placeholders, create the file, open it. Reuses the New-node modal's own folder/collision/id
// machinery (../authoring/new-node-modal.ts) so both creation paths behave identically once a
// template is chosen — see BRANCHES.md `feat/record-templates`.

import { Modal, Notice, Setting, TFile, type TextComponent } from 'obsidian';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { parseRef } from '../ids';
import { folderFromPattern, inferFolder, validateSlug } from '../authoring/pure';
import { ensureFolder, folderOfFile, todayISO, type CreatedNode } from '../authoring/new-node-modal';
import { builtinTemplateFor } from './builtin';
import {
  defaultIdFor,
  listPackageTemplates,
  listTemplateOptions,
  parseTemplate,
  renderTemplate,
  templateIdLooksDated,
  type ParsedTemplate,
  type RenderVars,
  type TemplateOption,
} from './pure';

export interface TemplateModalOptions {
  /** Pre-selected type — e.g. the New-node modal's own type field when bridged via its
   *  "Use template…" button, or a loose end's type hint. */
  defaultType?: string;
  /** Pre-filled name. */
  defaultName?: string;
  /** The loose end's original descriptor, when opened via "Create entity from loose end"-style
   *  flows — available to a template as `{{descriptor}}`. */
  defaultDescriptor?: string;
  onCreated?: (result: CreatedNode) => void;
}

async function readVaultTextFile(plugin: VairePlugin, path: string): Promise<string> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`template file not found: ${path}`);
  return plugin.app.vault.read(file);
}

/** Package-root-relative paths of every markdown file belonging to `pkg` (nearest-ancestor
 *  package, per `PackageRegistry.packageFor`), for `listPackageTemplates`. */
function relativeMarkdownPaths(plugin: VairePlugin, pkg: PackageInfo): string[] {
  const prefix = pkg.dir ? `${pkg.dir}/` : '';
  const out: string[] = [];
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (plugin.packages.packageFor(file.path) !== pkg) continue;
    out.push(pkg.dir ? file.path.slice(prefix.length) : file.path);
  }
  return out;
}

export class TemplateModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly opts: TemplateModalOptions;

  private options: TemplateOption[] = [];
  private selected: TemplateOption | null = null;
  private parsed: ParsedTemplate | null = null;

  private type = '';
  private name: string;
  private id = '';
  private containerScope = '';
  private folder = '';
  private fieldValues: Record<string, string> = {};

  private idTouched = false;
  private folderTouched = false;
  private submitting = false;
  private loadToken = 0;

  private fieldsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private createButton!: HTMLButtonElement;
  private idText: TextComponent | null = null;
  private scopeSetting!: Setting;
  private scopeText: TextComponent | null = null;

  constructor(plugin: VairePlugin, pkg: PackageInfo, opts: TemplateModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.opts = opts;
    this.name = opts.defaultName ?? '';
  }

  onOpen(): void {
    this.setTitle('New Vairë node from template');
    const { contentEl } = this;
    contentEl.addClass('vaire-template-modal');
    contentEl.createDiv({ cls: 'vaire-template-loading', text: 'Loading templates…' });
    void this.loadOptions();
  }

  private async loadOptions(): Promise<void> {
    const paths = relativeMarkdownPaths(this.plugin, this.pkg);
    const packageTemplates = listPackageTemplates(paths, this.plugin.settings.templateFolder);
    this.options = listTemplateOptions(
      this.pkg.types,
      packageTemplates,
      this.plugin.settings.templateSource,
      (type) => builtinTemplateFor(type),
    );
    this.render();
    const preferredType = this.opts.defaultType && this.pkg.types.includes(this.opts.defaultType)
      ? this.opts.defaultType
      : undefined;
    const initial =
      this.options.find((o) => o.type === preferredType) ?? this.options[0] ?? null;
    if (initial) await this.selectOption(initial);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.options.length === 0) {
      contentEl.createDiv({
        cls: 'vaire-template-empty',
        text: 'No templates available — this package declares no types, or has no package/builtin templates for the configured template source.',
      });
      new Setting(contentEl).addButton((btn) => btn.setButtonText('Close').onClick(() => this.close()));
      return;
    }

    new Setting(contentEl).setName('Template').addDropdown((dropdown) => {
      for (const option of this.options) {
        dropdown.addOption(`${option.type}\u0000${option.source}`, option.label);
      }
      if (this.selected) dropdown.setValue(`${this.selected.type}\u0000${this.selected.source}`);
      dropdown.onChange((value) => {
        const [type, source] = value.split('\u0000');
        const option = this.options.find((o) => o.type === type && o.source === source);
        if (option) void this.selectOption(option);
      });
    });

    new Setting(contentEl).setName('Name').addText((text) => {
      text.setPlaceholder('Display name').setValue(this.name);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.name = value;
        if (!this.idTouched) this.refreshId();
        this.revalidate();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

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
    this.updateScopeVisibility();

    new Setting(contentEl).setName('Folder').addText((text) => {
      text.setPlaceholder('folder').setValue(this.folder);
      text.inputEl.addClass('vaire-new-node-wide');
      text.onChange((value) => {
        this.folderTouched = true;
        this.folder = value;
      });
    });

    this.fieldsEl = contentEl.createDiv({ cls: 'vaire-template-fields' });
    this.renderFields();

    this.errorEl = contentEl.createDiv({ cls: 'vaire-new-node-error' });

    const actions = new Setting(contentEl);
    actions.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((btn) => {
      btn.setButtonText('Create').setCta();
      this.createButton = btn.buttonEl;
      btn.onClick(() => void this.handleSubmit());
      return btn;
    });

    this.revalidate();
  }

  private renderFields(): void {
    this.fieldsEl.empty();
    if (!this.parsed) return;
    const prompts = this.parsed.placeholders.filter((p) => p.kind !== 'well-known');
    if (prompts.length === 0) return;
    this.fieldsEl.createEl('h4', { text: 'Template fields' });
    for (const placeholder of prompts) {
      new Setting(this.fieldsEl).setName(placeholder.label ?? placeholder.key).addText((text) => {
        text.setValue(this.fieldValues[placeholder.key] ?? '');
        text.inputEl.addClass('vaire-new-node-wide');
        text.onChange((value) => {
          this.fieldValues[placeholder.key] = value;
        });
      });
    }
  }

  private async selectOption(option: TemplateOption): Promise<void> {
    const token = ++this.loadToken;
    this.selected = option;
    this.type = option.type;
    this.fieldValues = {};
    try {
      const text = option.source === 'package' ? await readVaultTextFile(this.plugin, option.path!) : builtinTemplateFor(option.type).text;
      if (token !== this.loadToken) return; // a newer selection started while we were reading
      this.parsed = parseTemplate(text);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.parsed = parseTemplate('---\nid: <slug>\ntype: ' + option.type + '\nname: <Name>\n---\n# <Name>\n');
      new Notice(`Vairë: could not read the template for ${option.type} — ${errMessage(err)}`);
    }
    if (!this.folderTouched) this.folder = this.computeDefaultFolder(this.type);
    if (!this.idTouched) this.refreshId();
    this.render();
  }

  private refreshId(): void {
    const datedTypes = this.parsed && templateIdLooksDated(this.parsed.frontmatterText) ? [this.type] : [];
    this.id = this.name ? defaultIdFor(this.type, this.name, todayISO(), datedTypes) : '';
    this.idText?.setValue(this.id);
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

  private updateScopeVisibility(): void {
    const shouldShow = this.pkg.scopedTypesWhitelist.includes(this.type);
    this.scopeSetting.settingEl.toggleClass('vaire-hidden', !shouldShow);
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

  private revalidate(): { ok: boolean } {
    let error = '';
    if (!this.name.trim()) {
      error = 'Name is required.';
    } else if (!this.id) {
      error = 'Id is required.';
    } else if (!validateSlug(this.id)) {
      error = 'Id must be lowercase letters, digits and dashes, starting with a letter or digit.';
    } else if (this.pkg.index.get(this.fullId())) {
      error = `${this.fullId()} already exists.`;
    } else if (this.plugin.app.vault.getAbstractFileByPath(this.filePath())) {
      error = `A file already exists at ${this.filePath()}.`;
    } else if (this.containerScope && !(parseRef(this.containerScope)?.kind === 'id')) {
      error = 'Scope must be a valid container id (type:id).';
    }
    if (this.errorEl) this.errorEl.setText(error);
    const ok = !error;
    if (this.createButton) this.createButton.disabled = !ok;
    return { ok };
  }

  private async handleSubmit(): Promise<void> {
    if (this.submitting || !this.parsed) return;
    const { ok } = this.revalidate();
    if (!ok) return;

    this.submitting = true;
    if (this.createButton) this.createButton.disabled = true;

    try {
      const scope = this.containerScope || undefined;
      const filePath = this.filePath();
      await ensureFolder(this.plugin, this.folder);

      if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
        this.errorEl.setText(`A file already exists at ${filePath}.`);
        return;
      }

      const today = todayISO();
      const vars: RenderVars = {
        id: this.id,
        name: this.name,
        type: this.type,
        scope,
        date: today,
        today,
        package: this.pkg.name,
        descriptor: this.opts.defaultDescriptor,
        fields: this.fieldValues,
      };
      const content = renderTemplate(this.parsed, vars);
      const file = await this.plugin.app.vault.create(filePath, content);

      void this.plugin.rebuildIndex(this.pkg);

      await this.plugin.app.workspace.getLeaf(true).openFile(file);
      this.close();
      this.opts.onCreated?.({ fullId: this.fullId(), file, name: this.name, type: this.type, scope });
    } catch (err) {
      new Notice(`Vairë: could not create the node — ${errMessage(err)}`);
    } finally {
      this.submitting = false;
      if (this.createButton) this.createButton.disabled = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
