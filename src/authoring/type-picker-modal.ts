// Small "pick a type" modal for the "Insert loose end" command: the package's types plus a
// trailing "?" entry for "unknown type" — the same choice set `VaireLooseEndSuggest` offers
// while typing `[[?` (src/suggest/loose-end-suggest.ts), via the same pure filter.

import { App, SuggestModal } from 'obsidian';
import { looseEndTypeChoices } from '../suggest/pure';

export class TypePickerModal extends SuggestModal<string | null> {
  private readonly types: string[];
  private readonly onPick: (type: string | null) => void;

  constructor(app: App, types: string[], onPick: (type: string | null) => void) {
    super(app);
    this.types = types;
    this.onPick = onPick;
    this.setPlaceholder('Type of the thing you are referencing…');
  }

  getSuggestions(query: string): Array<string | null> {
    return looseEndTypeChoices(this.types, query);
  }

  renderSuggestion(type: string | null, el: HTMLElement): void {
    const div = el.createDiv({ cls: 'vaire-suggest-item' });
    div.createEl('code', { cls: 'vaire-suggest-id', text: type ?? '?' });
    div.createSpan({ cls: 'vaire-muted', text: type ? '' : 'unknown type' });
  }

  onChooseSuggestion(type: string | null): void {
    this.onPick(type);
  }
}
