// Inline `vaire check` diagnostics: an underline + gutter marker + hover tooltip on the
// offending line of the active file (CM6, via @codemirror/lint), plus a status-bar item
// summarizing the active package's last check. See DESIGN.md "Wave 1" / `feat/check-diagnostics`
// and "CLI contract nuances" (finding shapes, `check` exit code 6 is a normal outcome).
//
// Two operating modes (`plugin.settings.checkMode`):
// - 'manual' (default): diagnostics reflect whatever is in `plugin.lastCheck`, updated only by
//   the "Run check" command and the package view's Check button. Zero extra CLI calls.
// - 'auto': after every successful auto-index (`index-rebuilt`), also run `plugin.runCheck`
//   (debounced 1s per package, never concurrently) so diagnostics stay fresh without a manual
//   step — at the cost of one extra `vaire check` process per package per debounced save.
//
// `plugin.runCheck` triggers `'check-completed'` on success; that's what tells the CM6
// extensions (already mounted per editor) and the status bar to recompute. The lint *source*
// itself is cheap (no CLI call) — it just reads `plugin.lastCheck`, already-in-memory — so
// `forceLinting` after a check is inexpensive even across many open panes.

import { editorInfoField, MarkdownView, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { forceLinting, linter, lintGutter, type Diagnostic, type LintSource } from '@codemirror/lint';
import { computeLineDiagnostics, findingsInRange, type FindingWithSeverity } from './pure';
import { diagnosticActionsFor, registerFixCommand } from './fixes';
import { packageRelativePath } from '../views/pure-pkg';
import { openPackageIndex } from '../views/package-node';
import type { CheckResult } from '../types';
import type { PackageInfo } from '../packages';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cmOf(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

function activeFilePackage(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  return file ? plugin.packages.packageFor(file) : null;
}

/** Every markdown editor's diagnostics come from the same in-memory `plugin.lastCheck` map, so
 * a check completing anywhere just needs every open markdown view's linter forced to re-run. */
function refreshAllMarkdownLinters(plugin: VairePlugin): void {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    const cm = cmOf(view);
    if (cm) forceLinting(cm);
  }
}

function findingsWithSeverity(result: CheckResult): FindingWithSeverity[] {
  const violations = result.violations.map((f): FindingWithSeverity => ({ ...f, severity: 'error' }));
  const warnings = result.warnings.map((f): FindingWithSeverity => ({ ...f, severity: 'warning' }));
  return [...violations, ...warnings];
}

function makeLintSource(plugin: VairePlugin): LintSource {
  return (view): Diagnostic[] => {
    const file = view.state.field(editorInfoField, false)?.file;
    if (!(file instanceof TFile)) return [];
    const pkg = plugin.packages.packageFor(file);
    if (!pkg) return [];
    const result = plugin.lastCheck.get(pkg.absRoot);
    if (!result) return [];

    const relPath = packageRelativePath(file.path, pkg.dir);
    const rangeInput = { lines: view.state.doc.lines, findings: findingsWithSeverity(result), relPath };
    const lineDiagnostics = computeLineDiagnostics(rangeInput);
    // Index-aligned with `lineDiagnostics` (same filter, same source order — see
    // `findingsInRange`'s doc comment) so `matchedFindings[i]` is the finding `lineDiagnostics[i]`
    // was built from, letting quick-fix actions be attached per diagnostic.
    const matchedFindings = findingsInRange(rangeInput);

    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < lineDiagnostics.length; i++) {
      const d = lineDiagnostics[i];
      const finding = matchedFindings[i];
      const lineNumber = Math.min(Math.max(d.line, 1), view.state.doc.lines); // defensive; already in range
      const docLine = view.state.doc.line(lineNumber);
      diagnostics.push({
        from: docLine.from,
        to: docLine.to,
        severity: d.severity,
        message: d.message,
        source: 'vaire check',
        actions: [
          {
            name: 'Open in package index',
            apply: () => void openPackageIndex(plugin, pkg.dir),
          },
          ...diagnosticActionsFor(plugin, pkg, finding),
        ],
      });
    }
    return diagnostics;
  };
}

