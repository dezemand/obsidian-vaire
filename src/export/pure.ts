// Pure transforms for "portable Markdown export" (see DESIGN.md's export feature brief and
// BRANCHES.md wave 7). No `obsidian` import — same discipline as src/views/pure-ext.ts, which
// this module leans on for frontmatter/manifest/package-root helpers. Node's `fs`/`path` are
// fine (as in pure-ext.ts, "pure" here means "no obsidian import", not "no I/O").
//
// Two independent transforms for the branch's central trade-off:
//  - `localPortable`: rewrites the *current editor buffer* using only vault-local knowledge
//    (a `LocalIndex` lookup callback + an optional already-cached external-name lookup) — no
//    CLI call, so it's instant and sees unsaved edits, but it only ever resolves vault nodes.
//  - `postProcessRendered`: rewrites `vaire render`'s own output (already fully resolved
//    against the index) so its cross-package hrefs — real filesystem paths into a dependency's
//    store/working-copy root — survive being moved into the export location.
// Both produce the same kind of portable Markdown: wikilinks/rendered links become plain
// `[Text](path)` or descriptor text; nothing a non-Vairë Markdown reader can't follow.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFrontmatterEdges, parseRef, type FrontmatterEdge, type IdRef, type VaireRef } from '../ids';
import { findPackageRoot, frontmatterScalars, readManifest, rewriteRenderedLinks, splitFrontmatter } from '../views/pure-ext';

// ---- shared bits ----------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;
const FENCE_RE = /^\s*(```|~~~)/;

/** Mirrors `graph/export.ts`'s `DEFAULT_CANVAS_FOLDER`: `settings.exportFolder`'s default value,
 *  duplicated here only as a fallback guard against an empty/hand-edited `data.json` (see
 *  `src/export/index.ts`'s `exportToFile`). */
export const DEFAULT_EXPORT_FOLDER = 'Vairë exports';

/** Runs `transformLine` over every line of `text` that is not inside a fenced code block
 *  (``` or ~~~), leaving fence delimiters and their contents untouched — the same convention
 *  `rewriteRenderedLinks` (src/views/pure-ext.ts) uses for `vaire render` output. */
function mapOutsideFences(text: string, transformLine: (line: string) => string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return transformLine(line);
    })
    .join('\n');
}

/** A vault-relative-to-vault-relative (or absolute-to-absolute) relative Markdown link, in the
 *  style `vaire render` itself emits: `./sibling.md` for the same directory, `../x/y.md`
 *  otherwise — always forward-slashed regardless of platform. `fromDir` and `toPath` must be in
 *  the same "space" (both vault-relative, or both real filesystem paths). */
