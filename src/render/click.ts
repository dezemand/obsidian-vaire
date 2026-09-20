// Capture-phase click router for live preview / source mode. Reading mode needs no router
// here: `ref-el.ts` binds its own listener on every element it creates (or, for a genuine
// local hit, rewires `href` so Obsidian's own handling takes over) — see DESIGN.md
// "Features §1 Rendering, Click interception".
//
// In live preview, Obsidian renders a still-raw `[[type:id]]` as plain text styled with
// `cm-hmd-internal-link`/`cm-underline` (our own mark decorations from live.ts layer on top
// but don't replace this), and its default click handling would try to open/create a note
// literally named `type:id`. This listener intercepts that click, re-derives which
// `[[...]]` span was hit from the CM6 view (there is no DOM anchor to read `href` off of in
// live preview), and routes Vairë refs through `openRef` / the loose-end resolver instead.
//
// `feat/lp-inline-names` ("B" variant) adds a second live-preview element: `live.ts`'s
// inline-replace widget, `.vaire-lp-inline`, a real DOM element *we* built (unlike the
// `cm-hmd-internal-link` span above, which is Obsidian's own). It already carries
// `data-vaire-ref`/`data-vaire-repo`, so routing it doesn't need `posAtCoords` at all — just
// `parseRef` on the attribute. Plain click opens the ref (matching reading mode); Alt-click
// instead places the cursor at the link's start so the raw `[[type:id]]` text — hidden by the
// replace decoration — becomes editable again (the next decoration rebuild sees the cursor on
// that line and switches it to the raw+suffix mark treatment).

import { MarkdownView, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { parseRef } from '../ids';
import { openRef } from '../navigate';
import { findWikilinkSpan } from './pure';
import type VairePlugin from '../main';

export function registerClickRouter(plugin: VairePlugin): void {
  plugin.registerDomEvent(
    document,
    'click',
    (ev) => {
      handleClick(plugin, ev);
    },
    { capture: true },
  );
}

function handleClick(plugin: VairePlugin, ev: MouseEvent): void {
  const target = ev.target;
  if (!(target instanceof Element)) return;

  const editorEl = target.closest('.cm-editor');
  if (!editorEl) return; // reading mode — nothing to do here

  const inlineEl = target.closest<HTMLElement>('.vaire-lp-inline');
  if (inlineEl) {
    handleInlineWidgetClick(plugin, ev, inlineEl);
    return;
  }

  const linkEl = target.closest('.cm-hmd-internal-link, .cm-underline');
  if (!linkEl) return;

  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return;

  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  if (!cm) return;

  let pos: number | null;
  try {
    pos = cm.posAtCoords({ x: ev.clientX, y: ev.clientY });
  } catch {
    return;
  }
  if (pos == null) return;

  const line = cm.state.doc.lineAt(pos);
  const span = findWikilinkSpan(line.text, pos - line.from);
  if (!span) return;

  const ref = parseRef(span.inner);
  if (!ref) return; // not a Vairë ref — let Obsidian handle its own internal link

  const file = view.file;
  if (!(file instanceof TFile)) return;
  const pkg = plugin.packages.packageFor(file);
  if (!pkg) return;

  ev.preventDefault();
  ev.stopPropagation();

  const newLeaf = ev.metaKey || ev.ctrlKey;

  if (ref.kind === 'loose') {
    // Route through the hook directly (rather than `openRef`) so the resolver knows which
    // occurrence was clicked — `openRef` only forwards `(ref, fromRepo)`, dropping location.
    if (plugin.hooks.resolveLooseEnd) {
      void plugin.hooks.resolveLooseEnd(ref, pkg, { file, line: line.number - 1 });
    } else {
      new Notice('Nothing set up to resolve loose ends yet.');
    }
    return;
  }

  const originScope = pkg.index.byFile(file)?.scope;
  void openRef(plugin, ref, pkg, { newLeaf, originScope });
}

/** Routes a click on a `live.ts` inline-replace widget (`.vaire-lp-inline`). */
function handleInlineWidgetClick(plugin: VairePlugin, ev: MouseEvent, el: HTMLElement): void {
  const rawRef = el.dataset.vaireRef;
  if (!rawRef) return;
  const ref = parseRef(rawRef);
  if (!ref) return;

  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const fileRepo =
    view?.file instanceof TFile ? (plugin.packages.packageFor(view.file)?.absRoot ?? undefined) : undefined;
  const repo = el.dataset.vaireRepo ?? fileRepo;
  if (!repo) return;

  ev.preventDefault();
  ev.stopPropagation();

  const cm = view ? (view.editor as unknown as { cm?: EditorView }).cm : undefined;

  if (ev.altKey) {
    // Reveal the raw text for editing: move the cursor to the start of the replaced range.
    if (!cm) return;
    try {
      const pos = cm.posAtDOM(el);
      cm.dispatch({ selection: { anchor: pos } });
      cm.focus();
    } catch {
      // DOM node not (or no longer) part of this view — nothing sensible to do.
    }
    return;
  }

  const newLeaf = ev.metaKey || ev.ctrlKey;

  if (ref.kind === 'loose') {
    if (!plugin.hooks.resolveLooseEnd) {
      new Notice('Nothing set up to resolve loose ends yet.');
      return;
    }
    const file = view?.file instanceof TFile ? view.file : undefined;
    if (file && cm) {
      try {
        const line = cm.state.doc.lineAt(cm.posAtDOM(el)).number - 1;
        void plugin.hooks.resolveLooseEnd(ref, repo, { file, line });
        return;
      } catch {
        // Fall through to the location-less resolve below.
      }
    }
    void plugin.hooks.resolveLooseEnd(ref, repo);
    return;
  }

  void openRef(plugin, ref, repo, { newLeaf });
}
