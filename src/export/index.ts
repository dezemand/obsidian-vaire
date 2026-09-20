// Impure orchestration for "portable Markdown export" (see DESIGN.md's export feature brief and
// BRANCHES.md wave 7 for the `exportMode: 'render' | 'local'` trade-off this branch builds).
// Three commands, all operating on the active file's node:
//  - `vaire-copy-portable-markdown` ("Copy node as portable Markdown"): builds with the current
//    settings (no modal) and copies to the clipboard.
//  - `vaire-export-portable-markdown` ("Export node as portable Markdown…"): opens `ExportModal`
//    to pick mode/crossPackageLinks for *this* export, then writes `<exportFolder>/<id>.md`.
//  - `vaire-copy-node-citation` ("Copy node citation"): `citationFor` to the clipboard, plain text.
//
// The two build paths live in `buildRenderMarkdown`/`buildLocalMarkdown` below, thin wrappers
// around the pure transforms in `src/export/pure.ts` that gather whatever Obsidian-side context
// those transforms need (the CLI render result; the live editor buffer; `LocalIndex` lookups; an
// opportunistic peek at already-cached external names — see `buildKnownExternalNames`).

import * as path from 'node:path';
import { ButtonComponent, MarkdownView, Modal, normalizePath, Notice, Setting, TFile, type Editor } from 'obsidian';
import { resolveMemoKey } from '../cli';
import { todayIso } from '../authoring/supersede-pure';
import type { IdRef } from '../ids';
import type VairePlugin from '../main';
import { absPathOf, resolveLocalRef, type LocalNode, type PackageInfo } from '../packages';
import { nameFromResolveResult } from '../render/pure';
import { confirm } from '../ui/prompt-modal';
import {
  citationFor,
  collectRefs,
  DEFAULT_EXPORT_FOLDER,
  exportFileName,
  exportHeaderComment,
  localPortable,
  postProcessRendered,
  type LocalPortableContext,
} from './pure';
import type { VaireSettings } from '../settings';

type ExportMode = VaireSettings['exportMode'];
type CrossPackageLinks = VaireSettings['crossPackageLinks'];

interface ExportChoice {
  mode: ExportMode;
  crossPackageLinks: CrossPackageLinks;
}

/** Where the export will land, in both "spaces" `buildMarkdown` might need: a vault-relative
 *  directory (local mode's `LocalPortableContext.fromDir`) and its absolute filesystem twin
 *  (render mode's `postProcessRendered` `exportDir`). `null` (from the clipboard commands, which
 *  have nowhere to move the file to) means "keep links relative to the node's own location". */
interface Destination {
  vaultDir: string;
  absDir: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function currentNode(plugin: VairePlugin): { pkg: PackageInfo; node: LocalNode; file: TFile } | null {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return null;
  const pkg = plugin.packages.packageFor(file);
  if (!pkg) return null;
  const node = pkg.index.byFile(file);
  if (!node) return null;
  return { pkg, node, file };
}

/** Vault-relative dirname (`TFile.path` always uses `/`, regardless of platform); `''` for a
 *  root-level file, matching `PackageInfo.dir`'s convention for the vault root. */
function vaultDirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function liveEditorFor(plugin: VairePlugin, file: TFile): Editor | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return view?.file === file ? view.editor : null;
}

/** The file's current text — from the live editor when it's the open file (so local-mode export
 *  sees an unsaved edit), else read from disk. Same recipe as `src/diagnostics/fixes.ts`'s
 *  `currentText`. */
async function currentText(plugin: VairePlugin, file: TFile): Promise<string> {
  const editor = liveEditorFor(plugin, file);
  return editor ? editor.getValue() : plugin.app.vault.read(file);
}

// ---- local mode ------------------------------------------------------------------------------

const PENDING = Symbol('pending');

/** Resolves `p` if it has *already* settled, otherwise returns the `PENDING` sentinel — without
 *  ever waiting on real async work. Standard `Promise.race` trick: an already-settled promise's
 *  reaction is queued (and wins the race) before `Promise.resolve(PENDING)`'s can even be
 *  scheduled if `p` were still pending, since real CLI I/O takes far longer than one microtask
 *  tick. This is what lets local-mode export use a name `plugin.resolveViaCli` already cached
 *  this session without ever triggering (or waiting on) a fresh CLI call — see
 *  `buildKnownExternalNames`. */
async function peekSettled<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([p, Promise.resolve(PENDING)]);
}

/** For every distinct `@pkg/type:id` reference in `refs`: if `plugin.resolveMemo` already has a
 *  *settled* entry for it (i.e. some other feature — rendering, hover preview, ... — resolved it
 *  earlier this session), record its display name. Never calls the CLI itself, matching local
 *  mode's "instant, no CLI" contract (DESIGN.md). */
