// Package discovery and the local (vault-only) id index. See DESIGN.md "Vault model" and
// "Local index". Local lookups never touch the CLI — the CLI is only for cross-package and
// graph-shaped questions (see src/cli.ts).

import { App, FileSystemAdapter, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { displayNameFrom, scopeFirstCandidates, type IdRef } from './ids';
import { parseRendererToml, type RendererFamilyConfig } from './theme/families';
import type VairePlugin from './main';

/** Absolute filesystem path of the vault itself (desktop-only, so always a FileSystemAdapter). */
export function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  throw new Error('vaire: vault adapter is not a FileSystemAdapter (this plugin is desktop-only)');
}

/** Absolute filesystem path of a vault file, or of a vault-relative path string. */
export function absPathOf(app: App, target: TFile | string): string {
  const rel = typeof target === 'string' ? target : target.path;
  return path.join(vaultBasePath(app), rel);
}

function dirOfFile(file: TFile): string {
  const parent = file.parent;
  if (!parent || parent.isRoot()) return '';
  return parent.path;
}

function isPathUnderDir(dir: string, filePath: string): boolean {
  return dir === '' ? true : filePath.startsWith(dir + '/');
}

export interface LocalNode {
  file: TFile;
  type: string;
  id: string;
  scope?: string;
  /** `scope ? \`${scope}/${type}:${id}\` : \`${type}:${id}\`` */
  full: string;
  name: string;
  aliases: string[];
  supersededBy?: string;
  frontmatter: Record<string, unknown>;
}

/** Maps full local ids <-> vault files for one package, from Obsidian's own metadata cache. */
export class LocalIndex {
  private readonly app: App;
  private readonly pkg: PackageInfo;
  private byFull = new Map<string, LocalNode>();
  private byPath = new Map<string, LocalNode>();

  constructor(app: App, pkg: PackageInfo) {
    this.app = app;
    this.pkg = pkg;
  }

  /** Full (re)scan of every markdown file under this package's root. */
  build(): void {
    this.byFull.clear();
    this.byPath.clear();
    const exclusions = this.nestedPackageDirs();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isPathUnderDir(this.pkg.dir, file.path)) continue;
      if (exclusions.some((ex) => isPathUnderDir(ex, file.path))) continue;
      this.rebuildFile(file);
    }
  }

  /** Directories of any package roots strictly nested inside this one — their files are not ours. */
  private nestedPackageDirs(): string[] {
    const dirs: string[] = [];
    for (const manifest of this.app.vault.getFiles()) {
      if (manifest.name !== 'knowledge.toml') continue;
      const dir = dirOfFile(manifest);
      if (dir !== this.pkg.dir && isPathUnderDir(this.pkg.dir, dir)) dirs.push(dir);
    }
    return dirs;
  }

  /** Re-reads one file's frontmatter from the metadata cache and updates (or drops) its entry. */
  rebuildFile(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm || typeof fm.id !== 'string' || typeof fm.type !== 'string') {
      this.dropFile(file.path);
      return;
    }
    const scope = typeof fm.scope === 'string' ? fm.scope : undefined;
    const full = scope ? `${scope}/${fm.type}:${fm.id}` : `${fm.type}:${fm.id}`;
    const firstH1 = cache?.headings?.find((h) => h.level === 1)?.heading;
    const name = displayNameFrom(fm, firstH1, file.basename);
    const aliasesRaw = fm.aliases;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((a): a is string => typeof a === 'string')
      : typeof aliasesRaw === 'string'
        ? [aliasesRaw]
        : [];
    const supersededBy = typeof fm.superseded_by === 'string' ? fm.superseded_by : undefined;

    const node: LocalNode = { file, type: fm.type, id: fm.id, scope, full, name, aliases, supersededBy, frontmatter: fm };

    const previous = this.byPath.get(file.path);
    if (previous && previous.full !== full && this.byFull.get(previous.full) === previous) {
      this.byFull.delete(previous.full);
    }
    this.byFull.set(full, node);
    this.byPath.set(file.path, node);
  }

  dropFile(filePath: string): void {
    const existing = this.byPath.get(filePath);
    if (!existing) return;
    this.byPath.delete(filePath);
    if (this.byFull.get(existing.full) === existing) this.byFull.delete(existing.full);
  }

  get(fullLocalId: string): LocalNode | null {
    return this.byFull.get(fullLocalId) ?? null;
  }

  byFile(file: TFile): LocalNode | null {
    return this.byPath.get(file.path) ?? null;
  }

  all(): LocalNode[] {
    return [...this.byFull.values()];
  }

  byType(): Map<string, LocalNode[]> {
    const map = new Map<string, LocalNode[]>();
    for (const node of this.byFull.values()) {
      const list = map.get(node.type);
      if (list) list.push(node);
      else map.set(node.type, [node]);
    }
    return map;
  }

  findByAlias(text: string): LocalNode[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    return this.all().filter((n) => n.aliases.some((a) => a.toLowerCase() === needle));
  }

  /** Substring match on id/name/aliases, case-insensitive; id-prefix matches sort first. */
  search(text: string, limit: number): LocalNode[] {
    const needle = text.trim().toLowerCase();
    if (!needle) {
      return [...this.all()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
    }
    const prefix: LocalNode[] = [];
    const rest: LocalNode[] = [];
    for (const node of this.all()) {
      const idHay = [node.id, node.full].map((s) => s.toLowerCase());
      const allHay = [...idHay, node.name.toLowerCase(), ...node.aliases.map((a) => a.toLowerCase())];
      if (idHay.some((s) => s.startsWith(needle))) prefix.push(node);
      else if (allHay.some((s) => s.includes(needle))) rest.push(node);
    }
    return [...prefix, ...rest].slice(0, limit);
  }

  /** Nodes whose `superseded_by` frontmatter points at `fullId`. */
  supersededBy(fullId: string): LocalNode[] {
    return this.all().filter((n) => n.supersededBy === fullId);
  }
}

