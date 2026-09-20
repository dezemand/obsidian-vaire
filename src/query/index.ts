// Live `vaire` query blocks — a Dataview-like view over the graph. See DESIGN.md's task brief
// for the fenced-block syntax, src/query/pure.ts for the parser/evaluator helpers, and
// src/query/local.ts / src/query/cli.ts for the two backends this picks between (per-block
// `source:` clause, else the `queryBlockSource` setting; see `pickSource`).
//
// Each block is its own `MarkdownRenderChild`, registering exactly the refresh listener its
// resolved source needs (metadata `changed` for `local`, `index-rebuilt` for `cli`) and
// debouncing re-evaluation by 300ms so a burst of edits/index-rebuilds only re-renders once.

import { ButtonComponent, MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { VaireError } from '../cli';
import { parseRef } from '../ids';
import { humanizeKey } from '../render/pure';
import { createRefElement } from '../render/ref-el';
import type { PackageInfo } from '../packages';
import type VairePlugin from '../main';
import { columnsFor, parseQuery, pickSource, type ParsedQuery, type QueryNode } from './pure';
import { evaluateLocal } from './local';
import { evaluateCli } from './cli';

const REFRESH_DEBOUNCE_MS = 300;

export function registerQueryBlocks(plugin: VairePlugin): void {
  plugin.registerMarkdownCodeBlockProcessor('vaire', (source, el, ctx: MarkdownPostProcessorContext) => {
    ctx.addChild(new QueryBlock(plugin, el, source, ctx.sourcePath));
  });
}

class QueryBlock extends MarkdownRenderChild {
  private refreshTimer: number | null = null;
  private runId = 0;

  constructor(
    private readonly plugin: VairePlugin,
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly sourcePath: string,
  ) {
    super(containerEl);
  }

  onload(): void {
    const { query, errors } = parseQuery(this.source);
    if (errors.length > 0) {
      renderParseErrors(this.containerEl, errors);
      return; // nothing to refresh — a text edit re-invokes the code block processor anyway
    }

    const pkg = this.plugin.packages.packageFor(this.sourcePath);
    if (!pkg) {
      renderParseErrors(this.containerEl, ['This file is not inside a Vairë package.']);
      return;
    }

    const resolvedSource = pickSource(query, this.plugin.settings.queryBlockSource);
    if (resolvedSource === 'local') {
      this.registerEvent(
        this.plugin.app.metadataCache.on('changed', (file) => {
          if (this.plugin.packages.packageFor(file.path)?.absRoot === pkg.absRoot) this.scheduleRefresh(query, pkg);
        }),
      );
    } else {
      this.registerEvent(
        this.plugin.events.on('index-rebuilt', (root) => {
          if (root === pkg.absRoot) this.scheduleRefresh(query, pkg);
        }),
      );
    }

    void this.run(query, pkg);
  }

  onunload(): void {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(query: ParsedQuery, pkg: PackageInfo): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.run(query, pkg);
    }, REFRESH_DEBOUNCE_MS);
  }

  private thisNodeFull(pkg: PackageInfo): string | undefined {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return undefined;
    return pkg.index.byFile(file)?.full;
  }

  private async run(query: ParsedQuery, pkg: PackageInfo): Promise<void> {
    const myRunId = ++this.runId;
    const source = pickSource(query, this.plugin.settings.queryBlockSource);
    const thisFull = this.thisNodeFull(pkg);
    const start = performance.now();
    try {
      const nodes =
        source === 'local'
          ? evaluateLocal(this.plugin.app, pkg, query, thisFull)
          : await evaluateCli(this.plugin, pkg, query, thisFull);
      if (myRunId !== this.runId) return; // a newer run started (or we unloaded) while this one was in flight
      const elapsedMs = performance.now() - start;
      renderResults(this.plugin, this.containerEl, pkg, query, nodes, source, elapsedMs);
    } catch (err) {
      if (myRunId !== this.runId) return;
      renderRuntimeError(this.plugin, this.containerEl, pkg, err);
    }
  }
}

// ---- error rendering -----------------------------------------------------------------------

