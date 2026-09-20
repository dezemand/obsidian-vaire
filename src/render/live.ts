// Live-preview (CM6) decorations. Two variants live side by side, switched at runtime by
// `settings.livePreviewInlineNames` (default on — this is the "B" branch's own feature):
//
// - **A (suffix, `livePreviewInlineNames: false`)**: the original behavior. Every Vairë
//   `[[...]]` outside the cursor's line gets a `Decoration.mark` (`vaire-lp-link
//   vaire-type-<t>` / `vaire-lp-loose`) with a `data-vaire-name` attribute; CSS renders the
//   resolved name as a subtle `::after` suffix. The cursor's own line is left completely
//   undecorated ("don't disturb the line being edited").
// - **B (inline, default)**: outside the cursor's line, a Vairë ref gets a
//   `Decoration.replace` over the whole `[[...]]` span (brackets included) with a widget
//   that renders like a resolved reading-mode link, hiding the raw `type:id` text entirely.
//   On the cursor's line, it falls back to the same mark+suffix treatment A uses everywhere
//   (not A's "undisturbed" skip — B needs *some* rendering there, since editing requires the
//   raw text to be visible, and the suffix keeps the name in view while it is).
//
// Both variants skip matches inside fenced code blocks or inline code spans — computed once
// per document version and reused across rebuilds (see `computeFencedLines` in pure.ts) — and
// resolve a bare (no `@pkg`) local id scope-first against the edited node's own scope before
// falling back to the global id (see `resolveLocalRef`, src/packages.ts, and DESIGN.md
// "Reference grammar").
//
// Both variants also carry the same `data-vaire-ref`/`data-vaire-repo` (id refs, inside a
// package only — mirrors click.ts's gate) and `data-vaire-descriptor`/`data-vaire-type-hint`
// (loose ends) attributes that ref-el.ts puts on reading-mode elements — mark decorations get
// them as plain attributes, the inline-replace widget bakes them into the element it builds —
// so the hover-preview feature (src/render/hover-preview.ts + preview-data.ts) can read a
// live-preview ref the same way it reads a reading-mode one, without live.ts knowing anything
// about that feature.
//
// Async name resolution (for `@pkg/...` refs with no local node, variant B only) reuses
// `plugin.resolveViaCli`'s own memoization; this module only remembers the resolved *name*
// (module-level `nameCache`, cleared on `index-rebuilt`) so decoration rebuilds — which must
// stay synchronous — can read it directly, and asks CM6 to rebuild (`refreshEffect`) once a
// lookup settles.

import { editorInfoField, TFile, type EventRef } from 'obsidian';
import { RangeSetBuilder, StateEffect, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { parseRef, type IdRef, type LooseRef } from '../ids';
import { resolveLocalRef, type LocalNode, type PackageInfo } from '../packages';
import type VairePlugin from '../main';
import {
  chooseLivePreviewDisplayText,
  computeFencedLines,
  externalTooltip,
  isInlineCodeAtColumn,
  lineIntersectsSelection,
  localTooltip,
  looseTooltip,
  nameFromResolveResult,
  type SimpleRange,
} from './pure';

const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g;

/** Dispatched (with no document/selection change) to force a decoration rebuild. */
export const refreshEffect = StateEffect.define<null>();

// ---- module-level async-name cache --------------------------------------------------------
//
// Keyed by `${absRoot}::${ref.full}`. Populated once a `plugin.resolveViaCli` lookup
// settles; cleared wholesale when any package's index rebuilds (names may have changed).
const nameCache = new Map<string, string>();
// Views waiting on a not-yet-settled lookup for a given key, so every open pane showing the
// same ref gets refreshed (and so a lookup is only ever kicked off once per key).
const pendingByKey = new Map<string, Set<EditorView>>();

function kickOffResolve(plugin: VairePlugin, view: EditorView, pkg: PackageInfo, ref: IdRef, cacheKey: string): void {
  const existing = pendingByKey.get(cacheKey);
  if (existing) {
    existing.add(view);
    return;
  }
  const viewers = new Set<EditorView>([view]);
  pendingByKey.set(cacheKey, viewers);
  plugin.resolveViaCli(pkg.absRoot, ref.full).then(
    (result) => finishResolve(cacheKey, viewers, result ? nameFromResolveResult(result, ref.full) : ref.full),
    () => finishResolve(cacheKey, viewers, ref.full),
  );
}

function finishResolve(cacheKey: string, viewers: Set<EditorView>, name: string): void {
  nameCache.set(cacheKey, name);
  pendingByKey.delete(cacheKey);
  for (const v of viewers) {
    if (v.dom.isConnected) v.dispatch({ effects: refreshEffect.of(null) });
  }
}

// ---- the widget ----------------------------------------------------------------------------

class VaireLinkWidget extends WidgetType {
  constructor(
    private readonly tag: 'a' | 'span',
    private readonly cls: string,
    private readonly text: string,
    private readonly title: string,
    private readonly attrs: Readonly<Record<string, string>>,
  ) {
    super();
  }

  eq(other: VaireLinkWidget): boolean {
    if (this.tag !== other.tag || this.cls !== other.cls || this.text !== other.text || this.title !== other.title) {
      return false;
    }
    const a = this.attrs;
    const b = other.attrs;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.tag);
    el.className = this.cls;
    if (this.title) {
      el.title = this.title;
      el.setAttribute('aria-label', this.title);
    }
    for (const [k, v] of Object.entries(this.attrs)) el.setAttribute(k, v);
    el.textContent = this.text;
    return el;
  }

  ignoreEvent(): boolean {
    // Let clicks reach the document-level capture listener in click.ts.
    return false;
  }
}

