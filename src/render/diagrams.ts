// Clickable `vaire/…` shape links inside rendered Mermaid diagrams. See DESIGN.md and
// renderer-conventions.md §5 ("Diagram reference syntax and rendering", part B): inside a
// diagram's own source, a shape's link target starting with the literal marker `vaire/` (e.g.
// `click PLC href "vaire/technology-component:plc"`) is a Vairë entity reference, not a URL —
// Obsidian renders the ```mermaid fence client-side into an `<svg>` inside
// `.mermaid`/`div[class*="mermaid"]`, and this post-processor rewrites that SVG's own
// `<a href="vaire/…">` anchors in place once Mermaid has finished drawing them.
//
// Mermaid renders asynchronously (its own post-processor kicks off a promise; by the time our
// `registerMarkdownPostProcessor` callback runs, the `.mermaid` container usually exists but is
// still empty), so this waits for the `<svg>` to appear via a `MutationObserver`, bounded by a
// timeout in case Mermaid fails/never renders (a malformed diagram, or the mermaid renderer
// disabled) so the observer doesn't leak forever.

import { MarkdownRenderChild } from 'obsidian';
import { parseRef, type IdRef } from '../ids';
import { diagramTargetFromHref } from './pure';
import { resolveOriginScope, resolveRepo } from './reading';
import { openRef } from '../navigate';
import type VairePlugin from '../main';

const MERMAID_SELECTOR = '.mermaid, div[class*="mermaid"]';
const SVG_WAIT_TIMEOUT_MS = 10_000;
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export function registerDiagramLinks(plugin: VairePlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    const repo = resolveRepo(plugin, el, ctx);
    if (!repo) return;
    const originScope = resolveOriginScope(plugin, ctx);

    const containers = el.querySelectorAll<HTMLElement>(MERMAID_SELECTOR);
    containers.forEach((container) => {
      // Obsidian can re-invoke a registered MarkdownPostProcessor over DOM it already
      // processed (see the same note in ref-el.ts/header.ts) — without this guard a second
      // pass would attach a second MutationObserver/timeout to the same still-attached
      // container and, once Mermaid's SVG appears, bind a second click listener on top of the
      // first for every `vaire/…` anchor.
      if (container.dataset.vaireDiagramWatched) return;
      container.dataset.vaireDiagramWatched = '1';
      ctx.addChild(new DiagramLinkChild(plugin, container, repo, originScope));
    });
  });
}

/**
 * Owns one `.mermaid` container: waits for Mermaid to fill it with an `<svg>`, then rewrites
 * that SVG's `vaire/…` anchors once. Disconnects its `MutationObserver`/timeout on success, on
 * timeout, or when Obsidian unloads it (the section was re-rendered or scrolled out of the
 * document and replaced — `MarkdownRenderChild`'s own containerEl-attachment check handles
 * that; `onunload` here only needs to stop the observer/timer from outliving it).
 */
class DiagramLinkChild extends MarkdownRenderChild {
  private observer: MutationObserver | null = null;
  private timeoutId: number | null = null;
  private processed = false;

  constructor(
    private readonly plugin: VairePlugin,
    containerEl: HTMLElement,
    private readonly repo: string,
    private readonly originScope: string | undefined,
  ) {
    super(containerEl);
  }

  onload(): void {
    const existing = this.containerEl.querySelector('svg');
    if (existing) {
      this.process(existing);
      return;
    }

    this.observer = new MutationObserver(() => {
      const svg = this.containerEl.querySelector('svg');
      if (svg) this.process(svg);
    });
    this.observer.observe(this.containerEl, { childList: true, subtree: true });

    this.timeoutId = window.setTimeout(() => {
      this.stopWaiting();
    }, SVG_WAIT_TIMEOUT_MS);
  }

  onunload(): void {
    this.stopWaiting();
  }

  private stopWaiting(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.timeoutId != null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private process(svg: SVGElement): void {
    if (this.processed) return;
    this.processed = true;
    this.stopWaiting();
    processDiagramSvg(this.plugin, svg, this.repo, this.originScope);
  }
}

// `svg.querySelectorAll('a')` resolves through TS's `HTMLElementTagNameMap` overload (checked
// first) to `HTMLAnchorElement`, but at runtime — this is an SVG subtree — every match is
// really an `SVGAElement`. Rather than fight that overload with an unsound cast, everything
// below works through the plain `Element` interface, which both share and which is all that's
// needed here (`getAttribute(NS)`/`removeAttribute(NS)`/`classList`/`addEventListener`).

/** Reads either the plain `href` or the namespaced `xlink:href` off an SVG `<a>`. */
function readHref(a: Element): string | null {
  return a.getAttribute('href') ?? a.getAttributeNS(XLINK_NS, 'href') ?? a.getAttribute('xlink:href');
}

function clearHref(a: Element): void {
  a.removeAttribute('href');
  a.removeAttributeNS(XLINK_NS, 'href');
  a.removeAttribute('xlink:href');
}

function processDiagramSvg(plugin: VairePlugin, svg: SVGElement, repo: string, originScope: string | undefined): void {
  const anchors = Array.from(svg.querySelectorAll('a'));
  for (const a of anchors) {
    const target = diagramTargetFromHref(readHref(a));
    if (target === null) continue; // not a `vaire/…` link at all — an author's own URL, left alone

    // However this resolves, it is never a real navigable URL — Mermaid would otherwise try to
    // open `vaire/type:id` as a page-relative link.
    clearHref(a);

    const ref = parseRef(target);
    if (ref && ref.kind === 'id') {
      a.classList.add('vaire-dref', `vaire-type-${ref.type}`);
      a.setAttribute('title', ref.full);
      bindDiagramClick(plugin, a, ref, repo, originScope);
    } else {
      a.classList.add('vaire-dref-off');
      a.setAttribute(
        'title',
        ref?.kind === 'loose'
          ? `'vaire/${target}' is a loose end, not a diagram-clickable reference yet`
          : `'vaire/${target}' is not a reference target`,
      );
    }
  }
}

function bindDiagramClick(
  plugin: VairePlugin,
  a: Element,
  ref: IdRef,
  repo: string,
  originScope: string | undefined,
): void {
  a.addEventListener('click', (evt: Event) => {
    const ev = evt as MouseEvent;
    ev.preventDefault();
    ev.stopPropagation();
    const newLeaf = ev.metaKey || ev.ctrlKey || ev.button === 1;
    void openRef(plugin, ref, repo, { newLeaf, originScope });
  });
}
