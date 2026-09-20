// Impure counterpart to `fixes-pure.ts`: turns a `FixDescriptor` into a real file edit / CLI
// call / modal flow, per the sanctioned fix for each `vaire check` finding kind (the
// `vaire-check-triage` skill; see `fixes-pure.ts`'s header for the verified real finding
// shapes). Offered from three places, all funneled through `applyFix` below:
// - `@codemirror/lint` diagnostic actions (`diagnosticActionsFor`, used by `src/diagnostics/
//   index.ts`'s lint source);
// - buttons on each Findings row in the package view (`src/views/package-view.ts`);
// - the `vaire-fix-finding-at-cursor` command (`registerFixCommand`, called from
//   `registerDiagnostics`).
//
// Every fix that edits a file follows the same shape: locate the file (and, for the two kinds
// whose finding carries no `line` — `frontmatter_wikilink`, and defensively `unknown_type` —
// locate the line too), apply the matching pure transform from `fixes-pure.ts` to that one
// line (live editor when the file is open, else `vault.process`), then `afterEdit` — which is
// `plugin.rebuildIndex(pkg)` followed by `plugin.runCheck(pkg)` unless `settings.checkMode ===
// 'auto'` (an auto-mode rebuild already schedules its own check; see `registerAutoCheck` in
// `src/diagnostics/index.ts`) — so diagnostics/views refresh. A fix that turns out to be a
// no-op (the finding was stale — already fixed, or the line changed underneath it) says so via
// a `Notice` instead of silently doing nothing.

import { MarkdownView, Notice, SuggestModal, TFile, type Editor } from 'obsidian';
import type { Action } from '@codemirror/lint';
import { parseRef } from '../ids';
import { openFileAtLine, openRef } from '../navigate';
import type { PackageInfo } from '../packages';
import { VaireResolveModal } from '../suggest/resolve-modal';
import { VaireSearchModal } from '../suggest/search-modal';
import { linkFromCatalog, pullDependency } from '../views/deps-actions';
import { describeFinding, packageRelativePath, vaultPathFor, type FindingLike } from '../views/pure-pkg';
import {
  addTypeToManifest,
  findManifestDependencyLine,
  fixesFor,
  locateFrontmatterFieldLine,
  refreshDisplayOnLine,
  rewriteRefOnLine,
  stripFrontmatterBrackets,
  toLooseEndOnLine,
  type FixDescriptor,
} from './fixes-pure';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function notice(message: string): void {
  new Notice(`Vairë: ${message}`);
}

/**
 * `fixesFor(finding)` plus, for `dangling_ref`, "Create entity…" when `plugin.hooks.createNode`
 * is wired up (it isn't on this branch — see the hook's doc comment in `main.ts`). This is the
 * one place a `FixDescriptor[]` should be requested from outside this module: every caller
 * (lint actions, Findings-row buttons, the at-cursor command) goes through it so the
 * runtime-dependent action is never missed or duplicated.
 */
export function allFixesFor(plugin: VairePlugin, finding: FindingLike): FixDescriptor[] {
  const fixes = fixesFor(finding);
  if (finding.kind === 'dangling_ref' && plugin.hooks.createNode) {
    fixes.push({ id: 'create-entity', label: 'Create entity…', needs: 'line' });
  }
  return fixes;
}

// ---- shared file/line helpers ---------------------------------------------------------------

function fileFor(plugin: VairePlugin, pkg: PackageInfo, relPath: string): TFile | null {
  const f = plugin.app.vault.getAbstractFileByPath(vaultPathFor(pkg.dir, relPath));
  return f instanceof TFile ? f : null;
}

function liveEditorFor(plugin: VairePlugin, file: TFile): Editor | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return view?.file === file ? view.editor : null;
}

/** The file's current text — from the live editor when it's the open file (so an unsaved edit
 *  is seen), else read from disk. Used to locate a line for kinds whose finding has none. */
async function currentText(plugin: VairePlugin, file: TFile): Promise<string> {
  const editor = liveEditorFor(plugin, file);
  return editor ? editor.getValue() : plugin.app.vault.read(file);
}

