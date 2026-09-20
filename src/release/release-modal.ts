// The "Cut release" modal: plan preview, a summary textarea (the narrative `vaire release
// --summary <file>` carries into the release record), a MAJOR acknowledgement checkbox, and
// the Release button itself. See DESIGN.md's release-ui addendum and the
// vaire-release-summary skill (what makes an acceptable summary). Untested directly (it
// imports `obsidian`, which has no runtime outside the app — see src/release/pure.ts and
// tests/release.test.ts for the tested logic this modal is a thin shell around).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ButtonComponent, Modal, Notice, Setting, TextAreaComponent, ToggleComponent } from 'obsidian';
import { VaireError } from '../cli';
import type { PackageInfo } from '../packages';
import type { ReleasePlan } from '../types';
import { confirm } from '../ui/prompt-modal';
import type VairePlugin from '../main';
import { describePlan, summaryHints } from './pure';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tempSummaryPath(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `vaire-release-summary-${Date.now()}-${rand}.md`);
}

export class ReleaseModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;

  private major = false;
  private summaryText = '';
  private planEl!: HTMLElement;
  private releaseBtn!: ButtonComponent;
  private planRequestId = 0;

  constructor(plugin: VairePlugin, pkg: PackageInfo) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
  }

  onOpen(): void {
    this.setTitle(`Cut a release for ${this.pkg.name}`);
    const { contentEl } = this;
    contentEl.addClass('vaire-release-modal');

    contentEl.createEl('p', {
      cls: 'vaire-muted',
      text: 'vaire release commits and tags this repository. It never pushes — use Push separately once you are ready to publish.',
    });

    this.planEl = contentEl.createDiv({ cls: 'vaire-release-plan' });
    void this.refreshPlan();

    new Setting(contentEl)
      .setName('This is a MAJOR release')
      .setDesc('Adds --major. Required when the classifier sees entities removed or retired.')
      .addToggle((toggle: ToggleComponent) =>
        toggle.setValue(this.major).onChange((value) => {
          this.major = value;
          void this.refreshPlan();
        }),
      );

    contentEl.createEl('h3', { text: 'Summary' });
    const hints = contentEl.createEl('ul', { cls: 'vaire-release-hints' });
    for (const hint of summaryHints()) hints.createEl('li', { text: hint });

    const textArea = new TextAreaComponent(contentEl);
    textArea.inputEl.addClass('vaire-release-summary-input');
    textArea.setPlaceholder(
      'What should a reader of this release understand? Reference entities as [[type:id]]…',
    );
    textArea.onChange((value) => {
      this.summaryText = value;
    });

    const actions = contentEl.createDiv({ cls: 'vaire-actions' });
    new ButtonComponent(actions).setButtonText('Cancel').onClick(() => this.close());
    this.releaseBtn = new ButtonComponent(actions).setButtonText('Release').onClick(() => void this.doRelease());
    this.releaseBtn.buttonEl.addClass('mod-warning');
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refreshPlan(): Promise<void> {
    const requestId = ++this.planRequestId;
    this.planEl.empty();
    this.planEl.setText('Planning…');
    let plan: ReleasePlan;
    try {
      plan = await this.plugin.cli.releaseDryRun(this.pkg.absRoot, { major: this.major });
    } catch (err) {
      if (requestId !== this.planRequestId) return; // a newer request already landed
      this.planEl.empty();
      this.planEl.createDiv({ cls: 'vaire-error', text: `Could not compute the plan — ${errMessage(err)}` });
      return;
    }
    if (requestId !== this.planRequestId) return;
    this.planEl.empty();
    const described = describePlan(plan);
    this.planEl.createEl('strong', { text: described.title });
    for (const line of described.lines) this.planEl.createDiv({ cls: 'vaire-muted', text: line });
  }

  private async doRelease(): Promise<void> {
    if (!this.summaryText.trim()) {
      new Notice('Vairë: write a release summary first.');
      return;
    }
    const ok = await confirm(this.app, {
      title: 'Cut a release',
      message: `This commits and tags the repository for ${this.pkg.name}. It does not push. Continue?`,
      okLabel: 'Release',
    });
    if (!ok) return;

    this.releaseBtn.setDisabled(true);
    const tmpFile = tempSummaryPath();
    try {
      fs.writeFileSync(tmpFile, this.summaryText, 'utf8');
      const result = await this.plugin.cli.release(this.pkg.absRoot, { summaryFile: tmpFile, major: this.major });

      if (result.status === 'blocked') {
        const described = describePlan(result);
        new Notice(`Vairë: release blocked — ${described.lines.join(' ')}`, 12000);
        this.releaseBtn.setDisabled(false);
        void this.refreshPlan();
        return;
      }

      new Notice(`Vairë: released ${this.pkg.name} v${result.version ?? '?'}${result.tag ? ` (${result.tag})` : ''}`);
      await this.plugin.rebuildIndex(this.pkg); // triggers 'index-rebuilt', which the open PackageView re-renders on
      this.close();
    } catch (err) {
      const message = errMessage(err);
      if (err instanceof VaireError && err.code === 7) {
        new Notice(`Vairë: release blocked (MAJOR) — ${message}`, 12000);
      } else {
        new Notice(`Vairë: release failed — ${message}`, 12000);
      }
      this.releaseBtn.setDisabled(false);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup; vaire itself never depends on this file surviving
      }
    }
  }
}
