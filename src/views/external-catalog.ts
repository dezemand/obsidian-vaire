// Wires up the external read-only view and the catalog/registry browser, and implements
// `plugin.hooks.openExternal` — the one place a `@pkg/...` (or an id local to an external page)
// turns into an open view. See DESIGN.md "Features §4-5" and "Phase 2 ownership".

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Notice } from 'obsidian';
import { DepsModel } from '../deps';
import type { IdRef } from '../ids';
import { parseRef } from '../ids';
import type VairePlugin from '../main';
import { openFileAtLine } from '../navigate';
import type { PackageInfo } from '../packages';
import { CatalogView, VIEW_TYPE_CATALOG } from './catalog-view';
import { ExternalNodeView, VIEW_TYPE_EXTERNAL } from './external-view';
import { findPackageRoot, readManifest } from './pure-ext';
import { promptText } from '../ui/prompt-modal';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEPS_MODEL_TTL_MS = 30_000;
const depsModelCache = new Map<string, { model: DepsModel; expires: number }>();

async function cachedDepsModel(plugin: VairePlugin, pkg: PackageInfo): Promise<DepsModel | null> {
  const cached = depsModelCache.get(pkg.absRoot);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.model;
  try {
    const model = await DepsModel.load(plugin.cli, pkg);
    depsModelCache.set(pkg.absRoot, { model, expires: now + DEPS_MODEL_TTL_MS });
    return model;
  } catch {
    return null;
  }
}

/**
 * The absolute root of package `pkgName` as seen from `absRoot`, per DESIGN.md's dependency
 * root order: the linked `.vaire/packages/<name>` symlink (via `DepsModel.rootOf` when `absRoot`
 * is itself a vault package, since that also tries the symlink; otherwise checked directly —
 * dependency roots have their own `.vaire/packages/` too), else a `live` catalog sighting.
 *
 * Exported so `src/render/preview-data.ts` (hover-preview feature) can locate the same root
 * without duplicating this lookup order, and so `src/views/backlinks-data.ts` can locate the
 * root of a dependency package a backlink's referencing file lives in, the same way this module
 * locates the root of an `@pkg/…` reference's target.
 * Exported for embeds.ts, which needs the same lookup to read a dependency node's raw file off
 * disk for transclusion.
 */
export async function resolveDependencyRoot(plugin: VairePlugin, pkgName: string, absRoot: string): Promise<string | null> {
  const vaultPkg = plugin.packages.all().find((p) => p.absRoot === absRoot) ?? null;
  if (vaultPkg) {
    const model = await cachedDepsModel(plugin, vaultPkg);
    const root = model?.rootOf(pkgName);
    if (root) return root;
  } else {
    const linked = path.join(absRoot, '.vaire', 'packages', pkgName);
    try {
      if (fs.existsSync(linked)) return fs.realpathSync(linked);
    } catch {
      // fall through to the catalog
    }
  }
  try {
    const list = await plugin.cli.catalogList();
    const sighting = list.sightings.find((s) => s.name === pkgName && s.state === 'live');
    if (sighting) return sighting.path;
  } catch {
    // fall through to null — caller shows a Notice
  }
  return null;
}

async function openExternal(
  plugin: VairePlugin,
  ref: IdRef,
  absRoot: string,
  opts: { newLeaf?: boolean } = {},
): Promise<void> {
  if (ref.pkg) {
    const vaultPkg = plugin.packages.byName(ref.pkg);
    if (vaultPkg) {
      const node = vaultPkg.index.get(ref.local);
      if (!node) {
        new Notice(`Not found: ${ref.full}`);
        return;
      }
      await openFileAtLine(plugin.app, node.file, undefined, opts.newLeaf);
      return;
    }

    const depRoot = await resolveDependencyRoot(plugin, ref.pkg, absRoot);
    if (!depRoot) {
      new Notice(`Package '${ref.pkg}' is not linked here — open the package index to link or pull it`);
      return;
    }
    await ExternalNodeView.open(plugin, { repo: depRoot, id: ref.local, pkg: ref.pkg }, opts);
    return;
  }

  // No `@pkg` — a local id referenced from within an external page itself.
  await ExternalNodeView.open(plugin, { repo: absRoot, id: ref.local }, opts);
}

