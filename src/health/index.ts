// Package health and onboarding. See the package-health feature note (health check on load +
// command, catalog auto-registration, "Initialize a Vairë package here…").
//
// - `renderHealthStrip` runs `cli.status` + `cli.deps` for one package (errors tolerated),
//   derives issues with the pure `assessHealth` (src/health/pure.ts), and renders a banner at
//   the top of the package view with a fix action per issue. It renders nothing for a healthy
//   package. Its fix actions (`plugin.rebuildIndex`, `linkFromCatalog`/`pullDependency`) all
//   eventually trigger `'index-rebuilt'`, which `PackageView` already listens for to
//   re-`render()` itself — so the strip refreshes for free after a successful fix, no extra
//   plumbing needed here.
// - On load (after `packages.init()` resolves) and via the "Check package health" command,
//   `runHealthCheckNotices` runs the same check for every vault package and Notices a summary
//   for each one that has issues, with a click-through to that package's index.
// - `runCatalogAutoRegister` registers any vault package the machine's catalog doesn't already
//   have a sighting for at its absolute path.
// - "Initialize a Vairë package here…" scaffolds `knowledge.toml` for a new package: `vaire
//   init <path>` (spec/cli.md §4.4) when the CLI is available, patching `name` on disk
//   afterward if the user chose one other than the directory's basename (which is all `init`
//   itself can derive); a minimal hand-written manifest via `vault.create` otherwise. Either
//   way, `PackageRegistry` picks the new package up on its own via the vault's `create` event
//   (see DESIGN.md "Vault model") — this module does not add it to `plugin.packages` itself.

// `createFragment`/`createEl`/`createDiv`/`createSpan` are ambient globals Obsidian installs
// (declared in `declare global { ... }` in obsidian.d.ts) — not exports of the 'obsidian'
// module, so they're used unimported below, same as everywhere else in this codebase.
import { ButtonComponent, Notice } from 'obsidian';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VaireError } from '../cli';
import { absPathOf, type PackageInfo } from '../packages';
import { linkFromCatalog, pullDependency } from '../views/deps-actions';
import { openPackageIndex } from '../views/package-node';
import { promptText } from '../ui/prompt-modal';
import { assessHealth, type HealthIssue, type StatusErrorLike, missingFromCatalog } from './pure';
import { maybeUpdatesIssue } from '../updates/index';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toStatusError(reason: unknown): StatusErrorLike {
  if (reason instanceof VaireError) return { kind: reason.kind, message: reason.message };
  return { kind: 'error', message: errMessage(reason) };
}

/** Runs `cli.status` + `cli.deps` for `pkg` concurrently (errors tolerated) and derives issues. */
async function loadHealthIssues(plugin: VairePlugin, pkg: PackageInfo): Promise<HealthIssue[]> {
  const [statusResult, depsResult] = await Promise.allSettled([
    plugin.cli.status(pkg.absRoot),
    plugin.cli.deps(pkg.absRoot),
  ]);
  const status = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
  const statusError = statusResult.status === 'rejected' ? toStatusError(statusResult.reason) : null;
  const deps = depsResult.status === 'fulfilled' ? depsResult.value : undefined;
  return assessHealth({ status, deps, statusError });
}

// ---- Health strip (package view) -------------------------------------------------------------

/** Renders the health banner into `containerEl` for `pkg`. Empty container while loading and
 *  when healthy; one colored row per issue otherwise. See `src/views/package-view.ts`, which
 *  calls this first, before its own header. */
export function renderHealthStrip(plugin: VairePlugin, pkg: PackageInfo, containerEl: HTMLElement): void {
  containerEl.empty();
  containerEl.addClass('vaire-health');
  const loading = containerEl.createDiv({ cls: 'vaire-health-loading', text: 'Checking package health…' });

  void (async () => {
    try {
      const issues = await loadHealthIssues(plugin, pkg);
      // feat/dep-updates: settings.updateCheck === 'on-open' only — a no-op (and no network
      // call at all) in 'manual' mode. See src/updates/index.ts's maybeUpdatesIssue.
      const updateIssue = await maybeUpdatesIssue(plugin, pkg);
      if (updateIssue) issues.push(updateIssue);
      loading.remove();
      renderIssueRows(plugin, pkg, containerEl, issues);
    } catch (err) {
      loading.remove();
      containerEl.createDiv({ cls: 'vaire-health-row vaire-health-severity-error', text: `Health check failed — ${errMessage(err)}` });
    }
  })();
}

