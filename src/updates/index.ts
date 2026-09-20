// Dependency updates and store maintenance: the "Check for updates" dry-run (cached in memory,
// at most once per 30 minutes per package), Update / Pin / Unpin actions, "Reproduce lockfile"
// and "Clean store…". See DESIGN.md's dependency-updates feature note and registry.md §§5-8.
//
// Owns: src/updates/{pure,index,section}.ts, styles/40-views.css's Updates block. Registers via
// `registerUpdates` (called once from main.ts, like `registerHealth`/`registerWorkbench`).

import { Notice } from 'obsidian';
import { VaireError } from '../cli';
import { openPackageIndex } from '../views/package-node';
import { confirm } from '../ui/prompt-modal';
import type { PackageInfo } from '../packages';
import type { HealthIssue } from '../health/pure';
import { formatBytes, parseCleanDryRun, parsePullDryRun, updatesHealthIssue, type ParsedCleanDryRun, type ParsedPullDryRun } from './pure';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function activeFilePackage(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  return file ? plugin.packages.packageFor(file) : null;
}

// ---- Dry-run cache (src/updates/section.ts + the on-open health check share this) -------------

const CACHE_TTL_MS = 30 * 60 * 1000; // "at most once per 30 minutes per package" — see settings.ts's updateCheck doc

interface CacheEntry {
  at: number;
  parsed: ParsedPullDryRun;
}

const dryRunCache = new Map<string, CacheEntry>(); // keyed by package absRoot

/** The cached dry-run result for `absRoot`, if any and still fresh — never triggers a CLI call. */
export function peekCachedUpdates(absRoot: string): ParsedPullDryRun | null {
  const entry = dryRunCache.get(absRoot);
  if (!entry) return null;
  if (Date.now() - entry.at >= CACHE_TTL_MS) return null;
  return entry.parsed;
}

export interface UpdatesCheckOutcome {
  parsed?: ParsedPullDryRun;
  /** A whole-call failure (registry unreachable, 403, `--locked` with nothing reproducible, …) —
   *  distinct from `parsed.errors`, which are per-dependency problems inside an otherwise
   *  successful response. Carries `VaireError`'s `kind` so a caller can tell a registry problem
   *  (`kind === 'registry'`) apart from anything else, per DESIGN.md's "Registry errors (403/
   *  unreachable) render inline per registry, not as a crash". */
  error?: { kind: string; message: string };
}

/**
 * `cli.pull(repo, undefined, {dryRun: true})`, cached per package root for `CACHE_TTL_MS`
 * unless `opts.force`. Never throws — a thrown `VaireError` comes back as `outcome.error`
 * instead, so every caller (the explicit "Check for updates" button, the on-open health check)
 * can decide for itself whether to surface it or swallow it.
 */
export async function runUpdatesCheck(plugin: VairePlugin, pkg: PackageInfo, opts: { force?: boolean } = {}): Promise<UpdatesCheckOutcome> {
  if (!opts.force) {
    const cached = peekCachedUpdates(pkg.absRoot);
    if (cached) return { parsed: cached };
  }
  try {
    const json = await plugin.cli.pull(pkg.absRoot, undefined, { dryRun: true });
    const parsed = parsePullDryRun(json);
    dryRunCache.set(pkg.absRoot, { at: Date.now(), parsed });
    return { parsed };
  } catch (err) {
    const kind = err instanceof VaireError ? err.kind : 'error';
    return { error: { kind, message: errMessage(err) } };
  }
}

/** Silent variant for the on-open passive health check: a failure degrades to `null` rather
 *  than surfacing — matches `loadHealthIssues` (src/health/index.ts) tolerating `status`/`deps`
 *  errors the same way, so opening a package view never Notices a network hiccup on its own. */
export async function checkUpdatesCached(plugin: VairePlugin, pkg: PackageInfo): Promise<ParsedPullDryRun | null> {
  const outcome = await runUpdatesCheck(plugin, pkg);
  return outcome.parsed ?? null;
}

/**
 * Runs the update check when `settings.updateCheck === 'on-open'` and turns a non-empty result
 * into one `HealthIssue` for the health strip — a no-op (`null`) in `'manual'` mode, on a tolerated
 * failure, or when nothing's outdated. Called from `renderHealthStrip` (src/health/index.ts).
 */
export async function maybeUpdatesIssue(plugin: VairePlugin, pkg: PackageInfo): Promise<HealthIssue | null> {
  if (plugin.settings.updateCheck !== 'on-open') return null;
  const parsed = await checkUpdatesCached(plugin, pkg);
  return parsed ? updatesHealthIssue(parsed) : null;
}

// ---- Pin bookkeeping (fallback when the lockfile doesn't expose pin state) --------------------