async function buildKnownExternalNames(
  plugin: VairePlugin,
  pkg: PackageInfo,
  refs: IdRef[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref.pkg || seen.has(ref.full)) continue;
    seen.add(ref.full);
    const memoKey = resolveMemoKey(pkg.absRoot, ref.full);
    const promise = plugin.resolveMemo.get(memoKey);
    if (!promise) continue;
    const settled = await peekSettled(promise);
    if (settled === PENDING || !settled) continue;
    names.set(ref.full, nameFromResolveResult(settled, ref.id));
  }
  return names;
}

/** Resolves `ref` against the vault only — bare id against `pkg`'s own `LocalIndex` (scope-first,
 *  per `resolveLocalRef`), `@pkg/...` against *that* package's `LocalIndex` if it also happens to
 *  be open in this vault. Mirrors `createRefElement`'s documented resolution order (steps 1-2;
 *  step 3, the CLI fallback, is what `buildKnownExternalNames` covers separately and only from
 *  the in-session memo, never a fresh call). */
function resolveLocal(plugin: VairePlugin, pkg: PackageInfo, originScope: string | undefined, ref: IdRef) {
  const target = ref.pkg ? plugin.packages.byName(ref.pkg) : pkg;
  if (!target) return null;
  const local = resolveLocalRef(target, ref, ref.pkg ? undefined : originScope);
  return local ? { path: local.file.path, name: local.name } : null;
}

async function buildLocalMarkdown(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  file: TFile,
  destinationVaultDir: string | null,
): Promise<string> {
  const buffer = await currentText(plugin, file);
  const externalRefs = collectRefs(buffer).filter((r): r is IdRef => r.kind === 'id' && Boolean(r.pkg));
  const knownNames = await buildKnownExternalNames(plugin, pkg, externalRefs);

  const ctx: LocalPortableContext = {
    fromDir: destinationVaultDir ?? vaultDirOf(file.path),
    resolveLocal: (ref) => resolveLocal(plugin, pkg, node.scope, ref),
    knownExternalName: (ref) => knownNames.get(ref.full),
    edgesSection: plugin.settings.exportEdgesSection,
    markUnresolved: true,
  };

  const body = localPortable(buffer, ctx);
  return `${exportHeaderComment(node.full, 'local', todayIso())}\n${body}`;
}

// ---- render mode -----------------------------------------------------------------------------

async function buildRenderMarkdown(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  crossPackageLinks: CrossPackageLinks,
  destinationAbsDir: string | null,
): Promise<string> {
  const result = await plugin.cli.render(pkg.absRoot, node.full);
  const sourceDir = path.dirname(path.join(pkg.absRoot, result.path));
  const processed = postProcessRendered(result.markdown, {
    repo: pkg.absRoot,
    sourcePath: result.path,
    exportDir: destinationAbsDir ?? sourceDir,
    crossPackageLinks,
  });
  return `${exportHeaderComment(node.full, 'render', todayIso())}\n${processed}`;
}

async function buildMarkdown(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  file: TFile,
  choice: ExportChoice,
  destination: Destination | null,
): Promise<string> {
  if (choice.mode === 'render') {
    return buildRenderMarkdown(plugin, pkg, node, choice.crossPackageLinks, destination?.absDir ?? null);
  }
  return buildLocalMarkdown(plugin, pkg, node, file, destination?.vaultDir ?? null);
}

// ---- commands --------------------------------------------------------------------------------

async function copyPortableMarkdown(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, file: TFile): Promise<void> {
  const choice: ExportChoice = { mode: plugin.settings.exportMode, crossPackageLinks: plugin.settings.crossPackageLinks };
  try {
    const markdown = await buildMarkdown(plugin, pkg, node, file, choice, null);
    await navigator.clipboard.writeText(markdown);
    new Notice(`Vairë: copied ${node.full} as portable Markdown (${choice.mode}).`);
  } catch (err) {
    new Notice(`Vairë: could not copy portable Markdown — ${errMessage(err)}`);
  }
}

async function copyCitation(plugin: VairePlugin, node: LocalNode, pkg: PackageInfo): Promise<void> {
  const text = citationFor(node, pkg);
  try {
    await navigator.clipboard.writeText(text);
    new Notice(`Vairë: copied citation — ${text}`);
  } catch {
    new Notice('Vairë: could not copy to the clipboard');
  }
}

/** `Vault.createFolder` throws if the folder already exists and doesn't reliably create
 *  intermediate directories, so walk the path a segment at a time — same recipe as
 *  `graph/export.ts`'s `ensureFolder` (kept as its own tiny copy here to avoid a cross-feature
 *  import for ten lines). */
