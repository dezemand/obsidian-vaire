// The package index view's Release section: pending release (from `status`) with a Plan
// button running `vaire release --dry-run`, Cut release (opens release-modal.ts), Pack /
// Push, and a Changelog built from this package's `release` nodes. Extracted out of
// package-view.ts per DESIGN.md's "Phase 2 ownership" pattern (see e.g. deps-actions.ts) so
// that file stays readable. Untested directly — it imports `obsidian`, which has no runtime
// outside the app; the logic worth testing lives in src/release/pure.ts.

import { App, ButtonComponent, Notice, SuggestModal, ToggleComponent } from 'obsidian';
import { parseRef } from '../ids';
import type { PackageInfo } from '../packages';
import { openFileAtLine } from '../navigate';
import { createRefElement } from '../render/ref-el';
import type { RegistryEntry, ReleasePlan, StatusResult } from '../types';
import { confirm } from '../ui/prompt-modal';
import type VairePlugin from '../main';
import { compareVersions, describePlan, frontmatterEdgeCount } from './pure';
import { ReleaseModal } from './release-modal';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A release record's `date:` frontmatter, which Obsidian's metadata cache may leave as a
 * plain string or parse into a `Date` — normalized to a plain string either way. */
function formatDate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '—';
}

export function renderReleaseSection(plugin: VairePlugin, pkg: PackageInfo, containerEl: HTMLElement): void {
  const section = containerEl.createDiv({ cls: 'vaire-section vaire-release' });
  section.createEl('h2', { text: 'Release' });

  renderPendingRelease(plugin, pkg, section);
  renderCutRelease(plugin, pkg, section);
  renderPackPush(plugin, pkg, section);
  renderChangelog(plugin, pkg, section);
}

// ---- Pending release + Plan --------------------------------------------------------------

function renderPendingRelease(plugin: VairePlugin, pkg: PackageInfo, root: HTMLElement): void {
  const wrap = root.createDiv({ cls: 'vaire-release-pending' });
  wrap.createEl('h3', { text: 'Pending release' });

  const body = wrap.createDiv();
  body.setText('Loading…');
  plugin.cli
    .status(pkg.absRoot)
    .then((status) => {
      body.empty();
      renderPendingBody(body, status.pending_release);
    })
    .catch((err: unknown) => {
      body.empty();
      body.createDiv({ cls: 'vaire-error', text: `Could not load pending release — ${errMessage(err)}` });
    });

  const actions = wrap.createDiv({ cls: 'vaire-actions vaire-release-plan-actions' });
  const majorLabel = actions.createEl('label', { cls: 'vaire-release-major-toggle' });
  const majorToggle = new ToggleComponent(majorLabel);
  majorLabel.createSpan({ text: 'MAJOR (--major)' });
  new ButtonComponent(actions).setButtonText('Plan').onClick(() => void runPlan());

  const planEl = wrap.createDiv({ cls: 'vaire-release-plan' });

  async function runPlan(): Promise<void> {
    planEl.empty();
    planEl.setText('Planning…');
    try {
      const plan = await plugin.cli.releaseDryRun(pkg.absRoot, { major: majorToggle.getValue() });
      planEl.empty();
      renderPlan(plugin, pkg, planEl, plan);
    } catch (err) {
      planEl.empty();
      planEl.createDiv({ cls: 'vaire-error', text: `Plan failed — ${errMessage(err)}` });
    }
  }
}

function renderPendingBody(body: HTMLElement, pr: StatusResult['pending_release']): void {
  if (!pr) {
    body.createDiv({ cls: 'vaire-empty', text: 'No pending-release information (index not built?).' });
    return;
  }
  const line = body.createDiv({ cls: 'vaire-status-line' });
  line.createSpan({ cls: 'vaire-status-item', text: `since ${pr.since}` });
  line.createSpan({ cls: 'vaire-status-item', text: `would be: ${pr.would_be}` });
  line.createSpan({
    cls: 'vaire-status-item',
    text: `+${pr.added} added · ~${pr.changed} changed · ↓${pr.retired} retired · −${pr.removed} removed`,
  });
}

