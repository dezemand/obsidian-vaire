// The Vairë quick switcher (`feat/quick-switcher`): a `FuzzySuggestModal<NodeItem>` over every
// node in every vault package, with up to 5 CLI-suggested dependency hits appended once the
// query is long enough. Extends DESIGN.md's "Suggestions" §2 (this branch's own feature, not
// yet folded into DESIGN.md). See `quick-switch-pure.ts` for the pure logic this modal is a
// thin `obsidian` wrapper around.
//
// `FuzzySuggestModal.getItems()`/`getSuggestions()` are synchronous (see obsidian.d.ts — unlike
// `SuggestModal.getSuggestions`, `FuzzySuggestModal`'s concrete override returns
// `FuzzyMatch<T>[]`, not a `Promise`), so the CLI-backed dependency hits can't simply be
// `await`ed inside `getSuggestions` the way `link-suggest.ts`/`search-modal.ts` do. Instead we
// keep a `cliItems` array that a debounced async fetch refreshes in place, and after it lands
// call `updateSuggestions()` to make the popup re-render against the new data. That method is
// not part of the public `SuggestModal` API surface (there is no such member in
// obsidian.d.ts) — it is, however, present at runtime on every `SuggestModal` instance (the
// underlying `Suggest` popover exposes it, and community plugins doing live-refreshing
// FuzzySuggestModals rely on the same call). It is the one non-public API this modal uses,
// called through an optional-chained cast so a future Obsidian version that removes or renames
// it merely stops the live-refresh instead of throwing.

import { FuzzySuggestModal, Notice, prepareFuzzySearch, renderMatches, type FuzzyMatch, type Instruction } from 'obsidian';
import { parseRef } from '../ids';
import type VairePlugin from '../main';
import { openFileAtLine, openRef } from '../navigate';
import type { PackageInfo } from '../packages';
import {
  filterQuickItems,
  itemSearchSegments,
  itemSearchText,
  localNodeToItem,
  matchesInRange,
  mergeCliItems,
  parseQuickQuery,
  sortItems,
  suggestionToNodeItem,
  type NodeItem,
} from './quick-switch-pure';

const CLI_DEBOUNCE_MS = 250;
const CLI_MIN_QUERY_LENGTH = 3;
const CLI_LIMIT = 5;

const OPEN_INSTRUCTIONS: Instruction[] = [
  { command: '↵', purpose: 'Open' },
  { command: 'shift ↵', purpose: 'Open in new pane' },
  { command: 'ctrl/cmd ↵', purpose: 'Copy id' },
];
const INSERT_INSTRUCTIONS: Instruction[] = [{ command: '↵', purpose: 'Insert link' }];

export interface QuickSwitchOptions {
  /** `'insert'` turns choosing an item into "insert a link at the cursor" instead of opening
   *  it — used by the `vaire-quick-switch-insert-link` editor command. Defaults to `'open'`. */
  mode?: 'open' | 'insert';
  /** Required when `mode: 'insert'`; ignored otherwise. */
  onInsert?: (item: NodeItem) => void;
}

function collectLocalItems(plugin: VairePlugin): NodeItem[] {
  const items: NodeItem[] = [];
  for (const pkg of plugin.packages.all()) {
    for (const node of pkg.index.all()) items.push(localNodeToItem(node, pkg));
  }
  return items;
}

export class VaireQuickSwitchModal extends FuzzySuggestModal<NodeItem> {
  private readonly plugin: VairePlugin;
  private readonly mode: 'open' | 'insert';
  private readonly onInsert?: (item: NodeItem) => void;

  /** Snapshotted once at open time — instant, per DESIGN.md; the modal is short-lived so this
   *  doesn't need to track later `LocalIndex` changes while it's open. */
  private readonly localItems: NodeItem[];

