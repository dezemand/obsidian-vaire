// Installs a minimal global `document`/`window` (via happy-dom) and the small set of DOM
// convenience methods Obsidian's real runtime bolts onto `HTMLElement.prototype` /
// `DocumentFragment.prototype` (`createEl`, `createDiv`, `createSpan`, `empty`, `addClass`,
// `removeClass`, `toggleClass`, `setText`, `setAttr`, `hide`, `show`, `detach`) plus the ambient
// global `createFragment`/`createDiv`/`createSpan`/`createEl` functions — see the doc comment at
// the top of `src/health/index.ts` ("createFragment/createEl/createDiv/createSpan are ambient
// globals Obsidian installs ... not exports of the 'obsidian' module"). The real `obsidian`
// npm package is types-only (no runtime), so none of this exists unless we build it ourselves.
//
// Call `installDom()` once, before importing anything that touches `document` at module-eval or
// `onload` time (i.e. before `../src/main` is imported).

import { GlobalRegistrator } from '@happy-dom/global-registrator';

export interface CreateElOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  href?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  parent?: HTMLElement;
}

function applyOptions<T extends HTMLElement>(el: T, options?: CreateElOptions): T {
  if (!options) return el;
  if (options.cls) el.addClass(...(Array.isArray(options.cls) ? options.cls : [options.cls]));
  if (options.text != null) el.setText(options.text);
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) {
      if (value == null) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (options.href != null) el.setAttribute('href', options.href);
  if (options.type != null) el.setAttribute('type', options.type);
  if (options.value != null) (el as unknown as { value?: string }).value = options.value;
  if (options.placeholder != null) el.setAttribute('placeholder', options.placeholder);
  if (options.title != null) el.setAttribute('title', options.title);
  if (options.parent) options.parent.appendChild(el);
  return el;
}

let installed = false;

export function installDom(): void {
  if (installed) return;
  installed = true;

  GlobalRegistrator.register();

  const proto = globalThis.HTMLElement.prototype as unknown as Record<string, unknown>;

  proto.createEl = function (this: HTMLElement, tag: string, options?: CreateElOptions): HTMLElement {
    const el = document.createElement(tag);
    applyOptions(el, options);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, options?: CreateElOptions): HTMLElement {
    return (this as unknown as { createEl: (t: string, o?: CreateElOptions) => HTMLElement }).createEl('div', options);
  };
  proto.createSpan = function (this: HTMLElement, options?: CreateElOptions): HTMLElement {
    return (this as unknown as { createEl: (t: string, o?: CreateElOptions) => HTMLElement }).createEl('span', options);
  };
  proto.empty = function (this: HTMLElement): HTMLElement {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  };
  proto.addClass = function (this: HTMLElement, ...classes: string[]): HTMLElement {
    this.classList.add(...classes.filter(Boolean));
    return this;
  };
  proto.addClasses = function (this: HTMLElement, classes: string[]): HTMLElement {
    this.classList.add(...classes.filter(Boolean));
    return this;
  };
  proto.removeClass = function (this: HTMLElement, ...classes: string[]): HTMLElement {
    this.classList.remove(...classes.filter(Boolean));
    return this;
  };
  proto.removeClasses = function (this: HTMLElement, classes: string[]): HTMLElement {
    this.classList.remove(...classes.filter(Boolean));
    return this;
  };
  proto.toggleClass = function (this: HTMLElement, classes: string | string[], force?: boolean): HTMLElement {
    for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, force);
    return this;
  };
  proto.setText = function (this: HTMLElement, text: string | DocumentFragment): HTMLElement {
    if (typeof text === 'string') {
      this.textContent = text;
    } else {
      this.empty();
      this.appendChild(text);
    }
    return this;
  };
  proto.setAttr = function (this: HTMLElement, name: string, value: string | number | boolean | null): HTMLElement {
    if (value == null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
    return this;
  };
  proto.hide = function (this: HTMLElement): HTMLElement {
    this.style.display = 'none';
    return this;
  };
  proto.show = function (this: HTMLElement): HTMLElement {
    this.style.display = '';
    return this;
  };
  proto.detach = function (this: HTMLElement): HTMLElement {
    this.remove();
    return this;
  };

  // `createFragment`'s callback gets a `DocumentFragment` that (per health/index.ts's usage)
  // needs `createDiv`/`createEl` too.
  const fragProto = globalThis.DocumentFragment.prototype as unknown as Record<string, unknown>;
  fragProto.createEl = proto.createEl;
  fragProto.createDiv = proto.createDiv;
  fragProto.createSpan = proto.createSpan;
  fragProto.empty = proto.empty;

  const win = globalThis.window as unknown as Record<string, unknown>;
  win.createFragment = (cb?: (el: DocumentFragment) => void): DocumentFragment => {
    const frag = document.createDocumentFragment();
    cb?.(frag);
    return frag;
  };
  win.createEl = (tag: string, options?: CreateElOptions): HTMLElement => {
    const el = document.createElement(tag);
    return applyOptions(el, options);
  };
  win.createDiv = (options?: CreateElOptions): HTMLElement => (win.createEl as typeof document.createElement)('div', options as never) as HTMLElement;
  win.createSpan = (options?: CreateElOptions): HTMLElement => (win.createEl as typeof document.createElement)('span', options as never) as HTMLElement;
  (globalThis as unknown as Record<string, unknown>).createFragment = win.createFragment;
  (globalThis as unknown as Record<string, unknown>).createEl = win.createEl;
  (globalThis as unknown as Record<string, unknown>).createDiv = win.createDiv;
  (globalThis as unknown as Record<string, unknown>).createSpan = win.createSpan;

  // `render/explorer.ts`'s `metadataCache.on('changed', ...)` listener (never triggered by this
  // suite, but it's parsed/imported) uses `CSS.escape` — not implemented by every DOM stack, so
  // provide a plain polyfill rather than leave the global undefined.
  if (!(globalThis as unknown as { CSS?: unknown }).CSS) {
    (globalThis as unknown as { CSS: { escape: (v: string) => string } }).CSS = {
      escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
    };
  }
}