/**
 * Resolves `ref` against `pkg`'s `LocalIndex`, scope-first then global, per
 * `scopeFirstCandidates` (src/ids.ts) — the one place this two-step rule is applied to a real
 * index. `originScope` is the scope of the node the reference was *written in* (i.e.
 * `pkg.index.byFile(originFile)?.scope`), not of `pkg` itself; callers resolving a `@pkg/…`
 * reference into a dependency that also happens to be a vault package pass the same
 * `originScope` through unchanged (see DESIGN.md "Reference grammar").
 */
export function resolveLocalRef(pkg: PackageInfo, ref: IdRef, originScope?: string): LocalNode | null {
  for (const candidate of scopeFirstCandidates(ref, originScope)) {
    const node = pkg.index.get(candidate);
    if (node) return node;
  }
  return null;
}

export interface PackageInfo {
  /** Vault-relative directory containing `knowledge.toml`; `''` for the vault root. */
  dir: string;
  absRoot: string;
  name: string;
  version: string;
  description?: string;
  types: string[];
  /** `knowledge.toml`'s `scoped_types_whitelist` — types the New-node modal offers a `scope` field for. */
  scopedTypesWhitelist: string[];
  dependencies: Record<string, string>;
  index: LocalIndex;
  /**
   * Parsed `<dir>/vaire-renderer.toml` (feat/type-colors), if that file exists next to
   * `knowledge.toml` — the renderer's own `[families]`/`[family_colors]` config, consulted
   * by `src/theme/index.ts` when `settings.typeColorSource === 'renderer'` so badge colours
   * match the published site. `undefined` when the file is absent (most packages), not
   * merely empty — callers fall back to the renderer's built-in table either way.
   */
  rendererConfig?: RendererFamilyConfig;
}

interface ParsedManifest {
  name: string;
  version: string;
  description?: string;
  types: string[];
  scopedTypesWhitelist: string[];
  dependencies: Record<string, string>;
}

/** Discovers every `knowledge.toml` in the vault and keeps `PackageInfo`/`LocalIndex` fresh. */
export class PackageRegistry {
  private readonly app: App;
  private readonly plugin: VairePlugin;
  readonly roots = new Map<string, PackageInfo>();

