// Node panel's History section (BRANCHES.md `feat/node-history`): "how has this node changed?",
// answered from two switchable sources — `settings.historySource`. Called from node-view.ts,
// right below Backlinks. Untested directly (imports `obsidian`); the logic worth testing lives
// in src/history/pure.ts (see tests/history.test.ts).

import { parseRef } from '../ids';
import type { LocalNode, PackageInfo } from '../packages';
import { createRefElement } from '../render/ref-el';
import { compareVersions } from '../release/pure';
import { packageRelativePath } from '../views/pure-pkg';
import type VairePlugin from '../main';
import { openDiffModal } from './diff-modal';
import { gitLog, gitStatus, isGitRepo } from './git';
import { relativeDate, releaseTouches, type GitLogEntry, type ReleaseTouchKind } from './pure';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Renders the whole History section (heading + whichever sub-section(s) `settings.historySource`
 *  selects) into `containerEl`. Adds the `vaire-history` class the "Show node history" command
 *  (src/history/index.ts) scrolls to. */
export function renderHistorySection(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, containerEl: HTMLElement): void {
  const section = containerEl.createDiv({ cls: 'vaire-section vaire-history' });
  section.createEl('h2', { text: 'History' });

  const source = plugin.settings.historySource;
  const both = source === 'both';
  if (source === 'releases' || both) renderReleaseHistory(plugin, pkg, node, section, both);
  if (source === 'git' || both) renderGitHistory(plugin, pkg, node, section, both);
}

// ---- Releases source ------------------------------------------------------------------------

interface ReleaseRow {
  /** Full id of the release record, e.g. `release:0-3-0` — used both to resolve/open it and as
   *  the de-dupe key. */
  id: string;
  /** Display version, e.g. `0.3.0` (the release node's own display name when resolvable). */
  version: string;
  bump?: string;
  date?: string;
  kind: ReleaseTouchKind;
}

const TOUCH_LABELS: Record<ReleaseTouchKind, string> = { added: 'Added', changed: 'Changed', retired: 'Retired' };

function formatReleaseDate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

function rowFromLocalRelease(rel: LocalNode, kind: ReleaseTouchKind): ReleaseRow {
  return {
    id: rel.full,
    version: rel.name,
    bump: typeof rel.frontmatter.bump === 'string' ? rel.frontmatter.bump : undefined,
    date: formatReleaseDate(rel.frontmatter.date),
    kind,
  };
}

/** `cli.backlinks(repo, id, {type: 'release'})`, kept to the entries whose `ref_type` is one of
 *  the three edge keys (a release record's body also links the same entities in prose bullets,
 *  which come back with `ref_type: 'inline'` — excluded here so a touch isn't double-counted or
 *  misattributed). One row per release id; when the release also happens to be indexed locally
 *  (the normal case — a release record lives in the same package as the nodes it touched), the
 *  row is enriched with its bump/date/display name from `LocalIndex` instead of just the CLI's
 *  bare id. */
async function loadReleaseRowsViaCli(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode): Promise<ReleaseRow[]> {
  const result = await plugin.cli.backlinks(pkg.absRoot, node.full, { type: 'release' });
  const rows = new Map<string, ReleaseRow>();
  for (const entry of result.backlinks) {
    if (entry.ref_type !== 'added' && entry.ref_type !== 'changed' && entry.ref_type !== 'retired') continue;
    if (rows.has(entry.id)) continue;
    const local = pkg.index.get(entry.id);
    rows.set(
      entry.id,
      local ? rowFromLocalRelease(local, entry.ref_type) : { id: entry.id, version: entry.id, kind: entry.ref_type },
    );
  }
  return [...rows.values()];
}

/** Fallback when the CLI call fails (binary missing, index not built, …): scan every local
 *  `release`-typed node's frontmatter directly with `releaseTouches`. Same shape of result, just
 *  sourced without a CLI round trip — every release record is a normal indexed node, so this
 *  degrades gracefully rather than leaving the section empty. */
function loadReleaseRowsLocal(pkg: PackageInfo, node: LocalNode): ReleaseRow[] {
  const releases = pkg.index.byType().get('release') ?? [];
  const rows: ReleaseRow[] = [];
  for (const rel of releases) {
    const kind = releaseTouches(rel.frontmatter, node.full);
    if (kind) rows.push(rowFromLocalRelease(rel, kind));
  }
  return rows;
}

function sortReleaseRows(rows: ReleaseRow[]): ReleaseRow[] {
  return [...rows].sort((a, b) => compareVersions(b.version, a.version));
}

