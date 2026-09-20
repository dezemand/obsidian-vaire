// `[[?` completion: while typing the type hint, offers the package's types (+ "?" for unknown
// type) to complete `[[?<type>: `; once past the `:` and typing a descriptor of at least 3
// characters, offers live `cli.suggest` matches labeled "use existing: <name>" so authors are
// nudged to link a real node instead of leaving a loose end. Registered alongside
// `VaireLinkSuggest` (src/suggest/index.ts); that suggester already ignores `?`-prefixed
// queries, so the two never compete for the same keystroke. See DESIGN.md "Suggestions" §2.

import type { Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import { EditorSuggest } from 'obsidian';
import type VairePlugin from '../main';
import type { Suggestion } from '../types';
import {
  type Candidate,
  type LooseEndTrigger,
  looseEndExistingReplacement,
  looseEndTypeChoices,
  looseEndTypeInsertText,
  triggerLooseEnd,
} from './pure';

const CLI_DEBOUNCE_MS = 250;
const DESCRIPTOR_MIN_LENGTH = 3;
const CLI_LIMIT = 8;

export type LooseEndItem = { kind: 'type'; type: string | null } | { kind: 'existing'; candidate: Candidate };

function cliToCandidate(s: Suggestion): Candidate {
  return { id: s.id, name: s.name, type: s.type, pkg: s.package, source: 'cli', score: s.score };
}

export class VaireLooseEndSuggest extends EditorSuggest<LooseEndItem> {
  private readonly plugin: VairePlugin;
  /** Set by `onTrigger`, read by the immediately-following `getSuggestions` call — same
   *  single-slot pattern as `VaireLinkSuggest`'s query cache; there is always exactly one
   *  `getSuggestions` per `onTrigger` and they run on the same tick before any await. */
  private currentTrigger: LooseEndTrigger | null = null;
  /** Bumped on every getSuggestions call; a stale (superseded) CLI response is discarded. */
  private seq = 0;

  constructor(plugin: VairePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) return null;
    if (!this.plugin.packages.packageFor(file)) return null;
    const lineUpToCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
    const trigger = triggerLooseEnd(lineUpToCursor);
    this.currentTrigger = trigger;
    if (!trigger) return null;

    const openIdx = lineUpToCursor.lastIndexOf('[[?');
    if (openIdx < 0) return null;

    if ('typeQuery' in trigger) {
      // Replace only the type-hint text typed so far, right after "[[?".
      return { start: { line: cursor.line, ch: openIdx + 3 }, end: cursor, query: trigger.typeQuery };
    }
    // Replace everything after "[[" ("?type: descriptor") — an "existing node" pick rewrites
    // the whole loose-end shape, not just the descriptor tail.
    return { start: { line: cursor.line, ch: openIdx + 2 }, end: cursor, query: trigger.descriptor };
  }

  async getSuggestions(ctx: EditorSuggestContext): Promise<LooseEndItem[]> {
    const pkg = this.plugin.packages.packageFor(ctx.file);
    const trigger = this.currentTrigger;
    if (!pkg || !trigger) return [];

    if ('typeQuery' in trigger) {
      return looseEndTypeChoices(pkg.types, trigger.typeQuery).map((type) => ({ kind: 'type', type }) as const);
    }

    const descriptor = trigger.descriptor.trim();
    if (descriptor.length < DESCRIPTOR_MIN_LENGTH) return [];

    const mySeq = ++this.seq;
    await new Promise((resolve) => window.setTimeout(resolve, CLI_DEBOUNCE_MS));
    if (mySeq !== this.seq) return [];

    try {
      const result = await this.plugin.cli.suggest(pkg.absRoot, descriptor, {
        type: trigger.typeHint,
        limit: CLI_LIMIT,
        all: this.plugin.settings.suggestAll,
      });
      if (mySeq !== this.seq) return [];
      return result.suggestions.map((s) => ({ kind: 'existing', candidate: cliToCandidate(s) }) as const);
    } catch (err) {
      console.debug('vaire: cli.suggest failed (loose-end)', err);
      return [];
    }
  }

  renderSuggestion(item: LooseEndItem, el: HTMLElement): void {
    const div = el.createDiv({ cls: 'vaire-suggest-item' });
    if (item.kind === 'type') {
      div.createEl('code', { cls: 'vaire-suggest-id', text: item.type ?? '?' });
      div.createSpan({ cls: 'vaire-muted', text: item.type ? 'type' : 'unknown type' });
      return;
    }
    div.createSpan({ cls: 'vaire-suggest-name', text: `use existing: ${item.candidate.name}` });
    div.createEl('code', { cls: 'vaire-suggest-id', text: item.candidate.id });
    if (item.candidate.pkg) div.createSpan({ cls: 'vaire-suggest-pkg', text: `@${item.candidate.pkg}` });
  }

  selectSuggestion(item: LooseEndItem): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end } = ctx;

    const insertText =
      item.kind === 'type' ? looseEndTypeInsertText(item.type) : looseEndExistingReplacement(item.candidate.id, ctx.query);
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
