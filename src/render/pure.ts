// Pure helpers for the rendering pass — no `obsidian` import, so these stay unit-testable
// in plain `bun test` (see tests/render.test.ts). DOM-touching code (ref-el.ts, reading.ts,
// header.ts, live.ts, click.ts, properties.ts) calls into these instead of duplicating string
// logic inline.
//
// `../ids` is itself DOM/obsidian-free (see its own header comment), so importing from it
// here doesn't break bun-test-ability.

import { extractFrontmatterEdges, parseRef, type VaireRef } from '../ids';
import type { ResolveResult } from '../types';

/**
 * Extracts the raw Vairë ref target text from an anchor's `data-href`/`href` pair.
 * Prefers `dataHref`, strips a trailing `#...` subpath, and decodes percent-escapes
 * defensively (some paths through Obsidian's renderer leave the target unencoded).
 * Returns `null` when neither attribute carries anything usable.
 */
export function extractLinkTarget(
  dataHref: string | null | undefined,
  href: string | null | undefined,
): string | null {
  const raw = (dataHref && dataHref.trim()) || (href && href.trim()) || '';
  if (!raw) return null;
  const hashIdx = raw.indexOf('#');
  const withoutSubpath = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  if (!withoutSubpath) return null;
  try {
    return decodeURIComponent(withoutSubpath);
  } catch {
    return withoutSubpath;
  }
}

/**
 * Obsidian already splits off a `|display` alias before setting the anchor's text, so an
 * anchor's rendered text differing from its (subpath-stripped, decoded) href target means
 * the author wrote an explicit display override.
 */
export function hasDisplayOverride(anchorText: string, target: string): boolean {
  return anchorText.trim() !== target.trim();
}

export interface WikilinkSpan {
  start: number;
  end: number;
  /** The text between `[[` and `]]`, including any `|display` suffix. */
  inner: string;
}

/**
 * Finds the `[[...]]` span in `line` that contains column `ch` (inclusive of both edges,
 * so a click right on the brackets still counts). Used by click.ts to figure out which
 * wikilink a live-preview click landed on. Does not match across newlines or nested `[[`.
 */
export function findWikilinkSpan(line: string, ch: number): WikilinkSpan | null {
  const re = /\[\[([^[\]\n]*)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (ch >= start && ch <= end) {
      return { start, end, inner: match[1] };
    }
  }
  return null;
}

/**
 * Parses the `__vaire_external__/<encodeURIComponent(absRoot)>/<path>` sourcePath prefix
 * the external view uses (see DESIGN.md "Phase 2 ownership"). Returns the decoded absolute
 * package root, or `null` when `sourcePath` doesn't carry the prefix.
 */
export function parseExternalSourcePath(sourcePath: string): string | null {
  const prefix = '__vaire_external__/';
  if (!sourcePath.startsWith(prefix)) return null;
  const rest = sourcePath.slice(prefix.length);
  const slashIdx = rest.indexOf('/');
  const encoded = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** Last path segment of `p`, with a trailing `.md` stripped. Used as a display-name fallback. */
export function basenameNoExt(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** `_`/`-` -> spaces, for frontmatter edge keys (`related_systems` -> `related systems`). */
export function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ');
}

/** The literal marker a diagram-shape link target is prefixed with (see diagrams.ts). */
export const DIAGRAM_REF_PREFIX = 'vaire/';

/**
 * Strips the `vaire/` marker off a rendered `<a href="…">`/`xlink:href` value from inside a
 * Mermaid diagram's SVG, returning the raw address text after it (still unparsed — callers
 * pass it to `parseRef`). Returns `null` when `href` doesn't carry the marker at all (an
 * ordinary URL the diagram author linked to, which diagrams.ts must leave untouched) or when
 * nothing follows the prefix. See renderer-conventions.md §5 for why the prefix exists at all
 * (Mermaid's default `securityLevel` strips `href`s that look like a URI scheme; a bare
 * `type:id` looks exactly like one, so a path-shaped `vaire/…` prefix dodges that).
 */
export function diagramTargetFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(DIAGRAM_REF_PREFIX)) return null;
  const rest = trimmed.slice(DIAGRAM_REF_PREFIX.length).trim();
  return rest || null;
}

// ---- Tooltip text builders, one per createRefElement state -------------------------------

/** `type:id · Name` for a resolved node in the same (or a locally-linked) package. */
export function localTooltip(addr: string, name: string): string {
  return `${addr} · ${name}`;
}

/** `type:id · Name · @pkg` for a resolved node in a dependency package. */
export function externalTooltip(addr: string, name: string, pkg: string): string {
  return `${addr} · ${name} · @${pkg}`;
}

/** A dependency that is declared but not linked/known — resolution never got to try. */
export function unlinkedTooltip(addr: string, pkg: string): string {
  return `${addr} lives in package '${pkg}', which is not linked here`;
}