  /** CLI-suggested dependency hits for the current query text, refreshed asynchronously
   *  (debounced) by `maybeFetchCli`; `getSuggestions` reads it synchronously. Always
   *  `@pkg/`-prefixed (`suggestionToNodeItem` preserves the CLI's own prefixing) and cleared
   *  whenever the query drops below the 3-character threshold. */
  private cliItems: NodeItem[] = [];
  /** The package a `cliItems` hit should be opened/resolved against (the package `cli.suggest`
   *  was run for) — needed because `openRef` resolves a `@pkg/…` id's dependency root relative
   *  to the *origin* package, not the id's own package. */
  private cliOriginPkg: PackageInfo | null = null;
  /** `<absRoot>\0<text>` of the in-flight/most-recent CLI fetch, so an unchanged query (e.g.
   *  backspace then retype) doesn't re-debounce. */
  private cliQueryKey: string | null = null;
  /** Bumped on every fetch kicked off; a stale (superseded) debounce/response is discarded. */
  private cliSeq = 0;

  constructor(plugin: VairePlugin, opts: QuickSwitchOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = opts.mode ?? 'open';
    this.onInsert = opts.onInsert;
    this.localItems = collectLocalItems(plugin);
    this.emptyStateText = 'No matching node.';
    this.setPlaceholder(
      this.mode === 'insert' ? 'Insert link to node…' : 'Quick switch to node… (type: filter, @pkg filter)',
    );
    this.setInstructions(this.mode === 'insert' ? INSERT_INSTRUCTIONS : OPEN_INSTRUCTIONS);
  }

  // ---- FuzzySuggestModal contract --------------------------------------------------------

  getItems(): NodeItem[] {
    return this.localItems;
  }

  getItemText(item: NodeItem): string {
    return itemSearchText(item);
  }

  /**
   * Overridden rather than left to the default `FuzzySuggestModal` implementation, because the
   * default fuzzy-matches the *raw* query text against `getItemText`, which would treat a
   * `type:`/`@pkg` prefix as literal characters to subsequence-match instead of as a hard
   * filter — see `parseQuickQuery`'s doc comment. This also merges in the CLI-backed
   * `cliItems` below the local results, which the default implementation has no notion of.
   */
  getSuggestions(query: string): FuzzyMatch<NodeItem>[] {
    const parsed = parseQuickQuery(query);
    const text = parsed.text.trim();

    this.maybeFetchCli(text);

    const filteredLocal = filterQuickItems(this.localItems, parsed);
    const filteredCli = filterQuickItems(this.cliItems, parsed);

    if (!text) {
      const ordered = sortItems(filteredLocal);
      const merged = mergeCliItems(ordered, filteredCli);
      return merged.map((item) => ({ item, match: { score: 0, matches: [] } }));
    }

    const matcher = prepareFuzzySearch(text);
    const scoredLocal: FuzzyMatch<NodeItem>[] = [];
    for (const item of filteredLocal) {
      const result = matcher(this.getItemText(item));
      if (result) scoredLocal.push({ item, match: result });
    }
    // Best match first; superseded nodes always sort last regardless of score, mirroring
    // `sortItems`'s convention for the no-query browsing case.
    scoredLocal.sort((a, b) => {
      if (a.item.superseded !== b.item.superseded) return a.item.superseded ? 1 : -1;
      return b.match.score - a.match.score;
    });

    const matchByItem = new Map(scoredLocal.map((m) => [m.item, m.match]));
    const merged = mergeCliItems(
      scoredLocal.map((m) => m.item),
      filteredCli,
    );
    return merged.map((item) => {
      const match = matchByItem.get(item) ?? matcher(this.getItemText(item)) ?? { score: 0, matches: [] };
      return { item, match };
    });
  }

  renderSuggestion(fuzzyMatch: FuzzyMatch<NodeItem>, el: HTMLElement): void {
    const item = fuzzyMatch.item;
    const segments = itemSearchSegments(item);
    const row = el.createDiv({ cls: 'vaire-suggest-item' + (item.superseded ? ' vaire-gone' : '') });

    const nameEl = row.createSpan({ cls: 'vaire-suggest-name' });
    const nameMatches = matchesInRange(fuzzyMatch.match.matches, segments.nameRange);
    renderMatches(nameEl, item.name, nameMatches.length ? nameMatches : null);

    row.createSpan({ cls: 'vaire-suggest-type', text: item.type });
    row.createEl('code', { cls: 'vaire-suggest-id', text: item.id });

    // A dependency hit is always from a different package by construction (it only survives
    // `mergeCliItems` when `@pkg/`-prefixed) — worth badging regardless of vault package count,
    // since that's how the reader tells it apart from the local results above it. A local item
    // only needs the badge when there's actual ambiguity about which package it's in.
    const showPkgBadge = item.pkgName && (item.source === 'cli' || this.plugin.packages.all().length > 1);
    if (showPkgBadge) row.createSpan({ cls: 'vaire-suggest-pkg', text: `@${item.pkgName}` });

    if (item.aliases.length && matchesInRange(fuzzyMatch.match.matches, segments.aliasesRange).length > 0) {
      row.createDiv({ cls: 'vaire-suggest-aliases', text: item.aliases.join(', ') });
    }
  }

