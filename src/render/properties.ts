// Properties-panel decoration (feat/properties-links). Obsidian's Properties panel (the
// frontmatter UI at the top of a note, in both reading and live-preview modes) has no
// post-processor hook the way the note body does, so this observes the DOM directly and
// overlays Vairë reference elements onto it — the underlying frontmatter is never touched.
//
// DOM shape relied on (see BRANCHES.md's `feat/properties-links` row and the task brief for
// this branch; there is no dedicated DESIGN.md section for it yet):
//   .metadata-container
//     .metadata-property[data-property-key="<key>"]
//       .metadata-property-value
//         .metadata-input-longtext                          (scalar/text property)
//         .multi-select-container
//           .multi-select-pill
//             .multi-select-pill-content                     (list property, one pill per item)
//
// The owning file for a `.metadata-property` element is found the same way DESIGN.md's
// external-view resolution walks the DOM: closest `.workspace-leaf-content[data-type=
// "markdown"]` ancestor -> the `MarkdownView` (among `workspace.getLeavesOfType('markdown')`)
// whose `containerEl` contains it -> `view.file`.
//
// Which frontmatter keys/values get decorated is decided by the pure helpers in `pure.ts`
// (`propertyEdgeKeys`, `matchPropertyValues`) so that logic stays unit-testable; this module
// only does DOM plumbing: finding property elements, inserting/removing `.vaire-prop-link`
// elements, and keeping decorations idempotent and up to date.

import { MarkdownView, TFile } from 'obsidian';
import { createRefElement } from './ref-el';
import { matchPropertyValues, propertyEdgeKeys } from './pure';
import type VairePlugin from '../main';

const DEBOUNCE_MS = 50;

export function registerPropertiesLinks(plugin: VairePlugin): void {
  let pending = new Set<HTMLElement>();
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    const roots = pending;
    pending = new Set();
    for (const el of roots) decorateProperty(plugin, el);
  };

  const schedule = (el: HTMLElement): void => {
    pending.add(el);
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, DEBOUNCE_MS);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!node.instanceOf(HTMLElement)) return;
        if (node.matches('.metadata-property')) {
          schedule(node);
          return;
        }
        node.querySelectorAll?.('.metadata-property').forEach((el) => schedule(el as HTMLElement));
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  plugin.register(() => {
    observer.disconnect();
    if (timer != null) window.clearTimeout(timer);
    pending.clear();
  });

  // A Properties panel already open when the plugin (re)loads gets no 'added node' mutation
  // — decorate whatever is already on screen once, on the next tick.
  window.setTimeout(() => {
    document.querySelectorAll('.metadata-property').forEach((el) => decorateProperty(plugin, el as HTMLElement));
  }, 0);

  // Frontmatter can change without the Properties panel's DOM being torn down and rebuilt
  // (e.g. an external edit merged into an already-open note); re-check every currently
  // rendered property that belongs to the changed file.
  plugin.registerEvent(
    plugin.app.metadataCache.on('changed', (file) => {
      document.querySelectorAll('.metadata-property').forEach((el) => {
        const propEl = el as HTMLElement;
        if (findOwningFile(plugin, propEl) === file) decorateProperty(plugin, propEl);
      });
    }),
  );
}

function decorateProperty(plugin: VairePlugin, propEl: HTMLElement): void {
  if (!plugin.settings.propertiesLinks) return;
  if (!propEl.isConnected || !propEl.classList.contains('metadata-property')) return;

  const key = propEl.getAttribute('data-property-key');
  if (!key) return;

  const file = findOwningFile(plugin, propEl);
  if (!file) return;
  const pkg = plugin.packages.packageFor(file);
  if (!pkg) return; // only decorate files inside a vault package

  const frontmatter: Record<string, unknown> | undefined = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  if (!propertyEdgeKeys(frontmatter).has(key)) return;

  const valueEl = propEl.querySelector<HTMLElement>('.metadata-property-value');
  if (!valueEl) return;

  const longtext = valueEl.querySelector<HTMLElement>('.metadata-input-longtext');
  if (longtext) {
    decorateTextValue(plugin, pkg.absRoot, valueEl, longtext);
    return;
  }

  const pills = Array.from(valueEl.querySelectorAll<HTMLElement>('.multi-select-container .multi-select-pill'));
  if (pills.length) decorateMultiSelect(plugin, pkg.absRoot, valueEl, pills);
}