function renderPlan(plugin: VairePlugin, pkg: PackageInfo, container: HTMLElement, plan: ReleasePlan): void {
  const described = describePlan(plan);
  const header = container.createDiv({ cls: 'vaire-release-plan-header' });
  header.createEl('strong', { text: described.title });
  for (const line of described.lines) header.createDiv({ cls: 'vaire-muted', text: line });

  if (plan.status === 'nothing' || plan.outcome?.kind === 'nothing') return;

  const lists = container.createDiv({ cls: 'vaire-release-lists' });
  renderIdList(plugin, pkg, lists, 'Added', plan.added ?? []);
  renderIdList(plugin, pkg, lists, 'Changed', plan.changed ?? []);
  renderIdList(plugin, pkg, lists, 'Retired', plan.retired ?? []);
  renderIdList(plugin, pkg, lists, 'Removed', plan.removed ?? []);
}

/** Renders one of the plan's four lists as ref elements (entries are bare ids, e.g. `type:id`).
 * A `removed` entry no longer resolves — createRefElement renders that as its normal "missing"
 * state, which is exactly right: the address really is gone (per vaire-versioning). */
function renderIdList(plugin: VairePlugin, pkg: PackageInfo, container: HTMLElement, title: string, ids: string[]): void {
  const wrap = container.createDiv({ cls: 'vaire-release-list' });
  wrap.createEl('h4', { text: `${title} (${ids.length})` });
  if (ids.length === 0) {
    wrap.createDiv({ cls: 'vaire-empty', text: 'None.' });
    return;
  }
  const list = wrap.createDiv({ cls: 'vaire-release-list-items' });
  for (const id of ids) {
    const row = list.createDiv({ cls: 'vaire-release-list-row' });
    const ref = parseRef(id);
    if (ref && ref.kind === 'id') {
      row.appendChild(createRefElement(plugin, ref, { repo: pkg.absRoot }));
    } else {
      row.createEl('code', { cls: 'vaire-nid', text: id });
    }
  }
}

// ---- Cut release ---------------------------------------------------------------------------

function renderCutRelease(plugin: VairePlugin, pkg: PackageInfo, root: HTMLElement): void {
  const wrap = root.createDiv({ cls: 'vaire-release-cut' });
  wrap.createEl('h3', { text: 'Cut release' });
  wrap.createEl('p', {
    cls: 'vaire-muted',
    text: 'Commits and tags this repository with a computed version. Never pushes.',
  });
  const actions = wrap.createDiv({ cls: 'vaire-actions' });
  const releaseBtn = new ButtonComponent(actions).setButtonText('Cut release…').onClick(() => {
    new ReleaseModal(plugin, pkg).open();
  });
  releaseBtn.buttonEl.addClass('mod-warning');
}

// ---- Pack / Push -----------------------------------------------------------------------------

function renderPackPush(plugin: VairePlugin, pkg: PackageInfo, root: HTMLElement): void {
  const wrap = root.createDiv({ cls: 'vaire-release-packpush' });
  wrap.createEl('h3', { text: 'Pack / Push' });

  const actions = wrap.createDiv({ cls: 'vaire-actions' });
  const resultEl = wrap.createDiv({ cls: 'vaire-release-result' });

  new ButtonComponent(actions).setButtonText('Pack').onClick(() => void runPack());
  new ButtonComponent(actions).setButtonText('Push…').onClick(() => void runPush());

  async function runPack(): Promise<void> {
    resultEl.empty();
    new Notice(`Vairë: packing ${pkg.name}…`);
    try {
      const result = await plugin.cli.pack(pkg.absRoot);
      const artifact = typeof result.artifact === 'string' ? result.artifact : undefined;
      if (artifact) {
        new Notice(`Vairë: packed ${pkg.name} → ${artifact}`, 8000);
        resultEl.createDiv({ cls: 'vaire-muted', text: `Artifact: ${artifact}` });
      } else {
        new Notice(`Vairë: pack complete for ${pkg.name}`);
      }
    } catch (err) {
      const message = errMessage(err);
      new Notice(`Vairë: pack failed — ${message}`, 8000);
      resultEl.createDiv({ cls: 'vaire-error', text: `Pack failed — ${message}` });
    }
  }

  async function runPush(): Promise<void> {
    resultEl.empty();
    let registries: RegistryEntry[];
    try {
      registries = (await plugin.cli.registryList()).registries;
    } catch (err) {
      new Notice(`Vairë: could not load registries — ${errMessage(err)}`);
      return;
    }
    if (registries.length === 0) {
      new Notice('Vairë: no registries configured. Add one from the Catalog & registries view.');
      return;
    }

    let chosen: string | null;
    if (registries.length === 1) {
      chosen = registries[0].name;
    } else {
      chosen = await pickRegistry(plugin.app, registries);
    }
    if (!chosen) return;

    const ok = await confirm(plugin.app, {
      title: `Push to '${chosen}'`,
      message: `Upload every release tag of ${pkg.name} that '${chosen}' does not already have?`,
      okLabel: 'Push',
    });
    if (!ok) return;

    new Notice(`Vairë: pushing ${pkg.name} to '${chosen}'…`);
    try {
      await plugin.cli.push(pkg.absRoot, { registry: chosen });
      new Notice(`Vairë: pushed ${pkg.name} to '${chosen}'`);
    } catch (err) {
      const message = errMessage(err);
      new Notice(`Vairë: push to '${chosen}' failed — ${message}`, 8000);
      resultEl.createDiv({ cls: 'vaire-error', text: `Push to '${chosen}' failed — ${message}` });
    }
  }
}