/**
 * Applies `transform` to line `line1` (1-based) of `file` — via the live editor when that file
 * is the open one, else `vault.process`. Returns whether the line actually changed; `false`
 * means the transform was a no-op (finding already fixed, or the line no longer matches what
 * the finding expected — never applied blindly).
 */
async function applyLineEdit(
  plugin: VairePlugin,
  file: TFile,
  line1: number,
  transform: (lineText: string) => string,
): Promise<boolean> {
  const idx = line1 - 1;
  const liveEditor = liveEditorFor(plugin, file);

  if (liveEditor) {
    if (idx < 0 || idx >= liveEditor.lineCount()) return false;
    const original = liveEditor.getLine(idx);
    const next = transform(original);
    if (next === original) return false;
    liveEditor.setLine(idx, next);
    return true;
  }

  let changed = false;
  await plugin.app.vault.process(file, (data) => {
    const lines = data.split('\n');
    if (idx < 0 || idx >= lines.length) return data;
    const original = lines[idx];
    const next = transform(original);
    if (next === original) return data;
    lines[idx] = next;
    changed = true;
    return lines.join('\n');
  });
  return changed;
}

/**
 * Applies `transform` to the whole of `file` — via the live editor when that file is the open
 * one (so an in-progress unsaved edit isn't clobbered by a `vault.process` read of the stale
 * on-disk copy), else `vault.process`. Returns whether anything changed. Used for
 * `knowledge.toml` edits (`addTypeToManifest`), which rewrite a whole array rather than one line.
 */
async function applyFileEdit(plugin: VairePlugin, file: TFile, transform: (text: string) => string): Promise<boolean> {
  const liveEditor = liveEditorFor(plugin, file);
  if (liveEditor) {
    const original = liveEditor.getValue();
    const next = transform(original);
    if (next === original) return false;
    const cursor = liveEditor.getCursor();
    liveEditor.setValue(next);
    liveEditor.setCursor(cursor);
    return true;
  }

  let changed = false;
  await plugin.app.vault.process(file, (data) => {
    const next = transform(data);
    changed = next !== data;
    return next;
  });
  return changed;
}

/** `plugin.rebuildIndex(pkg)`, then re-run check unless auto mode already schedules one — the
 *  "after any file edit" step every fix in the triage table ends with. */
async function afterEdit(plugin: VairePlugin, pkg: PackageInfo): Promise<void> {
  await plugin.rebuildIndex(pkg);
  await maybeRunCheck(plugin, pkg);
}

/** Re-runs check unless `checkMode === 'auto'` (where the index rebuild just triggered already
 *  schedules one — see `registerAutoCheck`). Used after dependency actions (`linkFromCatalog`/
 *  `pullDependency`/`cli.add`), which already rebuild the index themselves. */
async function maybeRunCheck(plugin: VairePlugin, pkg: PackageInfo): Promise<void> {
  if (plugin.settings.checkMode === 'auto') return;
  try {
    await plugin.runCheck(pkg, plugin.settings.checkStrict);
  } catch (err) {
    notice(`re-running check failed — ${errMessage(err)}`);
  }
}

// ---- dangling_ref ---------------------------------------------------------------------------

async function fixDanglingRefResolve(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const to = str(finding.to);
  const path = str(finding.path);
  const line = num(finding.line);
  if (!to || !path || line == null) return notice('this finding is missing to/path/line');
  const ref = parseRef(to);
  if (!ref || ref.kind !== 'id') return notice(`could not parse target '${to}'`);
  const file = fileFor(plugin, pkg, path);
  if (!file) return notice(`file not found: ${path}`);

  new VaireResolveModal(plugin, pkg, ref.id, ref.type, (candidate) => {
    void (async () => {
      const changed = await applyLineEdit(plugin, file, line, (l) => rewriteRefOnLine(l, to, candidate.id));
      if (!changed) return notice('that reference has changed — could not resolve it');
      notice(`resolved to ${candidate.id}`);
      await afterEdit(plugin, pkg);
    })();
  }).open();
}