function renderIssueRows(plugin: VairePlugin, pkg: PackageInfo, containerEl: HTMLElement, issues: HealthIssue[]): void {
  for (const issue of issues) {
    const row = containerEl.createDiv({ cls: `vaire-health-row vaire-health-severity-${issue.severity}` });
    row.createSpan({ cls: 'vaire-health-message', text: issue.message });
    const actions = row.createDiv({ cls: 'vaire-actions vaire-actions-inline' });
    renderIssueAction(plugin, pkg, actions, issue);
  }
}

function renderIssueAction(plugin: VairePlugin, pkg: PackageInfo, actions: HTMLElement, issue: HealthIssue): void {
  switch (issue.action) {
    case 'rebuild_index':
      new ButtonComponent(actions).setButtonText('Rebuild index').onClick(() => void plugin.rebuildIndex(pkg));
      return;
    case 'link_or_pull': {
      const depName = issue.depName;
      if (!depName) return;
      new ButtonComponent(actions)
        .setButtonText('Link from catalog…')
        .onClick(() => void linkFromCatalog(plugin, pkg, depName));
      new ButtonComponent(actions).setButtonText('Pull').onClick(() => void pullDependency(plugin, pkg, depName));
      return;
    }
    case 'open_index':
      new ButtonComponent(actions)
        .setButtonText('Open package index')
        .onClick(() => void openPackageIndex(plugin, pkg.dir));
      return;
  }
}

// ---- Health check on load / command: one Notice per unhealthy package ------------------------

function noticeFragmentFor(plugin: VairePlugin, pkg: PackageInfo, issues: HealthIssue[]): DocumentFragment {
  return createFragment((el: DocumentFragment) => {
    el.createDiv({ text: `Vairë (${pkg.name}): ${issues.length} issue(s)` });
    const list = el.createEl('ul', { cls: 'vaire-health-notice-list' });
    for (const issue of issues) list.createEl('li', { text: issue.message });
    const link = el.createEl('a', { cls: 'vaire-notice-action', text: 'Open package index', href: '#' });
    link.addEventListener('click', (evt: MouseEvent) => {
      evt.preventDefault();
      void openPackageIndex(plugin, pkg.dir);
    });
  });
}

const HEALTH_NOTICE_DURATION_MS = 10000;

/** Checks every vault package and Notices a summary for each one with issues — nothing for a
 *  healthy package. Used both by the on-load hook and the "Check package health" command. */
export async function runHealthCheckNotices(plugin: VairePlugin): Promise<void> {
  await Promise.all(
    plugin.packages.all().map(async (pkg) => {
      let issues: HealthIssue[];
      try {
        issues = await loadHealthIssues(plugin, pkg);
      } catch (err) {
        new Notice(`Vairë: health check failed for ${pkg.name} — ${errMessage(err)}`);
        return;
      }
      if (issues.length > 0) new Notice(noticeFragmentFor(plugin, pkg, issues), HEALTH_NOTICE_DURATION_MS);
    }),
  );
}

// ---- Catalog auto-registration -----------------------------------------------------------------

/** `cli.catalogAdd` for every vault package missing a catalog sighting at its absolute path
 *  (`missingFromCatalog`, src/health/pure.ts). One summary Notice listing what was registered;
 *  nothing when there was nothing to do. Failures (missing binary, a single `catalogAdd` call
 *  erroring) are tolerated — this is a nice-to-have, not a blocking check. */
export async function runCatalogAutoRegister(plugin: VairePlugin): Promise<void> {
  const vaultPackages = plugin.packages.all();
  if (vaultPackages.length === 0) return;

  let sightings;
  try {
    sightings = (await plugin.cli.catalogList()).sightings;
  } catch {
    return;
  }

  const missingRoots = new Set(missingFromCatalog(vaultPackages.map((p) => p.absRoot), sightings));
  if (missingRoots.size === 0) return;

  const registered: string[] = [];
  for (const pkg of vaultPackages) {
    if (!missingRoots.has(pkg.absRoot)) continue;
    try {
      await plugin.cli.catalogAdd(pkg.absRoot);
      registered.push(pkg.name);
    } catch {
      // Tolerated — still report whatever else succeeded.
    }
  }

  if (registered.length > 0) {
    new Notice(`Vairë: registered ${registered.length} package(s) in the catalog — ${registered.join(', ')}`);
  }
}

// ---- "Initialize a Vairë package here…" --------------------------------------------------------

const MINIMAL_MANIFEST = (name: string): string =>
  `name = ${JSON.stringify(name)}\nversion = "0.1.0"\ninclude = ["**/*.md"]\ntypes = []\n`;

/** The active file's folder (vault-relative), or `''` for the vault root. */
function defaultDirFor(plugin: VairePlugin): string {
  const file = plugin.app.workspace.getActiveFile();
  const parent = file?.parent;
  return parent && !parent.isRoot() ? parent.path : '';
}

