// Hover-preview popover: for the Vairë references Obsidian's own page preview can't show a
// card for — external `@pkg/...` links, links rendered inside the external view, live-preview
// links, and the node header/panel/footer ref elements — hovering shows a lightweight popover
// with the target's type, full address, name, aliases, `updated`/`status`, frontmatter edges
// (as plain text) and the first paragraph of its body. See BRANCHES.md's `feat/hover-preview`
// entry.
//
// Deliberately *not* Obsidian's own `HoverPopover` class (its constructor isn't public-API
// friendly — see DESIGN.md context) — this is a plain `div.vaire-popover` appended to
// `document.body`, positioned from `getBoundingClientRect()`.
//
// A local vault link in reading mode already carries a real vault `href`/`data-href` (see
// ref-el.ts's `renderLocal`), so Obsidian's own native hover preview already works there —
// `TARGET_SELECTOR` below excludes exactly that case (`.vaire-link:not([data-href])`) so the
// two previews never stack.
//
// Listens on `document` with two delegated handlers (`mouseover`/`mouseout`) rather than one
// per element — DESIGN.md's rendering pass already does the same for clicks (click.ts). The
// popover element itself is a single, ephemeral node, so its own hover state uses plain
// `mouseenter`/`mouseleave` listeners bound directly to it (added/removed with the element).

import { parseRef, type IdRef } from '../ids';
import type VairePlugin from '../main';
import { clearPreviewCache, previewFor, type NodePreview } from './preview-data';

const HOVER_DELAY_MS = 300;
const HIDE_GRACE_MS = 150;
const VIEWPORT_MARGIN = 8;

// `.vaire-lp-link` covers both id refs and loose ends in live preview (loose ends carry the
// additional `.vaire-lp-loose` class — see live.ts) so it doesn't need to be listed twice.
const TARGET_SELECTOR = '.vaire-link:not([data-href]), .vaire-lp-link, .vaire-loose-end';

type PopoverTarget =
  | { kind: 'loose'; descriptor: string; typeHint: string }
  | { kind: 'id'; ref: IdRef; repo: string };

function closestTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const found = node.closest(TARGET_SELECTOR);
  return found?.instanceOf(HTMLElement) ? found : null;
}

/** Reads back exactly the data `ref-el.ts`/`live.ts` attach to a hoverable element. */
function identifyTarget(el: HTMLElement): PopoverTarget | null {
  if (el.classList.contains('vaire-loose-end') || el.classList.contains('vaire-lp-loose')) {
    return {
      kind: 'loose',
      descriptor: el.dataset.vaireDescriptor ?? '',
      typeHint: el.dataset.vaireTypeHint ?? '?',
    };
  }
  const full = el.dataset.vaireRef;
  const repo = el.dataset.vaireRepo;
  if (!full || !repo) return null; // e.g. a live-preview id ref outside any package
  const ref = parseRef(full);
  if (!ref || ref.kind !== 'id') return null;
  return { kind: 'id', ref, repo };
}

class PopoverController {
  private readonly plugin: VairePlugin;
  private popoverEl: HTMLElement | null = null;
  private currentAnchor: HTMLElement | null = null;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  /** Bumped on every hide and every new show; an in-flight async `show` bails if it's stale. */
  private epoch = 0;

  private readonly onPopoverEnter = (): void => this.cancelHide();
  private readonly onPopoverLeave = (): void => this.scheduleHide();

  constructor(plugin: VairePlugin) {
    this.plugin = plugin;
  }

  onDocumentMouseOver(ev: MouseEvent): void {
    const target = closestTarget(ev.target);
    if (!target) return;
    if (target === this.currentAnchor) {
      this.cancelHide(); // re-entering the anchor we're already showing/scheduling for
      return;
    }
    this.switchTo(target, ev);
  }

  onDocumentMouseOut(ev: MouseEvent): void {
    const from = closestTarget(ev.target);
    if (!from || from !== this.currentAnchor) return;
    const to = ev.relatedTarget;
    if (to instanceof Node && from.contains(to)) return; // moved to a child element, still "inside"
    this.scheduleHide();
  }

  /** Hides with no grace period — scroll, Escape, plugin unload. */
  hideImmediately(): void {
    this.cancelShow();
    this.cancelHide();
    this.currentAnchor = null;
    this.hidePopoverEl();
  }

  destroy(): void {
    this.hideImmediately();
  }

  // ---- show/hide scheduling --------------------------------------------------------------