async function fixDanglingRefLooseEnd(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const to = str(finding.to);
  const path = str(finding.path);
  const line = num(finding.line);
  if (!to || !path || line == null) return notice('this finding is missing to/path/line');
  const file = fileFor(plugin, pkg, path);
  if (!file) return notice(`file not found: ${path}`);

  const changed = await applyLineEdit(plugin, file, line, (l) => toLooseEndOnLine(l, to));
  if (!changed) return notice('that reference has changed — could not turn it into a loose end');
  notice('turned into a loose end');
  await afterEdit(plugin, pkg);
}

async function fixDanglingRefCreateEntity(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const hook = plugin.hooks.createNode;
  if (!hook) return; // unreachable via allFixesFor, which only offers this when the hook exists
  const to = str(finding.to);
  const path = str(finding.path);
  const line = num(finding.line);
  if (!to || !path || line == null) return notice('this finding is missing to/path/line');
  const ref = parseRef(to);
  if (!ref || ref.kind !== 'id') return notice(`could not parse target '${to}'`);
  const file = fileFor(plugin, pkg, path);
  if (!file) return notice(`file not found: ${path}`);

  const created = await hook({ pkg, type: ref.type, descriptor: ref.id });
  if (!created) return; // cancelled

  const changed = await applyLineEdit(plugin, file, line, (l) => rewriteRefOnLine(l, to, created.id));
  if (!changed) return notice('that reference has changed — the new entity was created, but could not be linked here');
  notice(`created and linked ${created.id}`);
  await afterEdit(plugin, pkg);
}

// ---- frontmatter_wikilink ---------------------------------------------------------------------

async function fixStripFrontmatterBrackets(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const path = str(finding.path);
  const field = str(finding.field);
  if (!path || !field) return notice('this finding is missing path/field');
  const file = fileFor(plugin, pkg, path);
  if (!file) return notice(`file not found: ${path}`);

  const text = await currentText(plugin, file);
  const line1 = locateFrontmatterFieldLine(text, field);
  if (line1 == null) return notice(`could not find frontmatter field '${field}' (may already be fixed)`);

  const changed = await applyLineEdit(plugin, file, line1, (l) => stripFrontmatterBrackets(l));
  if (!changed) return notice('no brackets to strip there (may already be fixed)');
  notice('stripped the [[ ]] brackets');
  await afterEdit(plugin, pkg);
}

// ---- unknown_type -----------------------------------------------------------------------------

async function fixAddTypeToManifest(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const value = str(finding.value);
  const ref = value ? parseRef(value) : null;
  const type = ref?.kind === 'id' ? ref.type : undefined;
  if (!type) return notice(`could not determine a type from '${value ?? '?'}'`);

  const manifestFile = fileFor(plugin, pkg, 'knowledge.toml');
  if (!manifestFile) return notice('knowledge.toml not found');

  const changed = await applyFileEdit(plugin, manifestFile, (data) => addTypeToManifest(data, type));
  if (!changed) return notice(`'${type}' is already declared in knowledge.toml`);
  notice(`added type '${type}' to knowledge.toml`);
  await afterEdit(plugin, pkg);
}

// ---- orphan -------------------------------------------------------------------------------

async function fixOrphanOpenNode(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const id = str(finding.id);
  const path = str(finding.path);
  const file = (id && pkg.index.get(id)?.file) ?? (path ? fileFor(plugin, pkg, path) : null);
  if (!file) return notice('node file not found');
  await openFileAtLine(plugin.app, file);
}

function fixOrphanFindReferences(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): void {
  const id = str(finding.id);
  const node = id ? pkg.index.get(id) : null;
  const query = node?.name ?? id ?? '';
  new VaireSearchModal(plugin, pkg, query).open();
}

// ---- missing_dependency -----------------------------------------------------------------------

async function fixMissingDepLinkFromCatalog(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const name = str(finding.package);
  if (!name) return notice('this finding is missing package');
  const changed = await linkFromCatalog(plugin, pkg, name); // already rebuilds the index on success
  if (changed) await maybeRunCheck(plugin, pkg);
}

async function fixMissingDepPull(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const name = str(finding.package);
  if (!name) return notice('this finding is missing package');
  const changed = await pullDependency(plugin, pkg, name); // already rebuilds the index on success
  if (changed) await maybeRunCheck(plugin, pkg);
}

// ---- drift --------------------------------------------------------------------------------