/** Finds the vault file whose Properties panel `propEl` belongs to, per the module doc comment. */
function findOwningFile(plugin: VairePlugin, propEl: HTMLElement): TFile | null {
  const leafContentEl = propEl.closest('.workspace-leaf-content[data-type="markdown"]');
  if (!leafContentEl) return null;
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.containerEl.contains(leafContentEl)) {
      return view.file;
    }
  }
  return null;
}

// ---- text (single-value) properties ------------------------------------------------------
//
// `longtext`'s own children are never touched — the ref element is inserted as a sibling
// after it, so `longtext.textContent` always reads back the pristine raw value (which is
// both how we detect "nothing changed, skip" and how we notice an edit to re-decorate).

function decorateTextValue(plugin: VairePlugin, repo: string, valueEl: HTMLElement, longtext: HTMLElement): void {
  const text = (longtext.textContent ?? '').trim();
  if (longtext.dataset.vaireProp === '1' && longtext.dataset.vairePropText === text) return; // unchanged, idempotent

  valueEl.querySelectorAll(':scope > .vaire-prop-link').forEach((el) => el.remove());

  const [match] = matchPropertyValues([text]);
  longtext.dataset.vaireProp = '1';
  longtext.dataset.vairePropText = text;

  if (!match) {
    valueEl.classList.remove('vaire-prop-has-link');
    return;
  }

  const el = createRefElement(plugin, match.ref, { repo });
  el.classList.add('vaire-prop-link');
  longtext.insertAdjacentElement('afterend', el);
  valueEl.classList.add('vaire-prop-has-link');
}

// ---- multi-select (list) properties -------------------------------------------------------
//
// Each pill's original text node(s) are wrapped once in a `span.vaire-prop-raw-text` the
// first time it's seen (CSS hides that span, not the ref element, while the property isn't
// focused); after that the wrapper's own text is the stable "raw value" to re-check and
// re-parse, so the ref element appended alongside it never pollutes the comparison.

function decorateMultiSelect(plugin: VairePlugin, repo: string, valueEl: HTMLElement, pills: HTMLElement[]): void {
  let any = false;
  for (const pill of pills) {
    const content = pill.querySelector<HTMLElement>('.multi-select-pill-content');
    if (!content) continue;
    if (decoratePillContent(plugin, repo, content)) any = true;
  }
  valueEl.classList.toggle('vaire-prop-has-link', any);
}

function decoratePillContent(plugin: VairePlugin, repo: string, content: HTMLElement): boolean {
  const wrap = ensureRawTextWrap(content);
  const text = (wrap.textContent ?? '').trim();

  if (content.dataset.vaireProp === '1' && content.dataset.vairePropText === text) {
    return content.classList.contains('vaire-prop-decorated');
  }

  content.querySelectorAll(':scope > .vaire-prop-link').forEach((el) => el.remove());

  const [match] = matchPropertyValues([text]);
  content.dataset.vaireProp = '1';
  content.dataset.vairePropText = text;

  if (!match) {
    content.classList.remove('vaire-prop-decorated');
    return false;
  }

  const el = createRefElement(plugin, match.ref, { repo });
  el.classList.add('vaire-prop-link');
  content.appendChild(el);
  content.classList.add('vaire-prop-decorated');
  return true;
}

function ensureRawTextWrap(content: HTMLElement): HTMLElement {
  const existing = content.querySelector<HTMLElement>(':scope > .vaire-prop-raw-text');
  if (existing) return existing;
  const wrap = createEl('span', { cls: 'vaire-prop-raw-text' });
  while (content.firstChild) wrap.appendChild(content.firstChild);
  content.appendChild(wrap);
  return wrap;
}