export function relativeLink(fromDir: string, toPath: string): string {
  const rel = path.relative(fromDir, toPath).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** `<exportFolder>/<fileNameFor(fullId)>` — Obsidian never allows `:` in a note name (and a
 *  scoped id's `/` would be read as a subfolder), so both are replaced with `-`, matching
 *  `canvasFileName`'s convention (src/graph/canvas.ts). */
export function exportFileName(fullId: string): string {
  return `${fullId.replace(/[:/]/g, '-')}.md`;
}

/** The HTML comment every export is prefixed with, so a `render` export and a `local` export of
 *  the same node (or two exports taken days apart) can be told apart at a glance. */
export function exportHeaderComment(fullId: string, mode: 'render' | 'local', isoDate: string): string {
  return `<!-- exported from vaire: ${fullId} via ${mode} on ${isoDate} -->`;
}

/** One line: `Name (type:id, package@version)` — for the "Copy node citation" command.
 *  `node.full` is the address exactly as `LocalIndex`/the CLI spell it (`type:id`, or
 *  `scope/type:id` for a scoped node); `pkg` is the owning package's name/version. Plain text
 *  only — no markdown link, even when the package has a published site (see DESIGN.md). */
export function citationFor(node: { full: string; name: string }, pkg: { name: string; version: string }): string {
  return `${node.name} (${node.full}, ${pkg.name}@${pkg.version})`;
}

// ---- local mode (src/export/pure.ts's `localPortable`) -------------------------------------

export interface LocalPortableContext {
  /** Directory (in the same "space" as the paths `resolveLocal` returns — vault-relative for a
   *  vault target) the exported node's own file lives in; body/edge links are written relative
   *  to this via `relativeLink`. */
  fromDir: string;
  /** Resolves a reference against the vault: a bare `[[type:id]]` (or an already-scoped
   *  `[[container/type:id]]`) against the node's own package, or an `[[@pkg/type:id]]` whose
   *  package also happens to be open in this vault. `null` when nothing in the vault answers to
   *  it (the node isn't indexed yet, or the reference is genuinely dangling). */
  resolveLocal: (ref: IdRef) => { path: string; name: string } | null;
  /** For an `[[@pkg/type:id]]` that did *not* resolve locally: a display name already cached
   *  from an earlier CLI resolve this session, if any — never triggers a new CLI call. Omit (or
   *  return `undefined`) to always fall back to the bare address. */
  knownExternalName?: (ref: IdRef) => string | undefined;
  /** Append a "## Relations" section built from the frontmatter edges. Default `true`. */
  edgesSection?: boolean;
  /** Suffix an unresolved reference — every loose end, and a same-package id `LocalIndex`
   *  doesn't know — with " (unresolved)". Default `false`. */
  markUnresolved?: boolean;
}

function renderRef(ref: VaireRef, ctx: LocalPortableContext): string {
  if (ref.kind === 'loose') {
    const text = ref.display ?? ref.descriptor;
    return ctx.markUnresolved ? `${text} (unresolved)` : text;
  }

  const local = ctx.resolveLocal(ref);
  if (local) {
    const label = ref.display ?? local.name;
    return `[${label}](${relativeLink(ctx.fromDir, local.path)})`;
  }

  if (ref.pkg) {
    const known = ctx.knownExternalName?.(ref);
    const label = ref.display ?? known;
    return label ? `${label} (${ref.full})` : ref.full;
  }

  // A same-package id LocalIndex doesn't know (not yet indexed, or genuinely dangling) —
  // degrade like a loose end rather than leave a dead `[[wikilink]]` in the export.
  const text = ref.display ?? ref.full;
  return ctx.markUnresolved ? `${text} (unresolved)` : text;
}

/** Every distinct Vairë reference in `markdown` — body wikilinks (fences excluded) followed by
 *  frontmatter edges — for a caller that wants to know what to pre-warm a name cache for before
 *  calling `localPortable` (see `src/export/index.ts`). Not deduped by the caller's choice of
 *  key on purpose (an id ref and its frontmatter twin are both handed back); callers that want a
 *  dedup pick their own key (`full`/`raw`). */
export function collectRefs(markdown: string): VaireRef[] {
  const { frontmatterText, body } = splitFrontmatter(markdown);
  const refs: VaireRef[] = [];

  mapOutsideFences(body, (line) => {
    for (const match of line.matchAll(WIKILINK_RE)) {
      const ref = parseRef(match[1]);
      if (ref) refs.push(ref);
    }
    return line;
  });

  const fm = frontmatterScalars(frontmatterText);
  for (const edge of extractFrontmatterEdges(fm)) {
    for (const value of edge.values) {
      if (value.kind !== 'text') refs.push(value);
    }
  }

  return refs;
}

function relationsSection(edges: FrontmatterEdge[], ctx: LocalPortableContext): string {
  if (edges.length === 0) return '';
  const lines = ['## Relations', ''];
  for (const edge of edges) {
    const rendered = edge.values.map((v) => (v.kind === 'text' ? v.text : renderRef(v, ctx)));
    lines.push(`- **${edge.key}**: ${rendered.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Transforms `markdown` (the *current editor buffer*, so unsaved edits are included) into
 * portable Markdown using only vault-local knowledge — see the module doc comment and
 * DESIGN.md's `exportMode: 'local'` trade-off. Frontmatter is kept verbatim (matching `vaire
 * render`'s own "frontmatter kept" convention); when `ctx.edgesSection` is on (default), its
 * edges are additionally rendered as a trailing "## Relations" list, each value resolved exactly
 * like a body reference.
 */
export function localPortable(markdown: string, ctx: LocalPortableContext): string {
  const { frontmatterText, body } = splitFrontmatter(markdown);

  const transformedBody = mapOutsideFences(body, (line) =>
    line.replace(WIKILINK_RE, (full, inner: string) => {
      const ref = parseRef(inner);
      return ref ? renderRef(ref, ctx) : full; // not a Vairë ref — an ordinary Obsidian link, leave alone
    }),
  );

  const head = frontmatterText ? `---\n${frontmatterText}\n---\n` : '';
  let result = head + transformedBody;

  if (ctx.edgesSection ?? true) {
    const fm = frontmatterScalars(frontmatterText);
    const relations = relationsSection(extractFrontmatterEdges(fm), ctx);
    if (relations) result = `${result.replace(/\n+$/, '')}\n\n${relations}\n`;
  }

  return result;
}

// ---- render mode (src/export/pure.ts's `postProcessRendered`) ------------------------------

export interface PostProcessRenderedOptions {
  /** Absolute root of the package the rendered node lives in — the same `repo` passed to
   *  `cli.render`. Used to tell a same-package link (rebased, kept as a link either way) from a
   *  cross-package one (governed by `crossPackageLinks`). */
  repo: string;
  /** Repo-relative path of the rendered node, i.e. `RenderResult.path` — the directory `vaire
   *  render`'s own relative hrefs are relative to. */
  sourcePath: string;
  /** Absolute directory the export will live in once written (or, for a clipboard copy with
   *  nowhere to move to, the rendered node's own directory — see `src/export/index.ts`). Every
   *  link that stays a link is rebased to be relative to this directory, so it still resolves
   *  from the export's new home instead of silently breaking. */
  exportDir: string;
  /** How a cross-package href is rendered: `'path'` keeps it as a (rebased) relative link;
   *  `'text'` drops the link and keeps only the display text; `'address'` replaces it with
   *  `Display (@pkg/type:id)`, recovered by reading the target file's own frontmatter plus its
   *  package's `knowledge.toml` name off disk (same trick `external-view.ts` uses for a `vaire:`
   *  link's identity — see `frontmatterScalars`'s doc comment). Same-package links are always
   *  kept as (rebased) links, regardless of this setting — it only governs the "machine-specific
   *  filesystem path" problem `vaire render` has for cross-package hrefs (see DESIGN.md).
   */
  crossPackageLinks: 'path' | 'text' | 'address';
}

const VAIRE_SCHEME_LINK_RE = /\[([^\]]*)\]\(vaire:\/\/([^)]+)\)/g;

/** Whether `target` sits inside `dir` (both absolute paths). */
function isUnder(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `@pkgname/type:id` (or `@pkgname/scope/type:id` for a scoped node) for the node living at
 *  `absPath`, recovered by reading its own frontmatter plus its package root's `knowledge.toml`
 *  name off disk — `vaire render`'s cross-package hrefs are plain filesystem paths, so the
 *  address itself isn't otherwise recoverable from the rendered output. `null` if `absPath`
 *  isn't inside a package, isn't readable, or lacks `id`/`type`. */
function addressFor(absPath: string): string | null {
  const root = findPackageRoot(absPath);
  if (!root) return null;
  const manifest = readManifest(root);
  if (!manifest) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const { frontmatterText } = splitFrontmatter(raw);
  const fm = frontmatterScalars(frontmatterText);
  const type = fm.type;
  const id = fm.id;
  if (typeof type !== 'string' || typeof id !== 'string') return null;
  const scope = typeof fm.scope === 'string' ? fm.scope : undefined;
  const local = scope ? `${scope}/${type}:${id}` : `${type}:${id}`;
  return `@${manifest.name}/${local}`;
}

/**
 * Post-processes `vaire render`'s own Markdown output (see DESIGN.md's `exportMode: 'render'`
 * trade-off): every same-package `.md` link is rebased to stay correct once the file moves to
 * `opts.exportDir`; every cross-package link — a real filesystem path into a dependency's
 * store/working-copy root, meaningless on a machine that doesn't have that path — is handled per
 * `opts.crossPackageLinks`. Reuses `rewriteRenderedLinks` (src/views/pure-ext.ts) for the
 * fence-aware link scan and href → absolute-path resolution it already implements for the
 * external view's `vaire://` links, then classifies and rewrites each one from there. Frontmatter
 * is never touched (it's already left as plain address text by `vaire render` itself).
 */
export function postProcessRendered(markdown: string, opts: PostProcessRenderedOptions): string {
  const { markdown: withVaireLinks } = rewriteRenderedLinks(markdown, { repo: opts.repo, filePath: opts.sourcePath });

  return withVaireLinks.replace(VAIRE_SCHEME_LINK_RE, (full, display: string, encoded: string) => {
    let absPath: string;
    try {
      absPath = decodeURIComponent(encoded);
    } catch {
      return full;
    }

    if (isUnder(opts.repo, absPath)) {
      return `[${display}](${relativeLink(opts.exportDir, absPath)})`;
    }

    switch (opts.crossPackageLinks) {
      case 'text':
        return display;
      case 'address': {
        const addr = addressFor(absPath);
        return addr ? `${display} (${addr})` : display;
      }
      case 'path':
      default:
        return `[${display}](${relativeLink(opts.exportDir, absPath)})`;
    }
  });
}