function renderParseErrors(el: HTMLElement, errors: string[]): void {
  el.empty();
  const box = el.createDiv({ cls: 'vaire-error vaire-query-error' });
  box.createDiv({ text: errors.length > 1 ? 'Vairë query errors:' : 'Vairë query error:' });
  const list = box.createEl('ul');
  for (const message of errors) list.createEl('li', { text: message });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderRuntimeError(plugin: VairePlugin, el: HTMLElement, pkg: PackageInfo, err: unknown): void {
  el.empty();
  const box = el.createDiv({ cls: 'vaire-error vaire-query-error' });
  if (err instanceof VaireError && err.kind === 'index_not_built') {
    box.createDiv({ text: 'Index not built.' });
    const buttonHost = box.createDiv();
    new ButtonComponent(buttonHost).setButtonText('Rebuild index').onClick(() => void plugin.rebuildIndex(pkg));
    return;
  }
  box.createDiv({ text: `Vairë query failed — ${errMessage(err)}` });
}

// ---- results rendering ----------------------------------------------------------------------

function renderResults(
  plugin: VairePlugin,
  el: HTMLElement,
  pkg: PackageInfo,
  query: ParsedQuery,
  nodes: QueryNode[],
  source: 'local' | 'cli',
  elapsedMs: number,
): void {
  el.empty();
  const container = el.createDiv({ cls: 'vaire-query' });

  if (nodes.length === 0) {
    container.createDiv({ cls: 'vaire-empty', text: 'No matches.' });
  } else if (query.show === 'table') {
    container.appendChild(buildTable(plugin, pkg, query, nodes));
  } else {
    container.appendChild(buildList(plugin, pkg, nodes));
  }

  container.appendChild(buildFooter(nodes.length, source, elapsedMs));
}

function buildList(plugin: VairePlugin, pkg: PackageInfo, nodes: QueryNode[]): HTMLElement {
  const list = createEl('ul', { cls: 'vaire-query-list' });
  for (const node of nodes) {
    const li = list.createEl('li');
    li.appendChild(createRefElement(plugin, node.ref, { repo: pkg.absRoot }));
  }
  return list;
}

function buildTable(plugin: VairePlugin, pkg: PackageInfo, query: ParsedQuery, nodes: QueryNode[]): HTMLElement {
  const columns = columnsFor(query);
  const table = createEl('table', { cls: 'vaire-query-table' });

  const thead = table.createEl('thead');
  const headRow = thead.createEl('tr');
  for (const col of columns) {
    headRow.createEl('th', { text: col === 'name' || col === 'type' ? col : humanizeKey(col) });
  }

  const tbody = table.createEl('tbody');
  for (const node of nodes) {
    const row = tbody.createEl('tr');
    for (const col of columns) {
      const cell = row.createEl('td');
      if (col === 'name') {
        cell.appendChild(createRefElement(plugin, node.ref, { repo: pkg.absRoot }));
      } else if (col === 'type') {
        cell.textContent = node.ref.kind === 'id' ? node.ref.type : (node.ref.typeHint ?? '?');
      } else {
        renderCellValue(plugin, pkg.absRoot, cell, node.frontmatter[col]);
      }
    }
  }
  return table;
}

/** A cell's raw frontmatter value: list values stack one per line, ref-shaped strings render
 *  through `createRefElement` exactly like everywhere else in the plugin. */
function renderCellValue(plugin: VairePlugin, repo: string, cell: HTMLElement, raw: unknown): void {
  if (raw === undefined || raw === null || raw === '') {
    cell.createSpan({ cls: 'vaire-muted', text: '—' });
    return;
  }
  const items = Array.isArray(raw) ? raw : [raw];
  items.forEach((item, i) => {
    if (i > 0) cell.createEl('br');
    if (typeof item === 'string') {
      const ref = parseRef(item);
      if (ref) {
        cell.appendChild(createRefElement(plugin, ref, { repo }));
        return;
      }
    }
    cell.createSpan({ text: String(item) });
  });
}

function buildFooter(count: number, source: 'local' | 'cli', elapsedMs: number): HTMLElement {
  const plural = count === 1 ? 'match' : 'matches';
  return createDiv({
    cls: 'vaire-query-footer vaire-muted',
    text: `${count} ${plural} · source: ${source} · ${Math.round(elapsedMs)}ms`,
  });
}