async function ensureFolder(plugin: VairePlugin, folderPath: string): Promise<void> {
  let current = '';
  for (const part of folderPath.split('/')) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

async function exportToFile(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  file: TFile,
  choice: ExportChoice,
): Promise<void> {
  const folderVaultPath = normalizePath(plugin.settings.exportFolder.trim() || DEFAULT_EXPORT_FOLDER);
  const owningPkg = plugin.packages.packageFor(folderVaultPath);
  if (owningPkg) {
    new Notice(
      `Vairë: the export folder "${folderVaultPath}" is inside package '${owningPkg.name}' — exported files will ` +
        `sit alongside its nodes. Set "Export folder" in Settings → Vairë to a path outside any package root to ` +
        `avoid this.`,
      8000,
    );
  }

  try {
    await ensureFolder(plugin, folderVaultPath);
  } catch (err) {
    new Notice(`Vairë: could not create the export folder "${folderVaultPath}" — ${errMessage(err)}`);
    return;
  }

  const destination: Destination = { vaultDir: folderVaultPath, absDir: absPathOf(plugin.app, folderVaultPath) };

  let markdown: string;
  try {
    markdown = await buildMarkdown(plugin, pkg, node, file, choice, destination);
  } catch (err) {
    new Notice(`Vairë: could not export ${node.full} — ${errMessage(err)}`);
    return;
  }

  const filePath = normalizePath(`${folderVaultPath}/${exportFileName(node.full)}`);
  const existing = plugin.app.vault.getAbstractFileByPath(filePath);

  let target: TFile;
  if (existing instanceof TFile) {
    const overwrite = await confirm(plugin.app, {
      title: 'Overwrite export?',
      message: `${filePath} already exists. Overwrite it?`,
      okLabel: 'Overwrite',
    });
    if (!overwrite) return;
    await plugin.app.vault.modify(existing, markdown);
    target = existing;
  } else if (existing) {
    new Notice(`Vairë: ${filePath} exists and is not a file — pick a different export folder.`);
    return;
  } else {
    target = await plugin.app.vault.create(filePath, markdown);
  }

  await plugin.app.workspace.getLeaf(true).openFile(target);
  new Notice(`Vairë: exported ${node.full} as portable Markdown (${choice.mode}) to ${filePath}`);
}

// ---- the per-export modal (file export only — the copy command just uses current settings) ---

class ExportModal extends Modal {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly node: LocalNode;
  private readonly file: TFile;
  private mode: ExportMode;
  private crossPackageLinks: CrossPackageLinks;

  constructor(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.node = node;
    this.file = file;
    this.mode = plugin.settings.exportMode;
    this.crossPackageLinks = plugin.settings.crossPackageLinks;
  }

  onOpen(): void {
    this.setTitle('Export node as portable Markdown');
    const { contentEl } = this;
    contentEl.empty();

    const summary = contentEl.createDiv({ cls: 'vaire-muted' });
    summary.createEl('code', { cls: 'vaire-nid', text: this.node.full });
    summary.appendText(` — ${this.node.name}`);

    new Setting(contentEl)
      .setName('Mode')
      .setDesc(
        '"Render": the exact vaire render output — every resolvable reference rewritten, but needs an ' +
          'up-to-date index (uncommitted edits not yet indexed are missing). "Local": transforms the current ' +
          'editor buffer using only this vault\'s index — instant, includes unsaved edits, but vault-only.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ render: 'Render (vaire render)', local: 'Local (editor buffer)' })
          .setValue(this.mode)
          .onChange((value) => {
            this.mode = value === 'local' ? 'local' : 'render';
          }),
      );

    new Setting(contentEl)
      .setName('Cross-package links')
      .setDesc(
        'Render mode only — cross-package hrefs are machine-specific filesystem paths. "Keep relative path": ' +
          'rebased to still resolve from the export folder. "Display text only": drop the link. "Name ' +
          '(@pkg/type:id)": replace it with the portable address.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ path: 'Keep relative path', text: 'Display text only', address: 'Name (@pkg/type:id)' })
          .setValue(this.crossPackageLinks)
          .onChange((value) => {
            this.crossPackageLinks = value as CrossPackageLinks;
          }),
      );

    const buttons = contentEl.createDiv({ cls: 'vaire-actions' });
    new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText('Export')
      .setCta()
      .onClick(() => {
        this.close();
        void exportToFile(this.plugin, this.pkg, this.node, this.file, {
          mode: this.mode,
          crossPackageLinks: this.crossPackageLinks,
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function registerExport(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'copy-portable-markdown',
    name: 'Copy node as portable Markdown',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found) return false;
      if (!checking) void copyPortableMarkdown(plugin, found.pkg, found.node, found.file);
      return true;
    },
  });

  plugin.addCommand({
    id: 'export-portable-markdown',
    name: 'Export node as portable Markdown…',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found) return false;
      if (!checking) new ExportModal(plugin, found.pkg, found.node, found.file).open();
      return true;
    },
  });

  plugin.addCommand({
    id: 'copy-node-citation',
    name: 'Copy node citation',
    checkCallback: (checking) => {
      const found = currentNode(plugin);
      if (!found) return false;
      if (!checking) void copyCitation(plugin, found.node, found.pkg);
      return true;
    },
  });
}
