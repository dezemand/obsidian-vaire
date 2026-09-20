// Reading-mode post processor: rewrites every Vairë `a.internal-link` produced by
// Obsidian's own renderer into a `createRefElement` (or `span.vaire-loose-end`), then
// inserts the node header (header.ts) if this section carries the file's leading `h1`.
// See DESIGN.md "Features §1 Rendering" and "Phase 2 ownership" for the resolution-root
// rule mirrored in `resolveRepo`.

import { Notice, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { parseRef, parseWikilinkText } from '../ids';
import { createRefElement } from './ref-el';
import { extractLinkTarget, hasDisplayOverride, parseExternalSourcePath } from './pure';
import { insertNodeHeader } from './header';
import type VairePlugin from '../main';

export function registerReadingPostProcessor(plugin: VairePlugin): void {
  // Async: perf/refs-prefetch awaits the document's batched refs+render prefetch before
  // rendering links, so `resolveMemo` is already seeded and processLinks's per-link fallback
  // (ref-el.ts's `settleAsync`) doesn't race it into spawning its own `resolve` calls. On
  // `main` (no prefetch), this callback still resolves on the same tick as before.
  plugin.registerMarkdownPostProcessor(async (el, ctx) => {
    const repo = resolveRepo(plugin, el, ctx);
    if (repo) {
      // perf/refs-prefetch: await the document's batched refs+render prefetch before
      // resolving links, so `resolveMemo` is already seeded and processLinks's per-link
      // fallback (ref-el.ts's `settleAsync`) doesn't race it into spawning its own `resolve`
      // calls.
      await prefetchForSourcePath(plugin, ctx.sourcePath);
      const originScope = resolveOriginScope(plugin, ctx);
      processLinks(plugin, el, repo, originScope);
    }
    // Only ever present inside the external view's `render`-mode body (see
    // `views/pure-ext.ts`'s `rewriteRenderedLinks`) — gated on the same `[data-vaire-repo]`
    // ancestor that scopes `processLinks` above, rather than on `repo` being non-null, since a
    // `vaire://` link can appear in a section `resolveRepo` didn't resolve a repo for.
    processRenderModeLinks(plugin, el);
    // The node header only ever applies to vault files; it looks up its own package
    // (independent of `repo`, which may come from a `data-vaire-repo` ancestor instead).
    await insertNodeHeader(plugin, el, ctx);
  });
}

/** Prefetches the vault node at `sourcePath`'s outbound refs, if it is one — a no-op for a
 *  plain vault note (no id+type frontmatter) or anything outside a package. */
async function prefetchForSourcePath(plugin: VairePlugin, sourcePath: string): Promise<void> {
  const pkg = plugin.packages.packageFor(sourcePath);
  if (!pkg) return;
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;
  const node = pkg.index.byFile(file);
  if (!node) return;
  await plugin.prefetchDocument(pkg, node);
}

/**
 * The resolution root for refs rendered inside `el`: the vault package owning
 * `ctx.sourcePath`, else the nearest `[data-vaire-repo]` ancestor (the external view wraps
 * its content in one of these), else — when `ctx.sourcePath` itself is an external-view
 * synthetic path — the root encoded in that path. `null` means this isn't a Vairë context
 * at all (an ordinary vault note outside any package, or a page not rendered by us).
 *
 * Exported for `diagrams.ts`, which post-processes the same sections and needs the identical
 * resolution-root rule.
 */
export function resolveRepo(plugin: VairePlugin, el: HTMLElement, ctx: MarkdownPostProcessorContext): string | null {
  const pkg = plugin.packages.packageFor(ctx.sourcePath);
  if (pkg) return pkg.absRoot;

  const ancestor = el.closest('[data-vaire-repo]');
  const fromAncestor = ancestor?.getAttribute('data-vaire-repo');
  if (fromAncestor) return fromAncestor;

  return parseExternalSourcePath(ctx.sourcePath);
}

/**
 * The scope of the node being rendered (`pkg.index.byFile(file)?.scope`), i.e. the
 * `originScope` a bare `[[type:local]]` written in this file's frontmatter/prose should
 * resolve against first (see `resolveLocalRef`, src/packages.ts). Only vault files that are
 * themselves indexed nodes carry a scope this way; anything else (a non-package file, or an
 * external-view synthetic `sourcePath`) yields `undefined` — the CLI-backed external view has
 * no local `LocalIndex` entry to look this up from. Exported for `diagrams.ts`.
 */
export function resolveOriginScope(plugin: VairePlugin, ctx: MarkdownPostProcessorContext): string | undefined {
  const pkg = plugin.packages.packageFor(ctx.sourcePath);
  if (!pkg) return undefined;
  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return undefined;
  return pkg.index.byFile(file)?.scope;
}

function processLinks(plugin: VairePlugin, el: HTMLElement, repo: string, originScope: string | undefined): void {
  const anchors = el.querySelectorAll<HTMLAnchorElement>('a.internal-link');
  anchors.forEach((a) => {
    if (a.closest('code, pre')) return;
    // A genuine (non-Vairë) Obsidian embed's own rendered content is left alone, but links in
    // a node body that embeds.ts rendered inside a `.vaire-embed` get the normal treatment,
    // resolved against the embedded node's package via its `[data-vaire-repo]` wrapper.
    const embedAncestor = a.closest('.internal-embed');
    if (embedAncestor && !embedAncestor.classList.contains('vaire-embed')) return;

    const target = extractLinkTarget(a.getAttribute('data-href'), a.getAttribute('href'));
    if (!target) return;

    const ref = parseRef(parseWikilinkText(target));
    if (!ref) return; // an ordinary Obsidian link — leave it alone

    const text = a.textContent ?? '';
    const display = hasDisplayOverride(text, target) ? text : undefined;

    createRefElement(plugin, ref, { repo, display, reuse: a, originScope });
  });
}

const VAIRE_HREF_PREFIX = 'vaire://';

/**
 * `render`-mode external pages (feat/ext-render-mode) rewrite every resolvable `.md` link to
 * `vaire://<encodeURIComponent(absolutePath)>` (see `views/pure-ext.ts`'s
 * `rewriteRenderedLinks`). Obsidian's own renderer treats a link whose href carries an
 * unrecognized URI scheme as external (`a.external-link`, href left verbatim, no vault-path
 * resolution attempted) rather than as an internal link, so this — gated on the same
 * `[data-vaire-repo]` ancestor `processLinks` requires, since a bare `repo` lookup can fail
 * for a section `resolveRepo` didn't resolve one for — finds those and routes them through
 * `hooks.openExternalFile` instead of leaving Obsidian to treat `vaire://…` as a real link to
 * open externally.
 */
function processRenderModeLinks(plugin: VairePlugin, el: HTMLElement): void {
  if (!el.closest('[data-vaire-repo]')) return;

  const anchors = el.querySelectorAll<HTMLAnchorElement>(`a.external-link[href^="${VAIRE_HREF_PREFIX}"]`);
  anchors.forEach((a) => {
    if (a.closest('code, pre')) return;

    const absPath = decodeVaireHref(a.getAttribute('href'));
    if (!absPath) return;

    a.classList.add('vaire-ext-render-link');
    bindRenderModeClick(plugin, a, absPath);
  });
}

function decodeVaireHref(href: string | null): string | null {
  if (!href || !href.startsWith(VAIRE_HREF_PREFIX)) return null;
  const encoded = href.slice(VAIRE_HREF_PREFIX.length);
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

// Same re-render safety as `boundClickHandlers` in ref-el.ts: a postprocessor pass can revisit
// DOM it already processed, so re-binding without clearing the previous listener would stack
// duplicate handlers on the same anchor.
const boundRenderClickHandlers = new WeakMap<HTMLAnchorElement, (ev: MouseEvent) => void>();

function bindRenderModeClick(plugin: VairePlugin, el: HTMLAnchorElement, absPath: string): void {
  const previous = boundRenderClickHandlers.get(el);
  if (previous) el.removeEventListener('click', previous);

  const onClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    const newLeaf = !!(ev.metaKey || ev.ctrlKey || ev.button === 1);
    if (plugin.hooks.openExternalFile) {
      void plugin.hooks.openExternalFile(absPath, { newLeaf });
    } else {
      new Notice('External pages not available yet');
    }
  };
  el.addEventListener('click', onClick);
  boundRenderClickHandlers.set(el, onClick);
}