  constructor(app: App, plugin: VairePlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  async init(): Promise<void> {
    await this.scan();
    this.plugin.registerEvent(this.app.vault.on('create', (file) => void this.onCreate(file)));
    this.plugin.registerEvent(this.app.vault.on('delete', (file) => this.onDelete(file)));
    this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.onRename(file, oldPath)));
    this.plugin.registerEvent(this.app.vault.on('modify', (file) => void this.onModify(file)));
    this.plugin.registerEvent(this.app.vault.on('create', (file) => void this.onRendererConfigTouched(file)));
    this.plugin.registerEvent(this.app.vault.on('modify', (file) => void this.onRendererConfigTouched(file)));
    this.plugin.registerEvent(this.app.vault.on('delete', (file) => this.onRendererConfigDeleted(file)));
    this.plugin.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => void this.onRendererConfigRenamed(file, oldPath)),
    );
    this.plugin.registerEvent(
      this.app.metadataCache.on('changed', (file) => this.onMetadataChanged(file)),
    );
    // On a cold start the metadata cache may still be filling; once it reports resolved,
    // rebuild every local index so nodes indexed after our scan are not missed.
    this.plugin.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        for (const pkg of this.roots.values()) pkg.index.build();
        this.plugin.events.trigger('local-index-rebuilt');
      }),
    );
  }

  private async scan(): Promise<void> {
    this.roots.clear();
    const manifests = this.app.vault.getFiles().filter((f) => f.name === 'knowledge.toml');
    for (const manifest of manifests) {
      await this.addRoot(manifest);
    }
  }

  private async addRoot(manifestFile: TFile): Promise<PackageInfo> {
    const dir = dirOfFile(manifestFile);
    const parsed = await this.parseManifest(manifestFile);
    const info: PackageInfo = {
      dir,
      absRoot: absPathOf(this.app, dir),
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      types: parsed.types,
      scopedTypesWhitelist: parsed.scopedTypesWhitelist,
      dependencies: parsed.dependencies,
      index: undefined as unknown as LocalIndex,
      rendererConfig: undefined,
    };
    info.index = new LocalIndex(this.app, info);
    this.roots.set(dir, info);
    info.index.build();
    info.rendererConfig = await this.readRendererConfig(dir);
    return info;
  }

  /** Vault-relative path of `<dir>/vaire-renderer.toml` (`''` dir ⇒ vault root). */
  private rendererConfigPath(dir: string): string {
    return dir ? `${dir}/vaire-renderer.toml` : 'vaire-renderer.toml';
  }

  /** Reads and parses a package root's `vaire-renderer.toml`, if present; `undefined` if
   *  the file doesn't exist (not merely empty/malformed — `parseRendererToml` itself is
   *  tolerant of that and returns an empty-but-defined config instead). */
  private async readRendererConfig(dir: string): Promise<RendererFamilyConfig | undefined> {
    const file = this.app.vault.getAbstractFileByPath(this.rendererConfigPath(dir));
    if (!(file instanceof TFile)) return undefined;
    try {
      const raw = await this.app.vault.read(file);
      return parseRendererToml(raw);
    } catch {
      return undefined;
    }
  }

  /** A `vaire-renderer.toml` was created or modified: if it sits next to a known package
   *  root's `knowledge.toml`, re-read it and let `src/theme/index.ts` know its colours may
   *  have changed (feat/type-colors). Ignores one anywhere else (not a package root). */
  private async onRendererConfigTouched(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.name !== 'vaire-renderer.toml') return;
    const dir = dirOfFile(file);
    const info = this.roots.get(dir);
    if (!info) return;
    info.rendererConfig = await this.readRendererConfig(dir);
    this.plugin.events.trigger('renderer-config-changed', dir);
  }

  /** A `vaire-renderer.toml` was deleted: drop the config back to `undefined` (falls back
   *  to the renderer's built-in table) rather than leaving the last-read one stale. */
  private onRendererConfigDeleted(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.name !== 'vaire-renderer.toml') return;
    const dir = dirOfFile(file);
    const info = this.roots.get(dir);
    if (!info) return;
    info.rendererConfig = undefined;
    this.plugin.events.trigger('renderer-config-changed', dir);
  }

  /** A file was renamed into, out of, or as `vaire-renderer.toml`: clear the old package
   *  root's config (if it was one) and (re)read the new location (if it is one). */
  private async onRendererConfigRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (oldPath.endsWith('/vaire-renderer.toml') || oldPath === 'vaire-renderer.toml') {
      const oldDir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
      const oldInfo = this.roots.get(oldDir);
      if (oldInfo) {
        oldInfo.rendererConfig = undefined;
        this.plugin.events.trigger('renderer-config-changed', oldDir);
      }
    }
    await this.onRendererConfigTouched(file);
  }

  private async parseManifest(file: TFile): Promise<ParsedManifest> {
    const fallbackName = file.parent && !file.parent.isRoot() ? file.parent.name : this.app.vault.getName();
    try {
      const raw = await this.app.vault.read(file);
      const data = parseToml(raw) as Record<string, unknown>;
      const name = typeof data.name === 'string' ? data.name : fallbackName;
      const version = typeof data.version === 'string' ? data.version : '0.0.0';
      const description = typeof data.description === 'string' ? data.description : undefined;
      const types = Array.isArray(data.types)
        ? data.types.filter((t): t is string => typeof t === 'string')
        : [];
      const scopedTypesWhitelist = Array.isArray(data.scoped_types_whitelist)
        ? data.scoped_types_whitelist.filter((t): t is string => typeof t === 'string')
        : [];
      const dependencies: Record<string, string> = {};
      const depsRaw = data.dependencies;
      if (depsRaw && typeof depsRaw === 'object') {
        for (const [k, v] of Object.entries(depsRaw as Record<string, unknown>)) {
          if (typeof v === 'string') dependencies[k] = v;
        }
      }
      return { name, version, description, types, scopedTypesWhitelist, dependencies };
    } catch {
      // Tolerant of a missing/malformed manifest — still register the root with defaults.
      return { name: fallbackName, version: '0.0.0', types: [], scopedTypesWhitelist: [], dependencies: {} };
    }
  }

  private async onCreate(file: TAbstractFile): Promise<void> {
    if (file instanceof TFile && file.name === 'knowledge.toml') {
      await this.addRoot(file);
    }
  }

  private onDelete(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      // Obsidian fires exactly one 'delete' event for a deleted folder (not one per
      // descendant file), so a package root — or files inside one — may have just vanished
      // with it. Rescanning is the only reliable way to drop whatever went with it.
      void this.scan();
      return;
    }
    if (file instanceof TFile && file.name === 'knowledge.toml') {
      this.roots.delete(dirOfFile(file));
      return;
    }
    const pkg = this.packageFor(file.path);
    pkg?.index.dropFile(file.path);
  }

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (file instanceof TFolder) {
      // As with delete, a folder rename/move fires one event for the folder itself — every
      // vault-relative path under it (including any package roots) just changed at once.
      await this.scan();
      return;
    }
    if (file instanceof TFile && (file.name === 'knowledge.toml' || oldPath.endsWith('/knowledge.toml') || oldPath === 'knowledge.toml')) {
      await this.scan();
      return;
    }
    for (const pkg of this.roots.values()) pkg.index.dropFile(oldPath);
    if (file instanceof TFile) {
      this.packageFor(file.path)?.index.rebuildFile(file);
    }
  }

  private onModify(file: TAbstractFile): void {
    if (file instanceof TFile && file.name === 'knowledge.toml') {
      void this.refreshManifest(file);
    }
  }

  private async refreshManifest(file: TFile): Promise<void> {
    const info = this.roots.get(dirOfFile(file));
    if (!info) return;
    const parsed = await this.parseManifest(file);
    info.name = parsed.name;
    info.version = parsed.version;
    info.description = parsed.description;
    info.types = parsed.types;
    info.scopedTypesWhitelist = parsed.scopedTypesWhitelist;
    info.dependencies = parsed.dependencies;
  }

  private onMetadataChanged(file: TFile): void {
    this.packageFor(file.path)?.index.rebuildFile(file);
  }

  /** The nearest ancestor package root for a file (or vault-relative path), if any. */
  packageFor(file: TFile | string): PackageInfo | null {
    const filePath = typeof file === 'string' ? file : file.path;
    let best: PackageInfo | null = null;
    let bestLen = -1;
    for (const [dir, info] of this.roots) {
      if (dir === '') {
        if (bestLen < 0) {
          best = info;
          bestLen = 0;
        }
        continue;
      }
      if (isPathUnderDir(dir, filePath) && dir.length > bestLen) {
        best = info;
        bestLen = dir.length;
      }
    }
    return best;
  }

  all(): PackageInfo[] {
    return [...this.roots.values()];
  }

  byName(name: string): PackageInfo | null {
    for (const info of this.roots.values()) {
      if (info.name === name) return info;
    }
    return null;
  }
}