/** Records that `name` was pinned/unpinned by this plugin, in plugin data, keyed by package
 *  absRoot — see `VaireSettings.pinnedDependencies`'s doc comment for why this is a fallback
 *  and not the source of truth. */
async function rememberPin(plugin: VairePlugin, pkg: PackageInfo, name: string, pinned: boolean): Promise<void> {
  const current = plugin.settings.pinnedDependencies[pkg.absRoot] ?? [];
  const next = pinned ? [...new Set([...current, name])] : current.filter((n) => n !== name);
  plugin.settings.pinnedDependencies = { ...plugin.settings.pinnedDependencies, [pkg.absRoot]: next };
  await plugin.saveSettings();
}

// ---- Actions (each: Notice on start/failure, then whatever follow-up it needs on success) -----

/** `vaire pull <name>` after confirm, then `plugin.rebuildIndex(pkg)` — per DESIGN.md: "Update
 *  (per dependency / all): cli.pull(repo, name) after confirm, then plugin.rebuildIndex(pkg)." */
export async function updateDependency(plugin: VairePlugin, pkg: PackageInfo, name: string): Promise<boolean> {
  const ok = await confirm(plugin.app, {
    title: `Update '${name}'`,
    message: `Pull the latest version of '${name}' satisfying its constraint and rebuild the index?`,
    okLabel: 'Update',
  });
  if (!ok) return false;

  new Notice(`Vairë: updating '${name}'…`);
  try {
    await plugin.cli.pull(pkg.absRoot, name);
  } catch (err) {
    new Notice(`Vairë: updating '${name}' failed — ${errMessage(err)}`);
    return false;
  }
  new Notice(`Vairë: updated '${name}'`);
  dryRunCache.delete(pkg.absRoot); // the dry-run result is now stale
  await plugin.rebuildIndex(pkg);
  return true;
}

/** Updates every dependency `names` names, sequentially (`vaire pull` isn't safe to fan out —
 *  the catalog/store take an exclusive lock per registry.md §4.4), then rebuilds the index once. */
export async function updateAllDependencies(plugin: VairePlugin, pkg: PackageInfo, names: string[]): Promise<boolean> {
  if (names.length === 0) {
    new Notice('Vairë: no updates to apply.');
    return false;
  }
  const ok = await confirm(plugin.app, {
    title: 'Update all',
    message: `Pull the latest version of ${names.length} dependenc${names.length === 1 ? 'y' : 'ies'} (${names.join(', ')}) and rebuild the index?`,
    okLabel: 'Update all',
  });
  if (!ok) return false;

  new Notice(`Vairë: updating ${names.length} dependenc${names.length === 1 ? 'y' : 'ies'}…`);
  const failed: string[] = [];
  for (const name of names) {
    try {
      await plugin.cli.pull(pkg.absRoot, name);
    } catch (err) {
      failed.push(`${name} (${errMessage(err)})`);
    }
  }
  dryRunCache.delete(pkg.absRoot);
  if (failed.length > 0) new Notice(`Vairë: ${failed.length} update(s) failed — ${failed.join('; ')}`, 8000);
  else new Notice('Vairë: all updates applied');
  await plugin.rebuildIndex(pkg);
  return true;
}

/** `vaire pin <name>@<version>` — no confirm (low-risk, reversible via Unpin). */
export async function pinDependency(plugin: VairePlugin, pkg: PackageInfo, name: string, version: string): Promise<boolean> {
  new Notice(`Vairë: pinning '${name}' at ${version}…`);
  try {
    await plugin.cli.pin(pkg.absRoot, name, version);
  } catch (err) {
    new Notice(`Vairë: pinning '${name}' failed — ${errMessage(err)}`);
    return false;
  }
  await rememberPin(plugin, pkg, name, true);
  new Notice(`Vairë: pinned '${name}' at ${version}`);
  return true;
}

/** `vaire unpin <name>` — no confirm, mirrors `pinDependency`. */
export async function unpinDependency(plugin: VairePlugin, pkg: PackageInfo, name: string): Promise<boolean> {
  new Notice(`Vairë: unpinning '${name}'…`);
  try {
    await plugin.cli.unpin(pkg.absRoot, name);
  } catch (err) {
    new Notice(`Vairë: unpinning '${name}' failed — ${errMessage(err)}`);
    return false;
  }
  await rememberPin(plugin, pkg, name, false);
  new Notice(`Vairë: unpinned '${name}'`);
  return true;
}

/** `vaire pull --locked` after confirm, then `plugin.rebuildIndex(pkg)` on success. A refusal
 *  (registry.md §7: an entry with no checksum, a registry serving different bytes, a workspace-
 *  sourced entry with nothing to reproduce — see tests/fixtures/pull-locked-error.json for a
 *  real one) comes back as a `VaireError` and is Noticed like any other failure, never thrown
 *  past this function. */
