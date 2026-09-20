// Modal used both by "Link selection" and by loose-end resolution (`registerSuggestions`'s
// `plugin.hooks.resolveLooseEnd`). Prefilled with a descriptor, it narrows CLI suggestions by
// `typeHint` when given. See DESIGN.md "Suggestions" §2.

import { SuggestModal } from 'obsidian';
import { NewNodeModal } from '../authoring/new-node-modal';
import type VairePlugin from '../main';
import type { LocalNode, PackageInfo } from '../packages';
import type { Suggestion } from '../types';
import { type Candidate, mergeCandidates } from './pure';

/** Synthetic "Create new node…" item, always shown first — see `onChooseSuggestion`. */
const CREATE_CANDIDATE: Candidate = { id: '', name: 'Create new node…', type: '', source: 'create' };

const CLI_DEBOUNCE_MS = 250;
const CLI_MIN_QUERY_LENGTH = 2;
const CLI_LIMIT = 10;
const LOCAL_LIMIT = 8;
const LOCAL_LIMIT_EMPTY = 20;

function localToCandidate(node: LocalNode): Candidate {
  return { id: node.full, name: node.name, type: node.type, source: 'local' };
}

// `Suggestion.id` from the CLI already carries the `@pkg/` prefix when `package` is set.
function cliToCandidate(s: Suggestion): Candidate {
  return { id: s.id, name: s.name, type: s.type, pkg: s.package, source: 'cli', score: s.score };
}

export class VaireResolveModal extends SuggestModal<Candidate> {
  private readonly plugin: VairePlugin;
  private readonly pkg: PackageInfo;
  private readonly descriptor: string;
  private readonly typeHint?: string;
  private readonly onPick: (candidate: Candidate) => void;
  /** Applied to every candidate (local and CLI alike) before it reaches the list, e.g. to
   *  keep a "pick a successor" flow to same-package, non-self candidates only. Never excludes
   *  the synthetic "Create new node…" item — see `CREATE_CANDIDATE`. */
  private readonly filter?: (candidate: Candidate) => boolean;
  /** Bumped on every getSuggestions call; a stale (superseded) CLI response is discarded. */
  private seq = 0;

  constructor(
    plugin: VairePlugin,
    pkg: PackageInfo,
    descriptor: string,
    typeHint: string | undefined,
    onPick: (candidate: Candidate) => void,
    filter?: (candidate: Candidate) => boolean,
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.pkg = pkg;
    this.descriptor = descriptor;
    this.typeHint = typeHint;
    this.onPick = onPick;
    this.filter = filter;
    this.setPlaceholder(typeHint ? `Resolve to a ${typeHint}…` : 'Resolve to…');
  }

  onOpen(): void {
    super.onOpen();
    // Prefill with the descriptor and kick off suggestions for it immediately.
    this.inputEl.value = this.descriptor;
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async getSuggestions(query: string): Promise<Candidate[]> {
    const q = query.trim();

    const localNodes = q
      ? this.pkg.index.search(q, LOCAL_LIMIT)
      : [...this.pkg.index.all()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, LOCAL_LIMIT_EMPTY);
    const local = localNodes.map(localToCandidate);

    let merged: Candidate[];
    if (q.length < CLI_MIN_QUERY_LENGTH) {
      merged = [CREATE_CANDIDATE, ...local];
    } else {
      const cli = await this.cliSuggestions(q);
      merged = [CREATE_CANDIDATE, ...mergeCandidates(local, cli)];
    }
    return this.filter ? merged.filter((c) => c.source === 'create' || this.filter!(c)) : merged;
  }

  private async cliSuggestions(query: string): Promise<Candidate[]> {
    const mySeq = ++this.seq;
    await new Promise((resolve) => window.setTimeout(resolve, CLI_DEBOUNCE_MS));
    if (mySeq !== this.seq) return [];

    try {
      let result = await this.plugin.cli.suggest(this.pkg.absRoot, query, {
        type: this.typeHint,
        limit: CLI_LIMIT,
        all: this.plugin.settings.suggestAll,
      });
      if (this.typeHint && result.suggestions.length === 0) {
        // The type hint might be wrong, or just narrower than what's actually indexed — fall
        // back to an untyped suggest rather than showing nothing.
        result = await this.plugin.cli.suggest(this.pkg.absRoot, query, {
          limit: CLI_LIMIT,
          all: this.plugin.settings.suggestAll,
        });
      }
      if (mySeq !== this.seq) return [];
      return result.suggestions.map(cliToCandidate);
    } catch (err) {
      console.debug('vaire: cli.suggest failed', err);
      return [];
    }
  }

  renderSuggestion(candidate: Candidate, el: HTMLElement): void {
    if (candidate.source === 'create') {
      const item = el.createDiv({ cls: 'vaire-suggest-item vaire-suggest-create' });
      item.createSpan({ cls: 'vaire-suggest-create-icon', text: '+' });
      item.createSpan({ cls: 'vaire-suggest-name', text: candidate.name });
      return;
    }
    const item = el.createDiv({ cls: 'vaire-suggest-item' });
    item.createSpan({ cls: 'vaire-suggest-name', text: candidate.name });
    item.createEl('code', { cls: 'vaire-suggest-id', text: candidate.id });
    if (candidate.pkg) item.createSpan({ cls: 'vaire-suggest-pkg', text: `@${candidate.pkg}` });
  }

  onChooseSuggestion(candidate: Candidate): void {
    if (candidate.source === 'create') {
      new NewNodeModal(this.plugin, this.pkg, {
        defaultType: this.typeHint,
        defaultName: this.descriptor,
        onCreated: (result) => {
          this.onPick({ id: result.fullId, name: result.name, type: result.type, source: 'local' });
        },
      }).open();
      return;
    }
    this.onPick(candidate);
  }
}
