// The git history row's diff modal (BRANCHES.md `feat/node-history`): `git show --stat <hash>
// -- <file>`'s output (commit header, diffstat, unified diff for just this file) rendered as a
// `pre` with added/removed line coloring. Untested directly (imports `obsidian`); the parsing it
// renders is `parseDiff` (src/history/pure.ts, see tests/history.test.ts).

import { Modal } from 'obsidian';
import type { LocalNode, PackageInfo } from '../packages';
import { packageRelativePath } from '../views/pure-pkg';
import type VairePlugin from '../main';
import { gitShow } from './git';
import type { GitLogEntry } from './pure';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class GitDiffModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly node: LocalNode;
  private readonly entry: GitLogEntry;

  constructor(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, entry: GitLogEntry) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.node = node;
    this.entry = entry;
  }

  onOpen(): void {
    this.setTitle(`${this.entry.shortHash} — ${this.entry.subject}`);
    const { contentEl } = this;
    contentEl.addClass('vaire-history-diff-modal');

    const meta = contentEl.createDiv({ cls: 'vaire-muted vaire-history-diff-meta' });
    meta.setText(`${this.entry.author} · ${this.entry.date} · ${this.entry.hash}`);

    const body = contentEl.createDiv({ cls: 'vaire-history-diff-body' });
    body.setText('Loading diff…');
    void this.load(body);
  }

  private async load(body: HTMLElement): Promise<void> {
    try {
      const relPath = packageRelativePath(this.node.file.path, this.pkg.dir);
      const result = await gitShow(this.pkg.absRoot, this.entry.hash, relPath);
      body.empty();
      if (result.lines.length === 0) {
        body.createDiv({ cls: 'vaire-empty', text: 'No diff output for this commit.' });
        return;
      }
      const pre = body.createEl('pre', { cls: 'vaire-history-diff-pre' });
      for (const line of result.lines) {
        // A blank context/hunk line still needs a rendered row (not just an empty <div>) so the
        // diff's line spacing survives — a non-breaking space keeps the row's height.
        pre.createDiv({ cls: `vaire-diff-line vaire-diff-${line.kind}`, text: line.text || ' ' });
      }
    } catch (err) {
      body.empty();
      body.createDiv({ cls: 'vaire-error', text: `Could not load diff — ${errMessage(err)}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openDiffModal(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, entry: GitLogEntry): void {
  new GitDiffModal(plugin, pkg, node, entry).open();
}
