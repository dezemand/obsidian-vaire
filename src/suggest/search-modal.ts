// "Search" command modal — full-text search over a package and its dependencies via the
// CLI. See DESIGN.md "Suggestions" §2.

import { Notice, SuggestModal } from 'obsidian';
import { parseRef } from '../ids';
import { openRef } from '../navigate';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import type { SearchHit } from '../types';

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;

export class VaireSearchModal extends SuggestModal<SearchHit> {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly initialQuery?: string;
  /** Bumped on every getSuggestions call; a stale (superseded) response is discarded. */
  private seq = 0;
  private lastErrorMessage: string | null = null;

  /** `initialQuery`, when given, prefills the search box and kicks off results immediately —
   *  used by the `orphan` check finding's "Find references…" quick fix (src/diagnostics/
   *  fixes.ts) to open straight into a search for the orphaned node's name. */
  constructor(plugin: VairePlugin, pkg: PackageInfo, initialQuery?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.initialQuery = initialQuery;
    this.setPlaceholder('Search this package and its dependencies…');
    this.setInstructions([
      { command: '↵', purpose: 'Open' },
      { command: 'shift ↵', purpose: 'Open in new pane' },
    ]);
  }

  onOpen(): void {
    super.onOpen();
    if (!this.initialQuery) return;
    this.inputEl.value = this.initialQuery;
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async getSuggestions(query: string): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];

    const mySeq = ++this.seq;
    await new Promise((resolve) => window.setTimeout(resolve, SEARCH_DEBOUNCE_MS));
    if (mySeq !== this.seq) return [];

    try {
      const result = await this.plugin.cli.search(this.pkg.absRoot, q, { limit: SEARCH_LIMIT });
      if (mySeq !== this.seq) return [];
      this.lastErrorMessage = null;
      return result.results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.lastErrorMessage !== message) {
        this.lastErrorMessage = message;
        new Notice(`Vairë: search failed — ${message}`);
      }
      return [];
    }
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    const item = el.createDiv({ cls: 'vaire-suggest-item' });
    item.createEl('code', { cls: 'vaire-suggest-id vaire-suggest-primary', text: hit.id });
    const local = this.pkg.index.get(hit.id);
    if (local) item.createSpan({ cls: 'vaire-suggest-name', text: local.name });
    item.createSpan({ cls: 'vaire-suggest-type', text: hit.type });
    if (hit.package) item.createSpan({ cls: 'vaire-suggest-pkg', text: `@${hit.package}` });
    const snippet = hit.anchors[0]?.snippet;
    if (snippet) item.createDiv({ cls: 'vaire-suggest-snippet', text: snippet });
  }

  onChooseSuggestion(hit: SearchHit, evt: MouseEvent | KeyboardEvent): void {
    // `hit.id` already carries the `@pkg/` prefix when it lives in a dependency, so it
    // parses straight back into the ref `openRef` needs — no manual prefixing.
    const ref = parseRef(hit.id);
    if (!ref) {
      new Notice(`Vairë: could not parse id ${hit.id}`);
      return;
    }
    void openRef(this.plugin, ref, this.pkg, { newLeaf: evt.shiftKey || evt.metaKey });
  }
}