  private switchTo(target: HTMLElement, ev: MouseEvent): void {
    this.cancelShow();
    this.cancelHide();
    this.currentAnchor = target;
    this.hidePopoverEl(); // drop whatever was showing for the previous anchor, immediately

    const mode = this.plugin.settings.hoverPreview;
    if (mode === 'off') return;
    if (mode === 'modifier' && !(ev.ctrlKey || ev.metaKey)) return;

    const info = identifyTarget(target);
    if (!info) return;

    this.showTimer = window.setTimeout(() => {
      this.showTimer = null;
      void this.show(target, info);
    }, HOVER_DELAY_MS);
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.currentAnchor = null;
      this.hidePopoverEl();
    }, HIDE_GRACE_MS);
  }

  private cancelShow(): void {
    if (this.showTimer == null) return;
    window.clearTimeout(this.showTimer);
    this.showTimer = null;
  }

  private cancelHide(): void {
    if (this.hideTimer == null) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  // ---- content -----------------------------------------------------------------------------

  private async show(target: HTMLElement, info: PopoverTarget): Promise<void> {
    const epoch = ++this.epoch;
    this.renderLoading(target);

    if (info.kind === 'loose') {
      if (epoch !== this.epoch || this.currentAnchor !== target) return; // hidden/replaced meanwhile
      this.renderLoose(target, info);
      return;
    }

    const data = await previewFor(this.plugin, info.ref, info.repo);
    if (epoch !== this.epoch || this.currentAnchor !== target) return; // hidden/replaced meanwhile
    if (data) this.renderNode(target, data);
    else this.renderEmpty(target, info.ref);
  }

  private renderLoading(target: HTMLElement): void {
    this.renderInto(target, (el) => {
      el.createDiv({ cls: 'vaire-popover-loading', text: 'Loading…' });
    });
  }

  private renderLoose(target: HTMLElement, info: { descriptor: string; typeHint: string }): void {
    this.renderInto(target, (el) => {
      const header = el.createDiv({ cls: 'vaire-popover-header' });
      header.createSpan({ cls: 'vaire-popover-badge vaire-popover-badge-loose', text: info.typeHint });
      header.createSpan({ cls: 'vaire-popover-title', text: 'Unresolved reference' });
      el.createDiv({ cls: 'vaire-popover-body', text: info.descriptor || '(no descriptor)' });
    });
  }

  private renderEmpty(target: HTMLElement, ref: IdRef): void {
    this.renderInto(target, (el) => {
      const header = el.createDiv({ cls: 'vaire-popover-header' });
      header.createSpan({ cls: 'vaire-popover-badge', text: ref.type });
      header.createEl('code', { cls: 'vaire-popover-addr', text: ref.full });
      el.createDiv({ cls: 'vaire-popover-empty', text: 'Not found.' });
    });
  }

  private renderNode(target: HTMLElement, data: NodePreview): void {
    this.renderInto(target, (el) => {
      const header = el.createDiv({ cls: 'vaire-popover-header' });
      header.createSpan({ cls: 'vaire-popover-badge', text: data.type });
      header.createEl('code', { cls: 'vaire-popover-addr', text: data.full });

      el.createDiv({ cls: 'vaire-popover-name', text: data.name });

      if (data.aliases.length > 0) {
        const aliasesEl = el.createDiv({ cls: 'vaire-popover-aliases' });
        for (const alias of data.aliases) aliasesEl.createSpan({ cls: 'vaire-alias-chip', text: alias });
      }

      if (data.status || data.updated) {
        const meta = el.createDiv({ cls: 'vaire-popover-meta' });
        if (data.status) meta.createSpan({ cls: 'vaire-popover-meta-item', text: data.status });
        if (data.updated) meta.createSpan({ cls: 'vaire-popover-meta-item', text: `updated ${data.updated}` });
      }

      if (data.edges.length > 0) {
        const edgesEl = el.createDiv({ cls: 'vaire-popover-edges' });
        for (const edge of data.edges) {
          edgesEl.createDiv({ cls: 'vaire-popover-edge', text: `${edge.key}: ${edge.values.join(', ')}` });
        }
      }

      if (data.firstParagraph) {
        el.createDiv({ cls: 'vaire-popover-para', text: data.firstParagraph });
      }
    });
  }

  // ---- DOM plumbing -------------------------------------------------------------------------

  private renderInto(target: HTMLElement, build: (el: HTMLElement) => void): void {
    const el = this.ensurePopoverEl();
    el.empty();
    build(el);
    this.position(target, el);
  }

  private ensurePopoverEl(): HTMLElement {
    if (this.popoverEl) return this.popoverEl;
    const el = document.body.createDiv({ cls: 'vaire-popover' });
    el.addEventListener('mouseenter', this.onPopoverEnter);
    el.addEventListener('mouseleave', this.onPopoverLeave);
    this.popoverEl = el;
    return el;
  }

  private hidePopoverEl(): void {
    this.epoch++; // invalidate any in-flight async `show`
    if (!this.popoverEl) return;
    this.popoverEl.remove();
    this.popoverEl = null;
  }

  /** Below the anchor by default, flipped above when it wouldn't fit; clamped into the viewport. */
  private position(target: HTMLElement, el: HTMLElement): void {
    const anchorRect = target.getBoundingClientRect();
    const popRect = el.getBoundingClientRect();

    let top = anchorRect.bottom + VIEWPORT_MARGIN;
    const fitsBelow = top + popRect.height <= window.innerHeight - VIEWPORT_MARGIN;
    const fitsAbove = anchorRect.top - popRect.height - VIEWPORT_MARGIN >= 0;
    if (!fitsBelow && fitsAbove) top = anchorRect.top - popRect.height - VIEWPORT_MARGIN;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - popRect.height - VIEWPORT_MARGIN));

    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchorRect.left, window.innerWidth - popRect.width - VIEWPORT_MARGIN),
    );

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }
}

export function registerHoverPreview(plugin: VairePlugin): void {
  const controller = new PopoverController(plugin);

  plugin.registerDomEvent(document, 'mouseover', (ev) => controller.onDocumentMouseOver(ev));
  plugin.registerDomEvent(document, 'mouseout', (ev) => controller.onDocumentMouseOut(ev));
  plugin.registerDomEvent(document, 'scroll', () => controller.hideImmediately(), { capture: true });
  plugin.registerDomEvent(document, 'keydown', (ev) => {
    if (ev.key === 'Escape') controller.hideImmediately();
  });

  plugin.registerEvent(plugin.events.on('index-rebuilt', () => clearPreviewCache()));

  plugin.register(() => controller.destroy());
}