// ---- decoration building ---------------------------------------------------------------

type Item =
  | {
      kind: 'mark';
      from: number;
      to: number;
      cls: string;
      name?: string;
      /** Full ref address (`data-vaire-ref`) — only set inside a package, mirrors ref-el.ts. */
      ref?: string;
      /** Resolution root (`data-vaire-repo`) alongside `ref`, read back by hover-preview. */
      repo?: string;
      /** Loose-end descriptor/type hint (`data-vaire-descriptor`/`data-vaire-type-hint`),
       *  mirrors ref-el.ts's `renderLoose` so hover-preview can show the same "Unresolved
       *  reference" content in live preview as it does in reading mode. */
      descriptor?: string;
      typeHint?: string;
    }
  | { kind: 'replace'; from: number; to: number; widget: VaireLinkWidget };

const fenceCache = new WeakMap<Text, boolean[]>();

function getFencedLines(doc: Text): boolean[] {
  const cached = fenceCache.get(doc);
  if (cached) return cached;
  const lines: string[] = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
  const fenced = computeFencedLines(lines);
  fenceCache.set(doc, fenced);
  return fenced;
}

/**
 * Mirrors `ref-el.ts`'s `resolveLocalSync`, but from a `PackageInfo` we already hold.
 * `originScope` enables scope-first resolution of a bare `[[type:local]]`, same as reading
 * mode (see `resolveLocalRef`, src/packages.ts).
 */
function localNodeFor(plugin: VairePlugin, pkg: PackageInfo, ref: IdRef, originScope: string | undefined): LocalNode | null {
  if (!ref.pkg) return resolveLocalRef(pkg, ref, originScope);
  const owner = plugin.packages.byName(ref.pkg);
  return owner ? resolveLocalRef(owner, ref, originScope) : null;
}

function buildLooseWidget(ref: LooseRef, pkg: PackageInfo): VaireLinkWidget {
  const attrs: Record<string, string> = {
    'data-vaire-ref': ref.raw,
    'data-vaire-repo': pkg.absRoot,
    'data-vaire-type-hint': ref.typeHint || '?',
  };
  if (ref.descriptor) attrs['data-vaire-descriptor'] = ref.descriptor;
  const text = ref.display || ref.descriptor || ref.raw;
  return new VaireLinkWidget('span', 'vaire-lp-inline vaire-loose-end', text, looseTooltip(), attrs);
}

function buildIdWidget(
  plugin: VairePlugin,
  view: EditorView,
  pkg: PackageInfo,
  ref: IdRef,
  originScope: string | undefined,
): VaireLinkWidget {
  const local = localNodeFor(plugin, pkg, ref, originScope);
  const cacheKey = `${pkg.absRoot}::${ref.full}`;
  const cachedName = local ? undefined : nameCache.get(cacheKey);
  if (!local && cachedName === undefined) kickOffResolve(plugin, view, pkg, ref, cacheKey);

  const text = chooseLivePreviewDisplayText(ref.display, local?.name, cachedName, ref.full);
  const title = local
    ? localTooltip(ref.full, local.name)
    : cachedName !== undefined
      ? ref.pkg
        ? externalTooltip(ref.full, cachedName, ref.pkg)
        : localTooltip(ref.full, cachedName)
      : ref.full;

  const external = !!ref.pkg && !local;
  const cls = `vaire-lp-inline vaire-link vaire-type-${ref.type}${external ? ' vaire-link-external' : ''}`;
  const attrs: Record<string, string> = {
    'data-vaire-ref': ref.full,
    'data-vaire-type': ref.type,
    'data-vaire-repo': pkg.absRoot,
  };
  if (ref.pkg) attrs['data-vaire-pkg'] = ref.pkg;
  return new VaireLinkWidget('a', cls, text, title, attrs);
}