async function fixDriftRefresh(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const to = str(finding.to);
  const path = str(finding.path);
  const line = num(finding.line);
  if (!to || !path || line == null) return notice('this finding is missing to/path/line');
  if (to.startsWith('@')) {
    return notice("can't refresh a cross-package target's display text from the local index — use Open target");
  }
  const target = pkg.index.get(to);
  if (!target) return notice(`'${to}' not found in the local index`);
  const file = fileFor(plugin, pkg, path);
  if (!file) return notice(`file not found: ${path}`);

  const changed = await applyLineEdit(plugin, file, line, (l) => refreshDisplayOnLine(l, to, target.name));
  if (!changed) return notice('nothing to refresh there (no |display text, or it already matches)');
  notice(`refreshed display text to '${target.name}'`);
  await afterEdit(plugin, pkg);
}

async function fixDriftOpenTarget(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const to = str(finding.to);
  if (!to) return notice('this finding is missing to');
  const ref = parseRef(to);
  if (!ref) return notice(`could not parse '${to}'`);
  await openRef(plugin, ref, pkg);
}

// ---- unused_dependency ------------------------------------------------------------------------

async function fixOpenManifestAtDependency(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const name = str(finding.package);
  const manifestFile = fileFor(plugin, pkg, 'knowledge.toml');
  if (!manifestFile) return notice('knowledge.toml not found');

  let line: number | undefined;
  if (name) {
    const text = await currentText(plugin, manifestFile);
    line = findManifestDependencyLine(text, name) ?? undefined;
  }
  await openFileAtLine(plugin.app, manifestFile, line != null ? line - 1 : undefined);
}

// ---- dependency_version_mismatch ---------------------------------------------------------------

async function fixDependencyVersionMismatchPull(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const name = str(finding.package);
  if (!name) return notice('this finding is missing package');
  const changed = await pullDependency(plugin, pkg, name); // already rebuilds the index on success
  if (changed) await maybeRunCheck(plugin, pkg);
}

// ---- undeclared_import ------------------------------------------------------------------------

async function fixDeclareDependency(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const name = str(finding.package);
  if (!name) return notice('this finding is missing package');
  notice(`declaring '${name}'…`);
  try {
    await plugin.cli.add(pkg.absRoot, name);
  } catch (err) {
    return notice(`declaring '${name}' failed — ${errMessage(err)}`);
  }
  notice(`declared '${name}'`);
  await afterEdit(plugin, pkg); // rebuild picks up the manifest edit `cli.add` just made
}

// ---- duplicate_id -----------------------------------------------------------------------------

async function fixOpenBoth(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Promise<void> {
  const rawPaths = finding.paths;
  const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === 'string') : [];
  if (paths.length === 0) return notice('this finding has no file paths');

  let opened = 0;
  for (const p of paths) {
    const file = fileFor(plugin, pkg, p);
    if (!file) continue;
    await openFileAtLine(plugin.app, file, undefined, opened > 0);
    opened++;
  }
  if (opened === 0) return notice('none of the duplicate files could be found');
  notice("two files share this id — keep the better one; give the other 'superseded_by: <winner>' (never delete it)");
}

// ---- dispatch -----------------------------------------------------------------------------

/** Turns one `(finding, fixId)` pair — as offered by `allFixesFor` — into the real action. */
export async function applyFix(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike, fixId: string): Promise<void> {
  const key = `${finding.kind}:${fixId}`;
  switch (key) {
    case 'dangling_ref:resolve':
      return fixDanglingRefResolve(plugin, pkg, finding);
    case 'dangling_ref:loose-end':
      return fixDanglingRefLooseEnd(plugin, pkg, finding);
    case 'dangling_ref:create-entity':
      return fixDanglingRefCreateEntity(plugin, pkg, finding);
    case 'frontmatter_wikilink:strip-brackets':
      return fixStripFrontmatterBrackets(plugin, pkg, finding);
    case 'unknown_type:add-type':
      return fixAddTypeToManifest(plugin, pkg, finding);
    case 'orphan:open-node':
      return fixOrphanOpenNode(plugin, pkg, finding);
    case 'orphan:find-references':
      fixOrphanFindReferences(plugin, pkg, finding);
      return;
    case 'missing_dependency:link-from-catalog':
      return fixMissingDepLinkFromCatalog(plugin, pkg, finding);
    case 'missing_dependency:pull':
      return fixMissingDepPull(plugin, pkg, finding);
    case 'drift:refresh-display':
      return fixDriftRefresh(plugin, pkg, finding);
    case 'drift:open-target':
      return fixDriftOpenTarget(plugin, pkg, finding);
    case 'unused_dependency:open-manifest':
      return fixOpenManifestAtDependency(plugin, pkg, finding);
    case 'dependency_version_mismatch:pull':
      return fixDependencyVersionMismatchPull(plugin, pkg, finding);
    case 'undeclared_import:declare-dependency':
      return fixDeclareDependency(plugin, pkg, finding);
    case 'duplicate_id:open-both':
      return fixOpenBoth(plugin, pkg, finding);
    default:
      notice(`no such quick fix (${key})`);
  }
}