/**
 * Opens the external view for a `vaire://<absolute-path>` link clicked inside a `render`-mode
 * page (feat/ext-render-mode; see `render/reading.ts`'s `processRenderModeLinks`). There is no
 * id here, only a file — find the package root that owns it (walking up to the nearest
 * `knowledge.toml`, same as any other dependency root) and open `ExternalNodeView` with a
 * `filePath` state instead of an `id` one.
 */
async function openExternalFile(plugin: VairePlugin, absPath: string, opts: { newLeaf?: boolean } = {}): Promise<void> {
  const root = findPackageRoot(absPath);
  if (!root) {
    new Notice(`Vairë: could not find a package root for ${absPath}`);
    return;
  }
  const filePath = path.relative(root, absPath);
  const pkg = readManifest(root)?.name;
  await ExternalNodeView.open(plugin, { repo: root, filePath, pkg }, opts);
}

async function openExternalNodeCommand(plugin: VairePlugin): Promise<void> {
  const text = await promptText(plugin.app, {
    title: 'Open a node from any catalog package',
    placeholder: '@pkg/type:id',
    submitLabel: 'Open',
  });
  if (!text) return;
  const trimmed = text.trim();
  const ref = parseRef(trimmed);
  if (!ref || ref.kind !== 'id' || !ref.pkg) {
    new Notice('Vairë: enter a full reference like @pkg/type:id');
    return;
  }

  const vaultPkg = plugin.packages.all()[0];
  if (vaultPkg) {
    await plugin.hooks.openExternal?.(ref, vaultPkg.absRoot, {});
    return;
  }

  // No vault package at all — resolve rootless straight from the catalog.
  try {
    const list = await plugin.cli.catalogList();
    const sighting = list.sightings.find((s) => s.name === ref.pkg && s.state === 'live');
    if (!sighting) {
      new Notice(`Vairë: package '${ref.pkg}' not found in the catalog`);
      return;
    }
    await ExternalNodeView.open(plugin, {
      repo: sighting.path,
      id: ref.local,
      pkg: ref.pkg,
      version: sighting.version,
    });
  } catch (err) {
    new Notice(`Vairë: could not look up the catalog — ${errMessage(err)}`);
  }
}

export function registerExternalAndCatalogViews(plugin: VairePlugin): void {
  plugin.registerView(VIEW_TYPE_EXTERNAL, (leaf) => new ExternalNodeView(leaf, plugin));
  plugin.registerView(VIEW_TYPE_CATALOG, (leaf) => new CatalogView(leaf, plugin));

  plugin.hooks.openExternal = (ref, absRoot, opts) => openExternal(plugin, ref, absRoot, opts);
  plugin.hooks.openExternalFile = (absPath, opts) => openExternalFile(plugin, absPath, opts);

  // `depsModelCache` (above) is this module's own cache, separate from `plugin.resolveMemo` —
  // without this it can keep answering "not linked" for up to DEPS_MODEL_TTL_MS after a
  // dependency was just linked/pulled from the package view (which fires 'index-rebuilt').
  plugin.registerEvent(
    plugin.events.on('index-rebuilt', (root) => {
      if (typeof root === 'string') depsModelCache.delete(root);
    }),
  );

  plugin.addCommand({
    id: 'open-catalog',
    name: 'Open catalog and registries',
    callback: () => void CatalogView.open(plugin),
  });

  plugin.addCommand({
    id: 'open-external-node',
    name: 'Open a node from any catalog package…',
    callback: () => void openExternalNodeCommand(plugin),
  });
}