/** No node with this address, locally or via the CLI; `message` carries a CLI error if any. */
export function missingTooltip(addr: string, message?: string): string {
  return message ? `not found in this package: ${addr} — ${message}` : `not found in this package: ${addr}`;
}

/** A `[[?type: descriptor]]` loose end — never resolves, always the same tooltip. */
export function looseTooltip(): string {
  return 'unresolved reference — not a tracked node yet (click to resolve)';
}

// ---- Properties-panel decoration (properties.ts) -----------------------------------------
//
// Obsidian's Properties panel has no post-processor hook, so `properties.ts` decorates the
// rendered DOM directly (a MutationObserver + a `metadataCache.on('changed')` refresh). The
// two decisions that DOM code needs — which frontmatter keys qualify, and which raw value
// strings are ref-shaped — are pulled out here so they stay unit-testable without a DOM.

/**
 * The set of frontmatter keys the Properties panel should decorate: whatever
 * `extractFrontmatterEdges` reports (which already excludes the bookkeeping keys `id`,
 * `type`, `name`, `aliases`, `scope`, `updated`, `since` — and, for the node header's sake,
 * `superseded_by` too) plus `superseded_by` itself when it parses as a ref. The node header
 * shows `superseded_by` as a dedicated tombstone banner instead of an edge row, but the
 * Properties panel has no such banner, so it still needs decorating there.
 */
export function propertyEdgeKeys(frontmatter: Record<string, unknown> | undefined): Set<string> {
  const keys = new Set(extractFrontmatterEdges(frontmatter).map((edge) => edge.key));
  const supersededBy = frontmatter?.superseded_by;
  if (typeof supersededBy === 'string' && parseRef(supersededBy)) keys.add('superseded_by');
  return keys;
}

export interface PropertyValueMatch {
  /** Index into the `items` array passed to `matchPropertyValues`. */
  index: number;
  ref: VaireRef;
}

/**
 * Given the raw text shown for each value of one Properties-panel-eligible property — one
 * entry for a text/longtext property, one per pill for a multi-select — returns which
 * indices parse as a Vairë reference (id or loose end) and what that reference is. An index
 * whose text isn't ref-shaped (e.g. an ordinary multi-select item) is left out of the
 * result; the caller leaves that value's raw text alone.
 */
export function matchPropertyValues(items: string[]): PropertyValueMatch[] {
  const matches: PropertyValueMatch[] = [];
  items.forEach((text, index) => {
    const ref = parseRef(text.trim());
    if (ref) matches.push({ index, ref });
  });
  return matches;
}

/**
 * The display name for a CLI `resolve` result: `frontmatter.name` if present, else the
 * path's basename, else `fallback`. Shared by the reading-mode CLI-backed resolution
 * (ref-el.ts) and the live-preview inline widget (live.ts) so both name a node the same way.
 */
export function nameFromResolveResult(result: ResolveResult, fallback: string): string {
  const fmName = (result.frontmatter as Record<string, unknown> | undefined)?.name;
  if (typeof fmName === 'string' && fmName.trim()) return fmName.trim();
  const base = basenameNoExt(result.path);
  return base || fallback;
}

// ---- Live preview "B" variant (feat/lp-inline-names) -------------------------------------
//
// The inline-replace widget hides fenced/inline code and picks its display text the same
// way regardless of whether the widget itself has touched the DOM yet — kept here, pure, so
// the CM6-facing code in live.ts only has to wire these together against real editor state.

/**
 * For every line of the document (0-indexed, matching CM6 line numbers minus one), whether
 * that line sits inside a fenced code block (``` or ~~~ fences, up to 3 leading spaces of
 * indent). A fence delimiter line itself counts as fenced. Cheap line-oriented toggle scan —
 * not full CommonMark fence matching (a closing fence of a different character or shorter
 * length than the opener still closes it here), which is an accepted simplification for a
 * "skip decorating this" heuristic.
 */
const FENCE_DELIMITER_RE = /^\s{0,3}(?:```|~~~)/;

export function computeFencedLines(lines: readonly string[]): boolean[] {
  const result: boolean[] = new Array<boolean>(lines.length);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_DELIMITER_RE.test(lines[i])) {
      result[i] = true;
      inFence = !inFence;
    } else {
      result[i] = inFence;
    }
  }
  return result;
}

/**
 * Whether column `col` of `line` sits inside an inline code span, by backtick parity: an odd
 * number of backticks before `col` means we're between an opening and closing backtick.
 */
export function isInlineCodeAtColumn(line: string, col: number): boolean {
  const before = line.slice(0, Math.max(0, col));
  let count = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '`') count++;
  }
  return count % 2 === 1;
}

export interface SimpleRange {
  from: number;
  to: number;
}

/**
 * Whether the line spanning document positions `[lineFrom, lineTo]` overlaps any selection
 * range (touching at a boundary counts as intersecting). Used to decide, per line, whether a
 * Vairë wikilink there should render raw (cursor/selection present) or as a resolved name.
 */