function collectItems(
  plugin: VairePlugin,
  view: EditorView,
  pkg: PackageInfo | null,
  originScope: string | undefined,
  inlineNames: boolean,
  fencedLines: boolean[],
  selRanges: readonly SimpleRange[],
  from: number,
  to: number,
  out: Item[],
): void {
  const text = view.state.sliceDoc(from, to);
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text))) {
    const inner = match[1];
    const ref = parseRef(inner);
    if (!ref) continue;

    const matchStart = from + match.index + 2; // skip past `[[`
    const matchEnd = matchStart + inner.length;

    const line = view.state.doc.lineAt(matchStart);
    const lineIndex = line.number - 1;
    if (fencedLines[lineIndex]) continue;
    if (isInlineCodeAtColumn(line.text, matchStart - line.from)) continue;

    const onCursorLine = lineIntersectsSelection(line.from, line.to, selRanges);
    const useReplace = inlineNames && !onCursorLine && !!pkg;

    if (!useReplace) {
      if (onCursorLine && !inlineNames) continue; // A: don't disturb the line being edited

      if (ref.kind === 'loose') {
        out.push({
          kind: 'mark',
          from: matchStart,
          to: matchEnd,
          cls: 'vaire-lp-link vaire-lp-loose',
          descriptor: ref.descriptor,
          typeHint: ref.typeHint || '?',
        });
        continue;
      }

      let name: string | undefined;
      if (!ref.display && pkg) name = localNodeFor(plugin, pkg, ref, originScope)?.name;
      // `ref`/`repo` (hence hover-preview eligibility) only make sense inside a package,
      // matching click.ts's own gate on `pkg` for routing these links at all.
      out.push({
        kind: 'mark',
        from: matchStart,
        to: matchEnd,
        cls: `vaire-lp-link vaire-type-${ref.type}`,
        name,
        ref: pkg ? ref.full : undefined,
        repo: pkg ? pkg.absRoot : undefined,
      });
      continue;
    }

    const widget =
      ref.kind === 'loose'
        ? buildLooseWidget(ref, pkg as PackageInfo)
        : buildIdWidget(plugin, view, pkg as PackageInfo, ref, originScope);
    out.push({ kind: 'replace', from: matchStart, to: matchEnd, widget });
  }
}

function buildDecorations(plugin: VairePlugin, view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  const fileInfo = view.state.field(editorInfoField, false);
  const file = fileInfo?.file;
  const pkg = file instanceof TFile ? plugin.packages.packageFor(file) : null;
  // The scope of the node being edited, so a bare `[[type:local]]` resolves scope-first, same
  // as reading mode (see `resolveLocalRef`, src/packages.ts).
  const originScope = file instanceof TFile ? pkg?.index.byFile(file)?.scope : undefined;

  const inlineNames = plugin.settings.livePreviewInlineNames;
  const fencedLines = getFencedLines(view.state.doc);
  const selRanges = view.state.selection.ranges;

  const items: Item[] = [];
  for (const { from, to } of view.visibleRanges) {
    collectItems(plugin, view, pkg, originScope, inlineNames, fencedLines, selRanges, from, to, items);
  }

  for (const item of items) {
    if (item.kind === 'mark') {
      const attributes: Record<string, string> = {};
      if (item.name) attributes['data-vaire-name'] = item.name;
      if (item.ref) attributes['data-vaire-ref'] = item.ref;
      if (item.repo) attributes['data-vaire-repo'] = item.repo;
      if (item.descriptor !== undefined) attributes['data-vaire-descriptor'] = item.descriptor;
      if (item.typeHint !== undefined) attributes['data-vaire-type-hint'] = item.typeHint;
      builder.add(item.from, item.to, Decoration.mark({ class: item.cls, attributes }));
    } else {
      builder.add(item.from, item.to, Decoration.replace({ widget: item.widget }));
    }
  }

  return builder.finish();
}

export function registerLivePreview(plugin: VairePlugin): void {
  plugin.registerEvent(
    plugin.events.on('index-rebuilt', () => {
      nameCache.clear();
    }),
  );

  const extension = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly view: EditorView;
      private readonly settingsRef: EventRef;
      private readonly indexRef: EventRef;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = buildDecorations(plugin, view);
        this.settingsRef = plugin.events.on('settings-changed', () => this.requestRefresh());
        this.indexRef = plugin.events.on('index-rebuilt', () => this.requestRefresh());
      }

      update(update: ViewUpdate): void {
        const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)));
        if (update.docChanged || update.viewportChanged || update.selectionSet || refreshed) {
          this.decorations = buildDecorations(plugin, update.view);
        }
      }

      destroy(): void {
        plugin.events.offref(this.settingsRef);
        plugin.events.offref(this.indexRef);
      }

      private requestRefresh(): void {
        if (this.view.dom.isConnected) this.view.dispatch({ effects: refreshEffect.of(null) });
      }
    },
    { decorations: (v) => v.decorations },
  );
  plugin.registerEditorExtension(extension);
}