function basenameOfDir(dir: string, plugin: VairePlugin): string {
  if (!dir) return plugin.app.vault.getName();
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? plugin.app.vault.getName();
}

function manifestPathFor(dir: string): string {
  return dir ? `${dir}/knowledge.toml` : 'knowledge.toml';
}

/** Patches the `name = "..."` line `vaire init` wrote (it can only derive the name from the
 *  directory's basename) to the name the user actually chose. A plain string replace on the
 *  freshly-written file, not a TOML parse/stringify round trip, so `init`'s own formatting and
 *  comments survive untouched. */
function renameManifestOnDisk(absDir: string, name: string): void {
  const manifestPath = path.join(absDir, 'knowledge.toml');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const patched = raw.replace(/^name\s*=\s*".*"$/m, `name = ${JSON.stringify(name)}`);
  fs.writeFileSync(manifestPath, patched, 'utf8');
}

async function ensureFolderExists(plugin: VairePlugin, dir: string): Promise<void> {
  if (!dir) return;
  if (plugin.app.vault.getAbstractFileByPath(dir)) return;
  await plugin.app.vault.createFolder(dir);
}

function noticeInitialized(plugin: VairePlugin, absRoot: string, name: string, manifestPath: string): void {
  const frag = createFragment((el: DocumentFragment) => {
    el.createDiv({ text: `Vairë: '${name}' initialized at ${manifestPath}.` });
    const link = el.createEl('a', { cls: 'vaire-notice-action', text: 'Rebuild index', href: '#' });
    link.addEventListener('click', (evt: MouseEvent) => {
      evt.preventDefault();
      const pkg = plugin.packages.all().find((p) => p.absRoot === absRoot) ?? ({ absRoot, name } as PackageInfo);
      void plugin.rebuildIndex(pkg);
    });
  });
  new Notice(frag, 0);
}

async function initPackage(plugin: VairePlugin): Promise<void> {
  const dirInput = await promptText(plugin.app, {
    title: 'Initialize a Vairë package',
    placeholder: 'Folder (vault-relative; empty = vault root)',
    initial: defaultDirFor(plugin),
    submitLabel: 'Next',
  });
  if (dirInput == null) return; // cancelled
  const dir = dirInput.trim().replace(/^\/+|\/+$/g, '');

  if (plugin.packages.all().some((p) => p.dir === dir)) {
    new Notice(`Vairë: '${dir || '/'}' is already a package.`);
    return;
  }
  const manifestPath = manifestPathFor(dir);
  if (plugin.app.vault.getAbstractFileByPath(manifestPath)) {
    new Notice(`Vairë: '${manifestPath}' already exists.`);
    return;
  }

  const defaultName = basenameOfDir(dir, plugin);
  const nameInput = await promptText(plugin.app, {
    title: 'Package name',
    placeholder: 'Package name (slug)',
    initial: defaultName,
    submitLabel: 'Initialize',
  });
  if (nameInput == null || !nameInput.trim()) return; // cancelled
  const name = nameInput.trim();

  const absDir = absPathOf(plugin.app, dir);
  new Notice(`Vairë: initializing '${name}'…`);

  try {
    await plugin.cli.init(absDir);
    if (name !== defaultName) renameManifestOnDisk(absDir, name);
  } catch (err) {
    // The CLI form is unavailable (binary missing, or any other failure) — fall back to
    // writing the manifest directly through the vault, which also puts it in the vault's
    // index immediately (no need to wait on the filesystem watcher for the fallback path).
    try {
      await ensureFolderExists(plugin, dir);
      await plugin.app.vault.create(manifestPath, MINIMAL_MANIFEST(name));
    } catch (fallbackErr) {
      new Notice(`Vairë: could not initialize the package — ${errMessage(fallbackErr)} (vaire init also failed: ${errMessage(err)})`);
      return;
    }
  }

  noticeInitialized(plugin, absDir, name, manifestPath);
}

// ---- Wiring -------------------------------------------------------------------------------

export function registerHealth(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'vaire-health-check',
    name: 'Check package health',
    callback: () => void runHealthCheckNotices(plugin),
  });

  plugin.addCommand({
    id: 'vaire-init-package',
    name: 'Initialize a Vairë package here…',
    callback: () => void initPackage(plugin),
  });

  plugin.app.workspace.onLayoutReady(() => {
    void plugin.packagesReady.then(() => {
      if (plugin.settings.healthCheckOnLoad) void runHealthCheckNotices(plugin);
      if (plugin.settings.autoRegisterCatalog) void runCatalogAutoRegister(plugin);
    });
  });
}