export function lineIntersectsSelection(lineFrom: number, lineTo: number, ranges: readonly SimpleRange[]): boolean {
  return ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

/**
 * Live-preview inline-widget display text, in priority order: the author's `|display`, else
 * the locally-known node name, else a name already resolved via the CLI and cached, else the
 * bare address (shown while a CLI resolution is still pending, or never attempted).
 */
export function chooseLivePreviewDisplayText(
  display: string | undefined,
  localName: string | null | undefined,
  cachedName: string | null | undefined,
  fallback: string,
): string {
  return display || localName || cachedName || fallback;
}

// ---- Node embeds (embeds.ts) --------------------------------------------------------------

export interface ParsedEmbedSrc {
  ref: VaireRef;
  /** The `#Heading` fragment, if any, trimmed and with the leading `#` removed. */
  heading?: string;
}

/**
 * Parses an `.internal-embed`'s `src`/`data-src` attribute — the raw wikilink target text of
 * `![[...]]`, without surrounding brackets — splitting off a trailing `#Heading` fragment
 * before handing the rest to `parseRef`. Returns `null` when the target isn't a Vairë
 * reference at all (an ordinary note/image/PDF embed, which embeds.ts leaves untouched), or
 * when a `#` is present with nothing before it.
 */
export function parseEmbedSrc(src: string): ParsedEmbedSrc | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  const hashIdx = trimmed.indexOf('#');
  const refText = (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).trim();
  const heading = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim() : '';
  if (!refText) return null;
  const ref = parseRef(refText);
  if (!ref) return null;
  return heading ? { ref, heading } : { ref };
}

const HEADING_LINE_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_LINE_RE = /^(```|~~~)/;

/**
 * Extracts the section of Markdown `body` under the heading whose text exactly matches
 * `heading` (case-sensitive, whitespace-trimmed): the heading line itself plus everything
 * after it up to (not including) the next heading of the same or a shallower level (a lower
 * `#` count). Headings inside fenced code blocks are ignored. Returns `null` when no heading
 * in `body` matches. Matches the first occurrence in document order when the same heading
 * text appears more than once.
 */
export function sectionUnderHeading(body: string, heading: string): string | null {
  const needle = heading.trim();
  if (!needle) return null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  let startIdx = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_LINE_RE.test(lines[i].trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_LINE_RE.exec(lines[i]);
    if (match && match[2].trim() === needle) {
      startIdx = i;
      level = match[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  inFence = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (FENCE_LINE_RE.test(lines[i].trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_LINE_RE.exec(lines[i]);
    if (match && match[1].length <= level) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join('\n').trim();
}

// ---- File explorer decoration (explorer.ts) -----------------------------------------------
//
// explorer.ts overlays a type badge (and, in `explorerNames: 'node'` mode, a name swap) onto
// each `.nav-file-title` that is a Vairë node, mirroring properties.ts's DOM-observer pattern.
// The two decisions pulled out here so they stay unit-testable without a DOM: the idempotence
// key stashed in a row's `data-vaire-nav` attribute (skip re-decorating when nothing the badge/
// name/strikethrough depend on has changed), and whether a `.nav-folder-title[data-path]` is a
// package root that should get the `pkg` badge.

export interface NavNodeState {
  type: string;
  name: string;
  /** Whether the node has a `superseded_by` — struck through and faded (`.vaire-nav-gone`). */
  gone: boolean;
}

/**
 * Idempotence key for a decorated `.nav-file-title` row, stored verbatim in its
 * `data-vaire-nav` attribute. explorer.ts re-decorates a row only when this key changes (or a
 * full pass is forced, e.g. after a settings change) — `type`, `name` and `gone` are exactly
 * the inputs the badge text, the `.vaire-nav-name` span and the `.vaire-nav-gone` class depend
 * on, so an unchanged key means nothing on screen needs to change.
 */
export type ExplorerNameMode = 'file' | 'node' | 'id';

/** The text a decorated explorer row shows instead of the file basename, or `null` to keep the
 *  basename (`'file'` mode). */
export function navDisplayText(node: { name: string; full: string }, mode: ExplorerNameMode): string | null {
  if (mode === 'node') return node.name;
  if (mode === 'id') return node.full;
  return null;
}

export function navDecorationKey(node: NavNodeState): string {
  return `${node.type}|${node.name}|${node.gone ? '1' : '0'}`;
}

/**
 * Whether the file explorer folder row at `dataPath` (a `.nav-folder-title`'s `data-path`) is
 * one of the vault's Vairë package roots — i.e. exactly matches some `PackageInfo.dir`. A
 * package rooted at the vault root itself has `dir === ''`, so an empty `dataPath` can match
 * too when such a package is registered.
 */
export function shouldDecorateRow(dataPath: string, pkgDirs: string[]): boolean {
  return pkgDirs.includes(dataPath);
}