export async function reproduceLockfile(plugin: VairePlugin, pkg: PackageInfo): Promise<boolean> {
  const ok = await confirm(plugin.app, {
    title: 'Reproduce lockfile',
    message: `Fetch exactly the versions knowledge.lock records for ${pkg.name}, verified against their recorded checksums, and rebuild the index?`,
    okLabel: 'Reproduce',
  });
  if (!ok) return false;

  new Notice(`Vairë: reproducing knowledge.lock for ${pkg.name}…`);
  try {
    await plugin.cli.pull(pkg.absRoot, undefined, { locked: true });
  } catch (err) {
    new Notice(`Vairë: reproducing the lockfile failed — ${errMessage(err)}`, 8000);
    return false;
  }
  new Notice(`Vairë: lockfile reproduced for ${pkg.name}`);
  dryRunCache.delete(pkg.absRoot);
  await plugin.rebuildIndex(pkg);
  return true;
}

/** `vaire clean --dry-run` preview, then (after confirm on what it found) the real `vaire
 *  clean`. Returns the dry-run result even when the user declines, so the caller (section.ts)
 *  can still render the preview. */
export async function previewClean(plugin: VairePlugin, pkg: PackageInfo): Promise<ParsedCleanDryRun | { error: string }> {
  try {
    const json = await plugin.cli.clean(pkg.absRoot, { dryRun: true });
    return parseCleanDryRun(json);
  } catch (err) {
    return { error: errMessage(err) };
  }
}

function describeCleanPreview(preview: ParsedCleanDryRun): string {
  if (preview.removed.length === 0) return 'Nothing to remove — the store is already minimal.';
  const size = preview.totalSizeBytes != null ? ` (${formatBytes(preview.totalSizeBytes)})` : '';
  const names = preview.removed.map((e) => [e.name, e.version].filter(Boolean).join(' ')).join(', ');
  return `Remove ${preview.removed.length} store entr${preview.removed.length === 1 ? 'y' : 'ies'}${size}: ${names}`;
}

/** Runs the dry-run preview, confirms with what it found, then the real `vaire clean`. Does
 *  nothing (and returns `false`) if the preview itself failed, found nothing to remove, or the
 *  user declined. */
export async function cleanStore(plugin: VairePlugin, pkg: PackageInfo): Promise<boolean> {
  new Notice('Vairë: checking what the store would clean…');
  const preview = await previewClean(plugin, pkg);
  if ('error' in preview) {
    new Notice(`Vairë: could not preview clean — ${preview.error}`, 8000);
    return false;
  }
  if (preview.removed.length === 0) {
    new Notice('Vairë: nothing to clean — the store is already minimal.');
    return false;
  }

  const ok = await confirm(plugin.app, {
    title: 'Clean store',
    message: `${describeCleanPreview(preview)}. Everything removed is still published, so it can be pulled again. Continue?`,
    okLabel: 'Clean',
  });
  if (!ok) return false;

  new Notice('Vairë: cleaning store…');
  try {
    await plugin.cli.clean(pkg.absRoot);
  } catch (err) {
    new Notice(`Vairë: clean failed — ${errMessage(err)}`, 8000);
    return false;
  }
  new Notice(`Vairë: removed ${preview.removed.length} store entr${preview.removed.length === 1 ? 'y' : 'ies'}`);
  return true;
}

// ---- Commands -----------------------------------------------------------------------------

async function runCheckForUpdatesCommand(plugin: VairePlugin, pkg: PackageInfo): Promise<void> {
  new Notice(`Vairë: checking ${pkg.name} for dependency updates…`);
  const outcome = await runUpdatesCheck(plugin, pkg, { force: true });
  if (outcome.error) {
    new Notice(`Vairë: checking for updates failed — ${outcome.error.message}`, 8000);
  } else if (outcome.parsed) {
    const n = outcome.parsed.updates.length;
    new Notice(n > 0 ? `Vairë: ${n} update(s) available for ${pkg.name}` : `Vairë: ${pkg.name} is up to date`);
  }
  await openPackageIndex(plugin, pkg.dir);
}

export function registerUpdates(plugin: VairePlugin): void {
  plugin.addCommand({
    id: 'check-dependency-updates',
    name: 'Check for dependency updates',
    checkCallback: (checking) => {
      const pkg = activeFilePackage(plugin);
      if (!pkg) return false;
      if (!checking) void runCheckForUpdatesCommand(plugin, pkg);
      return true;
    },
  });

  plugin.addCommand({
    id: 'pull-locked',
    name: 'Reproduce lockfile (pull --locked)',
    checkCallback: (checking) => {
      const pkg = activeFilePackage(plugin);
      if (!pkg) return false;
      if (!checking) void reproduceLockfile(plugin, pkg);
      return true;
    },
  });
}
