// The package index view's Updates section: "Check for updates" (a `vaire pull --dry-run`
// summary of what would be fetched/replaced, per dependency), Update (per dependency / all),
// Pin / Unpin, "Reproduce lockfile" and "Clean store…". Extracted out of package-view.ts per
// DESIGN.md's "Phase 2 ownership" pattern (see e.g. deps-actions.ts, release/section.ts) so that
// file stays readable. Untested directly — it imports `obsidian`; the logic worth testing lives
// in src/updates/pure.ts (tests/updates.test.ts).

import { ButtonComponent } from 'obsidian';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flattenDeps } from '../deps';
import type { PackageInfo } from '../packages';
import {
  cleanStore,
  peekCachedUpdates,
  pinDependency,
  reproduceLockfile,
  runUpdatesCheck,
  unpinDependency,
  updateAllDependencies,
  updateDependency,
} from './index';
import { lockfilePins, mergeDepsWithUpdates, type MergedDependencyRow, type ParsedPullDryRun } from './pure';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `<pkg.absRoot>/knowledge.lock`'s pinned entries, or `[]` if the file is missing/unreadable —
 *  `lockfilePins` (src/updates/pure.ts) already tolerates a malformed one. */
function readLockfilePins(pkg: PackageInfo): Set<string> {
  try {
    const text = fs.readFileSync(path.join(pkg.absRoot, 'knowledge.lock'), 'utf8');
    return new Set(lockfilePins(text).map((p) => p.name));
  } catch {
    return new Set();
  }
}

