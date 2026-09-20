// Read-only view for a node that lives outside the vault (a dependency's working copy, a
// store package, or any other catalog sighting). See DESIGN.md "Features §4 External
// read-only pages" and "Phase 2 ownership" for the `data-vaire-repo` / `__vaire_external__`
// sourcePath contract shared with the rendering pass.

import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VaireError } from '../cli';
import { displayNameFrom, extractFrontmatterEdges, parseRef, type VaireRef } from '../ids';
import { createRefElement } from '../render/ref-el';
import type { RenderResult, ResolveResult } from '../types';
import type VairePlugin from '../main';
import {
  externalSourcePath,
  firstH1,
  frontmatterScalars,
  readManifest,
  rewriteRenderedLinks,
  splitFrontmatter,
} from './pure-ext';

export const VIEW_TYPE_EXTERNAL = 'vaire-external';

/**
 * Persisted view state. Exactly one of `id`/`filePath` is set:
 * - `id` (never carrying an `@pkg/` prefix — `repo` is that package's root): the normal path,
 *   opened from a resolved `@pkg/type:id` reference. The header comes from `cli.resolve`; the
 *   body from `cli.render` or a raw file read depending on `settings.externalRenderMode`.
 * - `filePath` (relative to `repo`, like `ResolveResult.path`): set when the view was opened
 *   from a `vaire://<absolute-path>` link inside a `render`-mode page (see `render/reading.ts`)
 *   — there is no id to resolve against, only a file on disk, so the header is derived from a
 *   best-effort read of the file's own frontmatter (`frontmatterScalars`) and the body is
 *   whatever is on disk, unrewritten (see `renderByFilePath`).
 */
export interface ExternalState {
  repo: string;
  id?: string;
  filePath?: string;
  pkg?: string;
  version?: string;
}

/** The header/body-acquisition inputs both `renderById` and `renderByFilePath` reduce to. */
interface NodeInfo {
  /** Full local id (`type:id`, or `scope/type:id` for a scoped node) — never `@pkg`-prefixed. */
  id: string;
  type: string;
  /** Path to the file, relative to `state.repo`. */
  path: string;
  frontmatter: Record<string, unknown>;
  superseded_by: string | null;
  packageName?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isExternalState(value: unknown): value is ExternalState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.repo !== 'string') return false;
  return typeof v.id === 'string' || typeof v.filePath === 'string';
}

