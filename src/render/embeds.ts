// Node embeds (transclusion): `![[type:id]]`, `![[container/type:local]]`, `![[@pkg/type:id]]`
// and `![[type:id#Heading]]` render the referenced node inline in reading mode, the way
// Obsidian embeds a note — a bordered block with a small title bar and the node's body below
// it. See BRANCHES.md's `feat/node-embeds` row and DESIGN.md "Phase 2 ownership" for the
// `data-vaire-repo` / `__vaire_external__` sourcePath contract this reuses.
//
// DOM assumption (no Obsidian GUI available to verify against directly — see this branch's
// task brief): Obsidian cannot resolve `type:id` to a vault file (`:` never appears in a note
// name — see DESIGN.md "Reference grammar"), so it renders `![[type:id]]` as an *unresolved*
// embed: a `span.internal-embed` carrying the raw wikilink target in its `src` attribute
// (`data-src` as a fallback, in case a differently-shaped build sets that instead), possibly
// also `.is-unresolved` and/or nested chrome we don't rely on. Any `.internal-embed` whose
// `src`/`data-src` parses via `parseEmbedSrc` is ours: we empty it, mark it `.vaire-embed`,
// and rebuild its content ourselves — the same "take over the DOM Obsidian already built"
// approach `ref-el.ts` uses for `a.internal-link`. `data-vaire-embed="1"` guards against
// Obsidian re-invoking the post processor over DOM it already handed us.
//
// Live preview shows the raw `![[...]]` text untouched (Obsidian's own live-preview embed
// widget isn't intercepted) — see BRANCHES.md; that would need its own CM6 decoration and is
// out of scope here.
//
// Depth: an embedded node's body is rendered with `MarkdownRenderer.render`, which re-invokes
// every registered post processor (including this one) over the new content — so an embed
// inside an embedded node's body is expanded too, unbounded unless capped. `MAX_EMBED_DEPTH`
// bounds it at 2 nested levels; depth is tracked via a `data-vaire-embed-depth` attribute set
// on each `.internal-embed` we take over, read back via the nearest such ancestor of the next
// one found inside a rendered body.

import { MarkdownRenderChild, MarkdownRenderer, type MarkdownPostProcessorContext } from 'obsidian';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IdRef, VaireRef } from '../ids';
import { dropLeadingH1 } from '../views/pure-pkg';
import { externalSourcePath, splitFrontmatter } from '../views/pure-ext';
import { resolveDependencyRoot } from '../views/external-catalog';
import { createRefElement } from './ref-el';
import { parseEmbedSrc, sectionUnderHeading } from './pure';
import { resolveRepo } from './reading';
import type VairePlugin from '../main';

const MAX_EMBED_DEPTH = 2;

export function registerEmbeds(plugin: VairePlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    if (!plugin.settings.nodeEmbeds) return;
    const repo = resolveRepo(plugin, el, ctx);
    if (!repo) return;

    el.querySelectorAll<HTMLElement>('.internal-embed').forEach((embedEl) => {
      processEmbed(plugin, embedEl, repo, ctx);
    });
  });
}

function processEmbed(plugin: VairePlugin, el: HTMLElement, repo: string, ctx: MarkdownPostProcessorContext): void {
  if (el.closest('code, pre')) return;
  if (el.dataset.vaireEmbed === '1') return; // idempotence guard — already taken over

  const src = el.getAttribute('src') ?? el.getAttribute('data-src');
  if (!src) return;
  const parsed = parseEmbedSrc(src);
  if (!parsed) return; // not a Vairë reference — leave Obsidian's own embed handling alone

  const depth = ancestorEmbedDepth(el) + 1;

  el.dataset.vaireEmbed = '1';
  el.classList.add('vaire-embed');
  el.setAttribute('data-vaire-embed-depth', String(depth));
  while (el.firstChild) el.removeChild(el.firstChild);

  void buildEmbed(plugin, el, parsed.ref, parsed.heading, repo, depth, ctx);
}