/** `Diagnostic.actions` for one finding — used by `src/diagnostics/index.ts`'s lint source,
 *  appended after its own "Open in package index" action. */
export function diagnosticActionsFor(plugin: VairePlugin, pkg: PackageInfo, finding: FindingLike): Action[] {
  return allFixesFor(plugin, finding).map((fix) => ({
    name: fix.label,
    apply: () => void applyFix(plugin, pkg, finding, fix.id),
  }));
}

// ---- "Fix check finding at cursor" command ---------------------------------------------------

interface FixOption {
  finding: FindingLike;
  fix: FixDescriptor;
}

class FixPickerModal extends SuggestModal<FixOption> {
  private readonly options: FixOption[];
  private readonly onPick: (option: FixOption) => void;

  constructor(plugin: VairePlugin, options: FixOption[], onPick: (option: FixOption) => void) {
    super(plugin.app);
    this.options = options;
    this.onPick = onPick;
    this.setPlaceholder('Choose a quick fix…');
  }

  getSuggestions(query: string): FixOption[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.options;
    return this.options.filter((o) => {
      const title = describeFinding(o.finding).title.toLowerCase();
      return title.includes(q) || o.fix.label.toLowerCase().includes(q);
    });
  }

  renderSuggestion(option: FixOption, el: HTMLElement): void {
    const item = el.createDiv({ cls: 'vaire-suggest-item' });
    item.createSpan({ cls: 'vaire-suggest-name', text: option.fix.label });
    item.createEl('code', { cls: 'vaire-suggest-id', text: describeFinding(option.finding).title });
  }

  onChooseSuggestion(option: FixOption): void {
    this.onPick(option);
  }
}

/** Findings at `relPath`:`line1` (1-based) across both violations and warnings, in the order
 *  `vaire check` returned them (violations first). Mirrors `findingsInRange`'s path/line match
 *  but keyed to one exact line (a command target, not a whole-document sweep), so it isn't
 *  worth sharing the filter with `src/diagnostics/pure.ts`. */
function findingsAtLine(findings: FindingLike[], relPath: string, line1: number): FindingLike[] {
  return findings.filter((f) => f.path === relPath && f.line === line1);
}

export function registerFixCommand(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'fix-finding-at-cursor',
    name: 'Fix check finding at cursor',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!file || !pkg) return false;
      const result = plugin.lastCheck.get(pkg.absRoot);
      if (!result) return false;

      const relPath = packageRelativePath(file.path, pkg.dir);
      const cursorLine1 = editor.getCursor().line + 1;
      const findings = [...result.violations, ...result.warnings] as unknown as FindingLike[];
      const atCursor = findingsAtLine(findings, relPath, cursorLine1);
      const options: FixOption[] = atCursor.flatMap((finding) =>
        allFixesFor(plugin, finding).map((fix) => ({ finding, fix })),
      );
      if (options.length === 0) return false;

      if (!checking) {
        if (options.length === 1) {
          void applyFix(plugin, pkg, options[0].finding, options[0].fix.id);
        } else {
          new FixPickerModal(plugin, options, (o) => void applyFix(plugin, pkg, o.finding, o.fix.id)).open();
        }
      }
      return true;
    },
  });
}