  onChooseItem(item: NodeItem, evt: MouseEvent | KeyboardEvent): void {
    if (this.mode === 'insert') {
      this.onInsert?.(item);
      return;
    }
    if (evt.metaKey || evt.ctrlKey) {
      void this.copyId(item);
      return;
    }
    void this.openItem(item, evt.shiftKey);
  }

  // ---- CLI-backed dependency hits ---------------------------------------------------------

  private activePkg(): PackageInfo | null {
    const file = this.plugin.app.workspace.getActiveFile();
    const filePkg = file ? this.plugin.packages.packageFor(file) : null;
    return filePkg ?? this.plugin.packages.all()[0] ?? null;
  }

  /** `text` is `parseQuickQuery(query).text.trim()` — the query with any `type:`/`@pkg` prefix
   *  already stripped, matching what the local fuzzy match runs against, rather than the raw
   *  typed query (which would send a literal `type:` fragment to the CLI as part of the
   *  descriptor). */
  private maybeFetchCli(text: string): void {
    if (!this.plugin.settings.quickSwitchIncludeDependencies || text.length < CLI_MIN_QUERY_LENGTH) {
      if (this.cliItems.length) this.cliItems = [];
      this.cliQueryKey = null;
      this.cliOriginPkg = null;
      return;
    }
    const pkg = this.activePkg();
    if (!pkg) return;
    const key = `${pkg.absRoot}\u0000${text}`;
    if (key === this.cliQueryKey) return; // already fetched (or in flight) for this exact text
    this.cliQueryKey = key;
    const mySeq = ++this.cliSeq;
    window.setTimeout(() => {
      if (mySeq !== this.cliSeq) return; // superseded by a later keystroke before the debounce elapsed
      void this.runCliFetch(pkg, text, mySeq);
    }, CLI_DEBOUNCE_MS);
  }

  private async runCliFetch(pkg: PackageInfo, text: string, mySeq: number): Promise<void> {
    try {
      const result = await this.plugin.cli.suggest(pkg.absRoot, text, { limit: CLI_LIMIT });
      if (mySeq !== this.cliSeq) return; // stale
      this.cliItems = result.suggestions.map(suggestionToNodeItem);
      this.cliOriginPkg = pkg;
    } catch (err) {
      console.debug('vaire: quick switch cli.suggest failed', err);
      if (mySeq !== this.cliSeq) return;
      this.cliItems = [];
    }
    this.refreshSuggestions();
  }

  /** See the module doc comment: the one non-public `SuggestModal` call this modal makes. */
  private refreshSuggestions(): void {
    (this as unknown as { updateSuggestions?: () => void }).updateSuggestions?.();
  }

  // ---- choosing an item --------------------------------------------------------------------

  private async openItem(item: NodeItem, newLeaf: boolean): Promise<void> {
    if (item.source === 'local' && item.local) {
      await openFileAtLine(this.plugin.app, item.local.node.file, undefined, newLeaf);
      return;
    }
    const ref = parseRef(item.id);
    if (!ref) {
      new Notice(`Vairë: could not parse id ${item.id}`);
      return;
    }
    const repo = this.cliOriginPkg ?? this.activePkg();
    if (!repo) {
      new Notice('Vairë: no package to resolve this reference against');
      return;
    }
    await openRef(this.plugin, ref, repo, { newLeaf });
  }

  private async copyId(item: NodeItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.id);
      new Notice(`Copied ${item.id}`);
    } catch {
      new Notice('Vairë: could not copy to the clipboard');
    }
  }
}