function registerLintExtension(plugin: VairePlugin): void {
  plugin.registerEditorExtension([linter(makeLintSource(plugin), { delay: 500 }), lintGutter()]);
}

// ---- Status bar -----------------------------------------------------------------------------

function renderStatusBar(plugin: VairePlugin, item: HTMLElement): void {
  const pkg = activeFilePackage(plugin);
  item.removeClass('vaire-status-error', 'vaire-status-warn', 'vaire-status-ok', 'is-hidden');

  if (!pkg) {
    item.addClass('is-hidden');
    item.empty();
    return;
  }

  const result = plugin.lastCheck.get(pkg.absRoot);
  if (!result) {
    item.setText('vaire');
    item.setAttr('aria-label', `Vairë (${pkg.name}): no check run yet — click to open the package index`);
    return;
  }

  if (result.violations.length > 0) {
    item.addClass('vaire-status-error');
    item.setText(`✗ ${result.violations.length}`);
  } else if (result.warnings.length > 0) {
    item.addClass('vaire-status-warn');
    item.setText(`⚠ ${result.warnings.length}`);
  } else {
    item.addClass('vaire-status-ok');
    item.setText('✓ vaire');
  }
  item.setAttr(
    'aria-label',
    `Vairë check (${pkg.name}): ${result.violations.length} violation(s), ${result.warnings.length} warning(s) — click to open the package index`,
  );
}

function registerStatusBar(plugin: VairePlugin): void {
  const item = plugin.addStatusBarItem();
  item.addClass('vaire-status-bar-check');
  item.addEventListener('click', () => {
    const pkg = activeFilePackage(plugin);
    if (pkg) void openPackageIndex(plugin, pkg.dir);
  });

  const update = (): void => renderStatusBar(plugin, item);
  update();

  plugin.registerEvent(plugin.app.workspace.on('file-open', update));
  plugin.registerEvent(plugin.events.on('check-completed', update));
  plugin.registerEvent(plugin.events.on('index-rebuilt', update));
}

// ---- Auto mode: run check after a successful auto-index -------------------------------------

const AUTO_CHECK_DELAY_MS = 1000;

function registerAutoCheck(plugin: VairePlugin): void {
  const timers = new Map<string, number>();
  const running = new Set<string>();
  const pending = new Set<string>();
  const lastError = new Map<string, string>();

  const runOnce = async (pkg: PackageInfo): Promise<void> => {
    running.add(pkg.absRoot);
    try {
      await plugin.runCheck(pkg, plugin.settings.checkStrict);
      lastError.delete(pkg.absRoot);
    } catch (err) {
      const message = errMessage(err);
      // Surface a distinct failure (e.g. `index_not_built`) once, not on every auto-index —
      // auto-index can fire repeatedly while the underlying problem persists.
      if (lastError.get(pkg.absRoot) !== message) {
        lastError.set(pkg.absRoot, message);
        new Notice(`Vairë: auto-check failed for ${pkg.name} — ${message}`);
      }
    } finally {
      running.delete(pkg.absRoot);
      if (pending.delete(pkg.absRoot)) void runOnce(pkg);
    }
  };

  const trigger = (pkg: PackageInfo): void => {
    if (running.has(pkg.absRoot)) {
      pending.add(pkg.absRoot);
      return;
    }
    void runOnce(pkg);
  };

  const schedule = (pkg: PackageInfo): void => {
    const existing = timers.get(pkg.absRoot);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      timers.delete(pkg.absRoot);
      trigger(pkg);
    }, AUTO_CHECK_DELAY_MS);
    timers.set(pkg.absRoot, timer);
  };

  plugin.registerEvent(
    plugin.events.on('index-rebuilt', (root) => {
      if (plugin.settings.checkMode !== 'auto') return;
      const pkg = plugin.packages.all().find((p) => p.absRoot === root);
      if (pkg) schedule(pkg);
    }),
  );

  plugin.register(() => {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  });
}

export function registerDiagnostics(plugin: VairePlugin): void {
  registerLintExtension(plugin);
  registerStatusBar(plugin);
  registerAutoCheck(plugin);
  registerFixCommand(plugin);
  plugin.registerEvent(plugin.events.on('check-completed', () => refreshAllMarkdownLinters(plugin)));
}