export class ExternalNodeView extends ItemView {
  private readonly plugin: VairePlugin;
  private state: ExternalState | null = null;
  private backStack: ExternalState[] = [];
  private displayName: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VairePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL;
  }

  getIcon(): string {
    return 'book-open';
  }

  getDisplayText(): string {
    return this.displayName ?? this.state?.id ?? this.state?.filePath ?? 'External node';
  }

  getState(): Record<string, unknown> {
    return this.state ? { ...this.state } : {};
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isExternalState(state)) {
      this.state = state;
      result.history = true;
      await this.renderState();
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('vaire-ext-view');
    await this.renderState();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /**
   * Opens `state`, reusing the active `vaire-external` leaf unless `newLeaf` is set (pushing the
   * leaf's previous state onto its own back stack first). If the active leaf isn't already a
   * `vaire-external` view, a fresh tab is used regardless — never steal a markdown leaf the user
   * is editing.
   */
  static async open(plugin: VairePlugin, state: ExternalState, opts: { newLeaf?: boolean } = {}): Promise<void> {
    const { workspace } = plugin.app;
    const activeView = workspace.getActiveViewOfType(ExternalNodeView);
    if (activeView && !opts.newLeaf) {
      if (activeView.state) activeView.backStack.push(activeView.state);
      activeView.state = state;
      await activeView.renderState();
      await workspace.revealLeaf(activeView.leaf);
      return;
    }
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_EXTERNAL, state: state as unknown as Record<string, unknown>, active: true });
    await workspace.revealLeaf(leaf);
  }

  private async goBack(): Promise<void> {
    const previous = this.backStack.pop();
    if (!previous) return;
    this.state = previous;
    await this.renderState();
  }

  private async renderState(): Promise<void> {
    const state = this.state;
    const container = this.contentEl;
    container.empty();
    if (!state) return;

    if (this.backStack.length > 0) {
      const toolbar = container.createDiv({ cls: 'vaire-ext-toolbar' });
      const backBtn = toolbar.createEl('button', { text: '← Back', cls: 'vaire-ext-back' });
      backBtn.addEventListener('click', () => void this.goBack());
    }

    if (state.id) {
      await this.renderById(container, state, state.id);
    } else if (state.filePath) {
      await this.renderByFilePath(container, state, state.filePath);
    }
  }

  /**
   * The normal path: `id` is a resolved `type:id` (see `ExternalState`). The header always
   * comes from `cli.resolve`; the body comes from `cli.render` (link-rewritten via
   * `rewriteRenderedLinks`) or a raw file read, per `settings.externalRenderMode` — this is
   * the one branch point the whole `feat/ext-render-mode` comparison is about.
   */
  private async renderById(container: HTMLElement, state: ExternalState, id: string): Promise<void> {
    let result: ResolveResult;
    try {
      result = await this.plugin.cli.resolve(state.repo, id);
    } catch (err) {
      if (err instanceof VaireError && err.kind === 'index_not_built') {
        this.renderIndexNotBuilt(container, state);
        return;
      }
      container.createDiv({ cls: 'vaire-error', text: `Vairë: ${errMessage(err)}` });
      return;
    }

    const mode = this.plugin.settings.externalRenderMode;
    let body: string;
    if (mode === 'render') {
      let rendered: RenderResult;
      try {
        rendered = await this.plugin.cli.render(state.repo, id);
      } catch (err) {
        container.createDiv({ cls: 'vaire-error', text: `Vairë: could not render ${id} — ${errMessage(err)}` });
        return;
      }
      const split = splitFrontmatter(rendered.markdown);
      body = rewriteRenderedLinks(split.body, { repo: state.repo, filePath: rendered.path }).markdown;
    } else {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(state.repo, result.path), 'utf8');
      } catch (err) {
        container.createDiv({ cls: 'vaire-error', text: `Could not read ${result.path}: ${errMessage(err)}` });
        return;
      }
      body = splitFrontmatter(raw).body;
    }

    await this.renderHeaderAndBody(
      container,
      state,
      {
        id: result.id,
        type: result.type,
        path: result.path,
        frontmatter: result.frontmatter,
        superseded_by: result.superseded_by,
        packageName: result.package,
      },
      body,
    );
  }

  /**
   * Opened from a `vaire://<absolute-path>` link inside a `render`-mode page — there is no id
   * to resolve, only a file. Reads it directly (no CLI call at all) and derives the header
   * from a best-effort scan of its own frontmatter; the body is rendered exactly as it is on
   * disk (this is always effectively "raw" for this one page, regardless of
   * `settings.externalRenderMode` — there is no id to hand `cli.render`, and the whole point
   * of arriving here was to avoid another CLI round trip).
   */
  private async renderByFilePath(container: HTMLElement, state: ExternalState, filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(state.repo, filePath), 'utf8');
    } catch (err) {
      container.createDiv({ cls: 'vaire-error', text: `Could not read ${filePath}: ${errMessage(err)}` });
      return;
    }

    const { frontmatterText, body } = splitFrontmatter(raw);
    const scalars = frontmatterScalars(frontmatterText);
    const baseName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? filePath;
    const id = typeof scalars.id === 'string' && scalars.id ? scalars.id : baseName;
    const type = typeof scalars.type === 'string' && scalars.type ? scalars.type : 'node';
    const scope = typeof scalars.scope === 'string' && scalars.scope ? scalars.scope : undefined;
    const fullLocalId = scope ? `${scope}/${type}:${id}` : `${type}:${id}`;
    const supersededBy = typeof scalars.superseded_by === 'string' && scalars.superseded_by ? scalars.superseded_by : null;

    await this.renderHeaderAndBody(
      container,
      state,
      {
        id: fullLocalId,
        type,
        path: filePath,
        frontmatter: scalars,
        superseded_by: supersededBy,
        packageName: state.pkg,
      },
      body,
    );
  }

  /** Shared banner + `.vaire-node-header` + body render, fed by either `renderById` or `renderByFilePath`. */
  private async renderHeaderAndBody(container: HTMLElement, state: ExternalState, info: NodeInfo, body: string): Promise<void> {
    const manifest = readManifest(state.repo);
    const pkgName = state.pkg ?? info.packageName ?? manifest?.name;
    const version = state.version ?? manifest?.version;

    const banner = container.createDiv({ cls: 'vaire-ext-banner' });
    banner.setText(`Read-only · ${pkgName ? '@' + pkgName : 'unlinked package'}${version ? ' ' + version : ''}`);

    const header = container.createDiv({ cls: ['vaire-node-header', 'vaire-ext-header'] });

    const crumb = header.createDiv({ cls: 'vaire-crumb vaire-ext-crumb' });
    crumb.createSpan({ text: info.type });
    crumb.createSpan({ text: ' / ' });
    crumb.createSpan({ text: info.id });

    const fullAddress = pkgName ? `@${pkgName}/${info.id}` : info.id;
    const addrEl = header.createEl('code', { cls: 'vaire-addr vaire-ext-addr', text: fullAddress });
    addrEl.setAttribute('title', 'Click to copy');
    addrEl.addEventListener('click', () => {
      navigator.clipboard.writeText(fullAddress).then(
        () => new Notice(`Copied ${fullAddress}`),
        () => new Notice('Vairë: could not copy to the clipboard'),
      );
    });

    const baseName = info.path.split('/').pop()?.replace(/\.md$/, '') ?? info.path;
    const name = displayNameFrom(info.frontmatter, firstH1(body), baseName);
    this.displayName = name;
    header.createDiv({ cls: 'vaire-ext-name', text: name });

    const aliasesRaw = info.frontmatter?.aliases;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((a): a is string => typeof a === 'string')
      : typeof aliasesRaw === 'string'
        ? [aliasesRaw]
        : [];
    if (aliases.length > 0) {
      const aliasesEl = header.createDiv({ cls: 'vaire-aliases vaire-ext-aliases' });
      for (const alias of aliases) {
        aliasesEl.createSpan({ cls: 'vaire-alias-chip vaire-chip', text: alias });
      }
    }

    if (info.superseded_by) {
      const bannerEl = header.createDiv({ cls: 'vaire-superseded-banner vaire-ext-superseded' });
      bannerEl.createSpan({ text: 'This node is a tombstone — references redirect to ' });
      const target = parseRef(info.superseded_by);
      if (target) {
        bannerEl.appendChild(createRefElement(this.plugin, target, { repo: state.repo }));
      } else {
        bannerEl.createSpan({ text: info.superseded_by });
      }
    }

    const edges = extractFrontmatterEdges(info.frontmatter);
    if (edges.length > 0) {
      const edgesEl = header.createDiv({ cls: 'vaire-edges vaire-ext-edges' });
      for (const edge of edges) {
        const row = edgesEl.createDiv({ cls: 'vaire-edge-row' });
        row.createSpan({ cls: 'vaire-edge-key', text: edge.key });
        const valuesEl = row.createDiv({ cls: 'vaire-edge-values' });
        for (const value of edge.values) {
          if (value.kind === 'text') {
            valuesEl.createDiv({ text: value.text });
            continue;
          }
          const valueRow = valuesEl.createDiv();
          valueRow.appendChild(createRefElement(this.plugin, value as VaireRef, { repo: state.repo }));
        }
      }
    }

    const bodyEl = container.createDiv({ cls: 'vaire-ext-body' });
    bodyEl.setAttribute('data-vaire-repo', state.repo);
    const sourcePath = externalSourcePath(state.repo, info.path);
    await MarkdownRenderer.render(this.app, body, bodyEl, sourcePath, this);
  }

  private renderIndexNotBuilt(container: HTMLElement, state: ExternalState): void {
    const div = container.createDiv({ cls: 'vaire-error vaire-ext-index-not-built' });
    div.createEl('p', { text: `The index for this package (${state.repo}) has not been built yet.` });
    const btn = div.createEl('button', { text: 'Build index' });
    btn.addEventListener('click', () => void this.buildIndex(state, btn));
  }

  private async buildIndex(state: ExternalState, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      await this.plugin.cli.index(state.repo, { workingTree: false });
      await this.renderState();
    } catch (err) {
      new Notice(`Vairë: could not build the index — ${errMessage(err)}`);
      btn.disabled = false;
    }
  }
}