/** Resolves with the chosen registry's name, or `null` if the picker was dismissed. */
function pickRegistry(app: App, registries: RegistryEntry[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    class RegistryPickModal extends SuggestModal<RegistryEntry> {
      getSuggestions(query: string): RegistryEntry[] {
        const q = query.trim().toLowerCase();
        if (!q) return registries;
        return registries.filter((r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
      }

      renderSuggestion(registry: RegistryEntry, el: HTMLElement): void {
        el.createDiv({ text: registry.name });
        el.createEl('small', { text: `${registry.url} · ${registry.kind}` });
      }

      onChooseSuggestion(registry: RegistryEntry): void {
        settle(registry.name);
      }

      onClose(): void {
        this.contentEl.empty();
        settle(null);
      }
    }

    const modal = new RegistryPickModal(app);
    modal.setPlaceholder('Choose a registry to push to…');
    modal.open();
  });
}

// ---- Changelog -------------------------------------------------------------------------------

function renderChangelog(plugin: VairePlugin, pkg: PackageInfo, root: HTMLElement): void {
  const wrap = root.createDiv({ cls: 'vaire-release-changelog' });
  wrap.createEl('h3', { text: 'Changelog' });

  const releases = pkg.index.byType().get('release') ?? [];
  if (releases.length === 0) {
    wrap.createDiv({ cls: 'vaire-empty', text: 'No releases recorded yet.' });
    return;
  }

  const sorted = [...releases].sort((a, b) => compareVersions(b.name, a.name));

  const table = wrap.createEl('table', { cls: 'vaire-deps-table vaire-changelog-table' });
  const headRow = table.createEl('thead').createEl('tr');
  for (const h of ['Version', 'Bump', 'Date', 'Added', 'Changed', 'Retired']) headRow.createEl('th', { text: h });
  const tbody = table.createEl('tbody');

  for (const node of sorted) {
    const tr = tbody.createEl('tr');
    const versionCell = tr.createEl('td');
    const link = versionCell.createEl('a', { cls: 'vaire-node-link', text: node.name, href: '#' });
    link.addEventListener('click', (evt) => {
      evt.preventDefault();
      void openFileAtLine(plugin.app, node.file, undefined, evt.metaKey || evt.ctrlKey);
    });

    const bump = node.frontmatter.bump;
    tr.createEl('td', { text: typeof bump === 'string' ? bump : '—' });
    tr.createEl('td', { text: formatDate(node.frontmatter.date) });
    tr.createEl('td', { text: String(frontmatterEdgeCount(node.frontmatter.added)) });
    tr.createEl('td', { text: String(frontmatterEdgeCount(node.frontmatter.changed)) });
    tr.createEl('td', { text: String(frontmatterEdgeCount(node.frontmatter.retired)) });
  }
}
