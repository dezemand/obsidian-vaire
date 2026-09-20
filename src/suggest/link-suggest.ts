// `[[` autocomplete: instant local-index results merged with CLI-backed suggestions once the
// query is long enough. See DESIGN.md "Suggestions" §2.

import type { Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import { EditorSuggest } from 'obsidian';
import type VairePlugin from '../main';
import type { LocalNode } from '../packages';
import type { Suggestion } from '../types';
import { type Candidate, completionInsertText, mergeCandidates, triggerQuery } from './pure';

const CLI_DEBOUNCE_MS = 250;
const CLI_MIN_QUERY_LENGTH = 2;
const LOCAL_LIMIT = 8;
const LOCAL_LIMIT_EMPTY = 20;

function localToCandidate(node: LocalNode): Candidate {
  return { id: node.full, name: node.name, type: node.type, source: 'local' };
}

// `Suggestion.id` from the CLI already carries the `@pkg/` prefix when `package` is set
// (verified against the live 0.3.2 binary), so no manual prefixing is needed here.
function cliToCandidate(s: Suggestion): Candidate {
  return { id: s.id, name: s.name, type: s.type, pkg: s.package, source: 'cli', score: s.score };
}

export class VaireLinkSuggest extends EditorSuggest<Candidate> {
  private readonly plugin: VairePlugin;
  /** Bumped on every getSuggestions call; a stale (superseded) CLI response is discarded. */
  private seq = 0;
  /** Single-slot cache of the last CLI query for this package, so re-showing the same query
   *  (e.g. backspace then retype) doesn't re-debounce. */
  private lastQueryKey: string | null = null;
  private lastQueryResult: Candidate[] = [];

  constructor(plugin: VairePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) return null;
    if (!this.plugin.packages.packageFor(file)) return null;
    const trigger = triggerQuery(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!trigger) return null;
    return { start: { line: cursor.line, ch: trigger.startCh }, end: cursor, query: trigger.query };
  }

  async getSuggestions(ctx: EditorSuggestContext): Promise<Candidate[]> {
    const pkg = this.plugin.packages.packageFor(ctx.file);
    if (!pkg) return [];
    const query = ctx.query;

    const localNodes = query
      ? pkg.index.search(query, LOCAL_LIMIT)
      : [...pkg.index.all()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, LOCAL_LIMIT_EMPTY);
    const local = localNodes.map(localToCandidate);

    if (query.length < CLI_MIN_QUERY_LENGTH) return local;

    const cli = await this.cliSuggestions(pkg.absRoot, query);
    return mergeCandidates(local, cli);
  }

  private async cliSuggestions(absRoot: string, query: string): Promise<Candidate[]> {
    const key = `${absRoot}\u0000${query}`;
    if (this.lastQueryKey === key) return this.lastQueryResult;

    const mySeq = ++this.seq;
    await new Promise((resolve) => window.setTimeout(resolve, CLI_DEBOUNCE_MS));
    if (mySeq !== this.seq) return []; // superseded by a later keystroke

    try {
      const result = await this.plugin.cli.suggest(absRoot, query, {
        limit: this.plugin.settings.suggestLimit,
        all: this.plugin.settings.suggestAll,
      });
      if (mySeq !== this.seq) return [];
      const candidates = result.suggestions.map(cliToCandidate);
      this.lastQueryKey = key;
      this.lastQueryResult = candidates;
      return candidates;
    } catch (err) {
      console.debug('vaire: cli.suggest failed', err);
      return [];
    }
  }

  renderSuggestion(candidate: Candidate, el: HTMLElement): void {
    const item = el.createDiv({ cls: 'vaire-suggest-item' });
    item.createSpan({ cls: 'vaire-suggest-name', text: candidate.name });
    item.createEl('code', { cls: 'vaire-suggest-id', text: candidate.id });
    if (candidate.pkg) item.createSpan({ cls: 'vaire-suggest-pkg', text: `@${candidate.pkg}` });
  }

  selectSuggestion(candidate: Candidate): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end } = ctx;
    const insertText = completionInsertText(candidate.id, candidate.name, this.plugin.settings.insertDisplayText);
    editor.replaceRange(insertText, start, end);

    const afterPos: EditorPosition = { line: start.line, ch: start.ch + insertText.length };
    const nextTwo = editor.getRange(afterPos, { line: afterPos.line, ch: afterPos.ch + 2 });
    if (nextTwo !== ']]') {
      editor.replaceRange(']]', afterPos, afterPos);
    }
    editor.setCursor({ line: afterPos.line, ch: afterPos.ch + 2 });
    this.close();
  }
}
