// Wires up the suggestions pass: `[[` autocomplete, the search/resolve modals, the
// loose-end-resolution hook, and this pass's commands. See DESIGN.md "Suggestions" §2 and
// "Phase 2 ownership".

import { MarkdownView, Notice, type TFile } from 'obsidian';
import type { LooseRef } from '../ids';
import { parseRef } from '../ids';
import { openRef } from '../navigate';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { VaireLinkSuggest } from './link-suggest';
import { VaireLooseEndSuggest } from './loose-end-suggest';
import { VaireSearchModal } from './search-modal';
import { VaireResolveModal } from './resolve-modal';
import { VaireQuickSwitchModal } from './quick-switch-modal';
import {
  type Candidate,
  findLooseEndAt,
  findLooseEndByDescriptor,
  findWikilinkAt,
  rewriteLooseEnd,
} from './pure';

function activePackage(plugin: VairePlugin): PackageInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  return file ? plugin.packages.packageFor(file) : null;
}

/** `fromRepo` is either a vault `PackageInfo` already, or an absRoot string — either way,
 *  resolve it against the currently-known vault packages (a dependency's root, which is
 *  never a vault package, correctly resolves to null here). */
function packageFromRepo(plugin: VairePlugin, fromRepo: PackageInfo | string): PackageInfo | null {
  const absRoot = typeof fromRepo === 'string' ? fromRepo : fromRepo.absRoot;
  return plugin.packages.all().find((p) => p.absRoot === absRoot) ?? null;
}

/**
 * Finds the file/line of the loose end matching `descriptor` when the caller didn't already
 * know it (i.e. `at` was not passed to the hook — the case for a click on a rendered loose
 * end). Prefers the active editor's cursor line when it actually has a matching loose end
 * there, otherwise searches the whole file.
 */
async function locateLooseEnd(
  plugin: VairePlugin,
  pkg: PackageInfo,
  descriptor: string,
): Promise<{ file: TFile; line: number } | null> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file ?? plugin.app.workspace.getActiveFile();
  if (!file || plugin.packages.packageFor(file) !== pkg) return null;

  if (view?.file === file) {
    const cursorLine = view.editor.getCursor().line;
    if (findLooseEndByDescriptor(view.editor.getLine(cursorLine), descriptor)) {
      return { file, line: cursorLine };
    }
  }

  const content = await plugin.app.vault.read(file);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (findLooseEndByDescriptor(lines[i], descriptor)) return { file, line: i };
  }
  return null;
}

/** Rewrites exactly the loose end matching `descriptor` on `line` of `file` to point at
 *  `candidate.id`, via the live editor when that file is open, else `vault.process`. Exported
 *  so the authoring pass (src/authoring/index.ts, "Create entity from loose end at cursor")
 *  can reuse the same rewrite path after creating the new node. */
export async function applyResolution(
  plugin: VairePlugin,
  file: TFile,
  line: number,
  descriptor: string,
  candidate: Candidate,
): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const liveEditor = view?.file === file ? view.editor : null;

  if (liveEditor) {
    const lineText = liveEditor.getLine(line);
    const occurrence = findLooseEndByDescriptor(lineText, descriptor);
    if (!occurrence) {
      new Notice("Vairë: that loose end has changed — could not resolve it");
      return;
    }
    liveEditor.setLine(line, rewriteLooseEnd(lineText, occurrence, candidate.id));
  } else {
    let resolved = false;
    await plugin.app.vault.process(file, (data) => {
      const lines = data.split('\n');
      const lineText = lines[line];
      if (lineText === undefined) return data;
      const occurrence = findLooseEndByDescriptor(lineText, descriptor);
      if (!occurrence) return data;
      lines[line] = rewriteLooseEnd(lineText, occurrence, candidate.id);
      resolved = true;
      return lines.join('\n');
    });
    if (!resolved) {
      new Notice("Vairë: that loose end has changed — could not resolve it");
      return;
    }
  }
  new Notice(`Resolved to ${candidate.id}`);
}

export function registerSuggestions(plugin: VairePlugin): void {
  plugin.registerEditorSuggest(new VaireLinkSuggest(plugin));
  plugin.registerEditorSuggest(new VaireLooseEndSuggest(plugin));

  plugin.hooks.resolveLooseEnd = async (
    ref: LooseRef,
    fromRepo: PackageInfo | string,
    at?: { file: TFile; line: number },
  ) => {
    const pkg = packageFromRepo(plugin, fromRepo);
    if (!pkg) {
      new Notice('Loose ends can only be resolved in vault packages');
      return;
    }

    const location = at ?? (await locateLooseEnd(plugin, pkg, ref.descriptor));
    if (!location) {
      new Notice('Vairë: could not find that loose end in the file');
      return;
    }

    new VaireResolveModal(plugin, pkg, ref.descriptor, ref.typeHint, (candidate) => {
      void applyResolution(plugin, location.file, location.line, ref.descriptor, candidate);
    }).open();
  };

  plugin.addCommand({
    id: 'vaire-search',
    name: 'Search',
    checkCallback: (checking) => {
      const pkg = activePackage(plugin) ?? plugin.packages.all()[0] ?? null;
      if (!pkg) return false;
      if (!checking) new VaireSearchModal(plugin, pkg).open();
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-link-selection',
    name: 'Link selection',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      const selection = editor.getSelection();
      if (!pkg || !selection.trim()) return false;
      if (!checking) {
        new VaireResolveModal(plugin, pkg, selection, undefined, (candidate) => {
          editor.replaceSelection(`[[${candidate.id}|${selection}]]`);
        }).open();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-resolve-loose-end',
    name: 'Resolve loose end at cursor',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg || !file) return false;
      const cursor = editor.getCursor();
      const occurrence = findLooseEndAt(editor.getLine(cursor.line), cursor.ch);
      if (!occurrence) return false;
      if (!checking) {
        const parsed = parseRef(occurrence.inner);
        if (parsed?.kind === 'loose') {
          void plugin.hooks.resolveLooseEnd?.(parsed, pkg, { file, line: cursor.line });
        }
      }
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-quick-switch',
    name: 'Quick switch to node',
    hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'O' }],
    checkCallback: (checking) => {
      if (plugin.packages.all().length === 0) return false;
      if (!checking) new VaireQuickSwitchModal(plugin).open();
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-quick-switch-insert-link',
    name: 'Insert link to node…',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg) return false;
      if (!checking) {
        new VaireQuickSwitchModal(plugin, {
          mode: 'insert',
          onInsert: (item) => {
            const text = plugin.settings.insertDisplayText ? `[[${item.id}|${item.name}]]` : `[[${item.id}]]`;
            editor.replaceSelection(text);
          },
        }).open();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: 'vaire-open-node-under-cursor',
    name: 'Open node under cursor',
    editorCheckCallback: (checking, editor, ctx) => {
      const file = ctx.file;
      const pkg = file ? plugin.packages.packageFor(file) : null;
      if (!pkg || !file) return false;
      const cursor = editor.getCursor();
      const occurrence = findWikilinkAt(editor.getLine(cursor.line), cursor.ch);
      if (!occurrence) return false;
      const ref = parseRef(occurrence.inner);
      if (!ref) return false;
      // openRef itself routes loose ends to `hooks.resolveLooseEnd` (set above). originScope
      // enables the same scope-first resolution reading mode uses for a bare `[[type:local]]`
      // (see resolveLocalRef, src/packages.ts) — trivially available here since `pkg`/`file`
      // are already at hand.
      if (!checking) void openRef(plugin, ref, pkg, { originScope: pkg.index.byFile(file)?.scope });
      return true;
    },
  });
}