/** The embed-depth of the nearest ancestor `.internal-embed` we've already taken over, or 0. */
function ancestorEmbedDepth(el: HTMLElement): number {
  const ancestor = el.closest('[data-vaire-embed-depth]');
  const raw = ancestor?.getAttribute('data-vaire-embed-depth');
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function buildEmbed(
  plugin: VairePlugin,
  container: HTMLElement,
  ref: VaireRef,
  heading: string | undefined,
  repo: string,
  depth: number,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  const titleBar = container.createDiv({ cls: 'vaire-embed-title' });
  // The title link resolves against `repo` — the package the `![[...]]` is *written* in — the
  // same resolution context an ordinary reference at that spot would use. This gives the type
  // badge, click-to-open, and external/unlinked/missing styling for free (see ref-el.ts).
  titleBar.appendChild(createRefElement(plugin, ref, { repo }));
  if (heading) titleBar.createSpan({ cls: 'vaire-embed-heading', text: `› ${heading}` });

  const bodyEl = container.createDiv({ cls: 'vaire-embed-body' });

  if (ref.kind === 'loose') {
    bodyEl.createDiv({ cls: 'vaire-embed-note', text: 'Loose ends have no node body to embed.' });
    return;
  }

  if (depth > MAX_EMBED_DEPTH) {
    bodyEl.createDiv({ cls: 'vaire-embed-note', text: 'Nested embed depth limit reached.' });
    return;
  }

  const address = heading ? `${ref.full}#${heading}` : ref.full;

  let target: EmbedTarget | null;
  try {
    target = await loadEmbedTarget(plugin, ref, repo);
  } catch {
    target = null;
  }
  if (!target) {
    renderMissingBody(bodyEl, address);
    return;
  }

  const { body: rawBody } = splitFrontmatter(target.raw);
  const withoutH1 = dropLeadingH1(rawBody);

  let sectioned = withoutH1;
  if (heading) {
    const section = sectionUnderHeading(withoutH1, heading);
    if (section == null) {
      renderMissingBody(bodyEl, address);
      return;
    }
    sectioned = section;
  }

  // Wraps the body so the reading-mode post processor resolves its links against the
  // *embedded* node's own package, not `repo` (per DESIGN.md "Phase 2 ownership" / the shared
  // `data-vaire-repo` contract external-view.ts also relies on).
  bodyEl.setAttribute('data-vaire-repo', target.bodyRepo);

  const child = new MarkdownRenderChild(bodyEl);
  ctx.addChild(child);
  await MarkdownRenderer.render(plugin.app, sectioned, bodyEl, target.sourcePath, child);
}

function renderMissingBody(bodyEl: HTMLElement, address: string): void {
  const box = bodyEl.createDiv({ cls: 'vaire-embed-missing' });
  box.createSpan({ text: 'Not found: ' });
  box.createEl('code', { text: address });
}

// ---- locating and reading the embedded node's raw content -------------------------------

interface EmbedTarget {
  /** Full raw file content, frontmatter included — split by the caller. */
  raw: string;
  /** `sourcePath` for `MarkdownRenderer.render`: a vault path for local nodes, the
   * `__vaire_external__/…` synthetic path (see pure-ext.ts) for a dependency. */
  sourcePath: string;
  /** Absolute root of the package the embedded node itself belongs to. */
  bodyRepo: string;
}

/**
 * Locates and reads the embedded node's raw Markdown, per the task brief's resolution order:
 * a local node in `repo` itself -> `LocalIndex.get` + `vault.cachedRead`; an `@pkg` that is
 * itself a vault package -> the same, via that package's own `LocalIndex`; otherwise a
 * dependency -> `plugin.resolveViaCli` (to find its path within its own package) +
 * `resolveDependencyRoot` (to find that package's root on disk) + `fs.readFileSync`.
 */
async function loadEmbedTarget(plugin: VairePlugin, ref: IdRef, repo: string): Promise<EmbedTarget | null> {
  if (!ref.pkg) {
    const originPkg = plugin.packages.all().find((p) => p.absRoot === repo);
    if (!originPkg) return null;
    const node = originPkg.index.get(ref.local);
    if (!node) return null;
    const raw = await plugin.app.vault.cachedRead(node.file);
    return { raw, sourcePath: node.file.path, bodyRepo: originPkg.absRoot };
  }

  const vaultPkg = plugin.packages.byName(ref.pkg);
  if (vaultPkg) {
    const node = vaultPkg.index.get(ref.local);
    if (!node) return null;
    const raw = await plugin.app.vault.cachedRead(node.file);
    return { raw, sourcePath: node.file.path, bodyRepo: vaultPkg.absRoot };
  }

  const result = await plugin.resolveViaCli(repo, ref.full);
  if (!result) return null;
  const depRoot = await resolveDependencyRoot(plugin, ref.pkg, repo);
  if (!depRoot) return null;
  try {
    const raw = fs.readFileSync(path.join(depRoot, result.path), 'utf8');
    return { raw, sourcePath: externalSourcePath(depRoot, result.path), bodyRepo: depRoot };
  } catch {
    return null;
  }
}