export function renderUpdatesSection(plugin: VairePlugin, pkg: PackageInfo, containerEl: HTMLElement): void {
  const section = containerEl.createDiv({ cls: 'vaire-section vaire-updates' });
  const headerRow = section.createDiv({ cls: 'vaire-section-header-row' });
  headerRow.createEl('h2', { text: 'Updates' });

  const actions = headerRow.createDiv({ cls: 'vaire-actions vaire-actions-inline' });
  const body = section.createDiv({ cls: 'vaire-updates-body' });

  let lastParsed: ParsedPullDryRun | null = peekCachedUpdates(pkg.absRoot);

  new ButtonComponent(actions).setButtonText('Check for updates').onClick(() => void runCheck());
  new ButtonComponent(actions).setButtonText('Update all').onClick(() => void runUpdateAll());
  new ButtonComponent(actions)
    .setButtonText('Reproduce lockfile')
    .onClick(() => void reproduceLockfile(plugin, pkg)); // rebuildIndex on success re-renders the whole view (index-rebuilt)
  new ButtonComponent(actions).setButtonText('Clean store…').onClick(() => void cleanStore(plugin, pkg));

  async function runCheck(): Promise<void> {
    body.empty();
    body.setText('Checking for updates…');
    const outcome = await runUpdatesCheck(plugin, pkg, { force: true });
    if (outcome.error) {
      lastParsed = null;
      renderBody({ callError: outcome.error });
      return;
    }
    lastParsed = outcome.parsed ?? null;
    renderBody({});
  }

  async function runUpdateAll(): Promise<void> {
    let parsed = lastParsed;
    if (!parsed) {
      body.empty();
      body.setText('Checking for updates…');
      const outcome = await runUpdatesCheck(plugin, pkg, { force: true });
      if (outcome.error) {
        renderBody({ callError: outcome.error });
        return;
      }
      parsed = outcome.parsed ?? null;
      lastParsed = parsed;
    }
    const names = parsed?.updates.map((u) => u.name) ?? [];
    await updateAllDependencies(plugin, pkg, names); // rebuildIndex on success re-renders the whole view
  }

  async function onUpdate(name: string): Promise<void> {
    const changed = await updateDependency(plugin, pkg, name);
    if (changed) lastParsed = null; // stale now — rebuildIndex's re-render will show a fresh check placeholder
  }

  async function onPin(name: string, version: string): Promise<void> {
    const changed = await pinDependency(plugin, pkg, name, version);
    if (changed) renderBody({});
  }

  async function onUnpin(name: string): Promise<void> {
    const changed = await unpinDependency(plugin, pkg, name);
    if (changed) renderBody({});
  }

  function renderBody(opts: { callError?: { kind: string; message: string } }): void {
    body.empty();

    if (opts.callError) {
      const err = body.createDiv({ cls: 'vaire-error vaire-updates-call-error' });
      const label = opts.callError.kind === 'registry' ? 'Registry error' : 'Check failed';
      err.setText(`${label} — ${opts.callError.message}`);
    }

    void loadAndRender();
  }

  async function loadAndRender(): Promise<void> {
    let rows: Array<{ name: string; version?: string }>;
    try {
      const deps = await plugin.cli.deps(pkg.absRoot);
      rows = flattenDeps(deps, pkg.absRoot)
        .filter((r) => r.depth === 1)
        .map((r) => ({ name: r.name, version: r.version }));
    } catch (err) {
      const existing = body.querySelector('.vaire-updates-table-wrap');
      if (existing) existing.remove();
      body.createDiv({ cls: 'vaire-error', text: `Could not load dependencies — ${errMessage(err)}` });
      return;
    }

    const existing = body.querySelector('.vaire-updates-table-wrap');
    if (existing) existing.remove();

    const wrap = body.createDiv({ cls: 'vaire-updates-table-wrap' });

    if (rows.length === 0) {
      wrap.createDiv({ cls: 'vaire-empty', text: 'No dependencies declared.' });
      return;
    }

    const pinnedFromLockfile = readLockfilePins(pkg);
    const pinnedFromSettings = new Set(plugin.settings.pinnedDependencies[pkg.absRoot] ?? []);
    const lockfileExposesAny = pinnedFromLockfile.size > 0;

    const merged: MergedDependencyRow[] = lastParsed
      ? mergeDepsWithUpdates(rows, lastParsed)
      : rows.map((r) => ({ name: r.name, current: r.version }));

    if (!lastParsed) {
      wrap.createDiv({
        cls: 'vaire-empty',
        text: "Click 'Check for updates' to see what's available (queries the configured registries).",
      });
    } else if (lastParsed.errors.filter((e) => !e.package).length > 0) {
      // Errors not tied to a specific dependency (rare — most captured errors name a package).
      for (const err of lastParsed.errors.filter((e) => !e.package)) {
        const row = wrap.createDiv({ cls: 'vaire-error vaire-updates-registry-error' });
        row.setText(err.registry ? `Registry '${err.registry}' — ${err.message}` : err.message);
      }
    }

    const table = wrap.createEl('table', { cls: 'vaire-deps-table vaire-updates-table' });
    const headRow = table.createEl('thead').createEl('tr');
    for (const h of ['', 'Name', 'Current', 'Available', '']) headRow.createEl('th', { text: h });
    const tbody = table.createEl('tbody');

    for (const row of merged) {
      const tr = tbody.createEl('tr');
      const pinned = pinnedFromLockfile.has(row.name) || pinnedFromSettings.has(row.name);
      const lockCell = tr.createEl('td', { cls: 'vaire-updates-lock-cell' });
      if (pinned) {
        const source = pinnedFromLockfile.has(row.name) ? 'pinned (from knowledge.lock)' : 'pinned (remembered by this plugin — not found in knowledge.lock)';
        lockCell.createSpan({ cls: 'vaire-pin-icon', text: '🔒', attr: { 'aria-label': source, title: source } });
      }

      tr.createEl('td', { text: row.name });
      tr.createEl('td', { text: row.current ?? '—' });

      const availCell = tr.createEl('td', { cls: 'vaire-updates-available-cell' });
      if (row.error) {
        availCell.createSpan({ cls: 'vaire-error', text: row.error });
      } else if (row.available) {
        availCell.createSpan({ text: row.current && row.current !== row.available ? `${row.current} → ${row.available}` : row.available });
        if (row.citedChanges && row.citedChanges.length > 0) {
          const cited = availCell.createDiv({ cls: 'vaire-updates-cited' });
          cited.createSpan({ cls: 'vaire-muted', text: `Cites: ${row.citedChanges.join(', ')}` });
        }
      } else if (lastParsed) {
        availCell.createSpan({ cls: 'vaire-muted', text: 'up to date' });
      } else {
        availCell.setText('—');
      }

      const actionsCell = tr.createEl('td', { cls: 'vaire-dep-actions' });
      const rowActions = actionsCell.createDiv({ cls: 'vaire-actions vaire-actions-inline' });
      if (row.available) {
        new ButtonComponent(rowActions).setButtonText('Update').onClick(() => void onUpdate(row.name));
      }
      if (pinned) {
        new ButtonComponent(rowActions).setButtonText('Unpin').onClick(() => void onUnpin(row.name));
      } else if (row.current) {
        new ButtonComponent(rowActions).setButtonText('Pin').onClick(() => void onPin(row.name, row.current!));
      }
    }

    if (lastParsed && !lockfileExposesAny && (pinnedFromSettings.size > 0 || merged.some((r) => pinnedFromSettings.has(r.name)))) {
      wrap.createDiv({
        cls: 'vaire-muted vaire-updates-pin-note',
        text: "knowledge.lock doesn't expose pin state in a shape this plugin recognizes — pinned rows above reflect only pins made from here.",
      });
    }
  }

  renderBody({});
}