function renderReleaseHistory(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  root: HTMLElement,
  withHeading: boolean,
): void {
  const wrap = root.createDiv({ cls: 'vaire-history-releases' });
  if (withHeading) wrap.createEl('h3', { text: 'Releases' });
  const body = wrap.createDiv();
  body.setText('Loading…');

  loadReleaseRowsViaCli(plugin, pkg, node)
    .catch(() => loadReleaseRowsLocal(pkg, node))
    .then((rows) => {
      body.empty();
      const sorted = sortReleaseRows(rows);
      if (sorted.length === 0) {
        body.createDiv({ cls: 'vaire-empty', text: 'No release has touched this node yet.' });
        return;
      }
      const table = body.createEl('table', { cls: 'vaire-deps-table vaire-history-releases-table' });
      const headRow = table.createEl('thead').createEl('tr');
      for (const h of ['Version', 'Bump', 'Touched', 'Date']) headRow.createEl('th', { text: h });
      const tbody = table.createEl('tbody');
      for (const row of sorted) renderReleaseRow(plugin, pkg, tbody, row);
    })
    .catch((err: unknown) => {
      // Only reached if even the local fallback throws (shouldn't, but stay defensive).
      body.empty();
      body.createDiv({ cls: 'vaire-error', text: `Could not load release history — ${errMessage(err)}` });
    });
}

function renderReleaseRow(plugin: VairePlugin, pkg: PackageInfo, tbody: HTMLElement, row: ReleaseRow): void {
  const tr = tbody.createEl('tr');
  const versionCell = tr.createEl('td');
  const ref = parseRef(row.id);
  if (ref && ref.kind === 'id') {
    versionCell.appendChild(createRefElement(plugin, ref, { repo: pkg.absRoot, display: row.version }));
  } else {
    versionCell.createEl('code', { cls: 'vaire-nid', text: row.version });
  }
  tr.createEl('td', { text: row.bump ?? '—' });
  tr.createEl('td', { text: TOUCH_LABELS[row.kind] });
  tr.createEl('td', { text: row.date ?? '—' });
}

// ---- Git source ------------------------------------------------------------------------------

function renderGitHistory(
  plugin: VairePlugin,
  pkg: PackageInfo,
  node: LocalNode,
  root: HTMLElement,
  withHeading: boolean,
): void {
  const wrap = root.createDiv({ cls: 'vaire-history-git' });
  if (withHeading) wrap.createEl('h3', { text: 'Git history' });
  const body = wrap.createDiv();
  body.setText('Loading…');

  void loadGitHistory(plugin, pkg, node, body);
}

async function loadGitHistory(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, body: HTMLElement): Promise<void> {
  const repo = await isGitRepo(pkg.absRoot);
  if (!repo) {
    body.empty();
    body.createDiv({
      cls: 'vaire-empty vaire-muted',
      text: `${pkg.name} is not inside a git repository — git history is unavailable.`,
    });
    return;
  }

  const relPath = packageRelativePath(node.file.path, pkg.dir);
  try {
    const [status, entries] = await Promise.all([
      gitStatus(pkg.absRoot, relPath).catch(() => null),
      gitLog(pkg.absRoot, relPath),
    ]);
    body.empty();
    if (status) {
      const statusRow = body.createDiv({ cls: 'vaire-history-git-status' });
      statusRow.createSpan({ cls: 'vaire-badge vaire-history-git-dirty', text: status });
    }
    if (entries.length === 0) {
      if (!status) body.createDiv({ cls: 'vaire-empty', text: 'No commits found for this file.' });
      return;
    }
    const list = body.createDiv({ cls: 'vaire-history-git-list' });
    for (const entry of entries) renderGitLogRow(plugin, pkg, node, list, entry);
  } catch (err) {
    body.empty();
    body.createDiv({ cls: 'vaire-error', text: `Could not load git history — ${errMessage(err)}` });
  }
}

function renderGitLogRow(plugin: VairePlugin, pkg: PackageInfo, node: LocalNode, container: HTMLElement, entry: GitLogEntry): void {
  const row = container.createDiv({ cls: 'vaire-history-git-row', attr: { role: 'button', tabindex: '0' } });
  row.createEl('code', { cls: 'vaire-history-git-hash', text: entry.shortHash });
  row.createSpan({ cls: 'vaire-history-git-subject', text: entry.subject });
  row.createSpan({ cls: 'vaire-muted', text: entry.author });
  row.createSpan({ cls: 'vaire-muted', text: relativeDate(entry.date) });

  const open = (): void => openDiffModal(plugin, pkg, node, entry);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      open();
    }
  });
}
