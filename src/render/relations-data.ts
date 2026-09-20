// Pure data-shaping helpers for the reading-mode relations footer (src/render/relations.ts)
// and the node panel's own Relations sections (src/views/node-view.ts) — kept here, with no
// `obsidian` import, so both surfaces agree and stay unit-testable in plain `bun test` (see
// tests/relations.test.ts). Mirrors renderer-conventions.md §1 "Trailing sections".

import { extractFrontmatterEdges, parseRef, type IdRef, type LooseRef } from '../ids';

/**
 * Outgoing id references for the "References →" section: every frontmatter edge (in
 * authored/frontmatter order) followed by every prose link (in appearance order), deduped by
 * full address. Loose ends are excluded — they have their own "Loose ends" section — but a
 * frontmatter or prose link that doesn't resolve to a node is still included here (the caller
 * renders it through `createRefElement`, which shows it as "missing" once resolution settles,
 * so a broken edge stays visible per renderer-conventions.md §1).
 */
export function outgoingRefs(
  frontmatter: Record<string, unknown> | undefined,
  proseLinkTargets: string[],
): IdRef[] {
  const seen = new Set<string>();
  const refs: IdRef[] = [];

  for (const edge of extractFrontmatterEdges(frontmatter)) {
    for (const value of edge.values) {
      if (value.kind !== 'id') continue;
      if (seen.has(value.full)) continue;
      seen.add(value.full);
      refs.push(value);
    }
  }

  for (const target of proseLinkTargets) {
    const parsed = parseRef(target);
    if (!parsed || parsed.kind !== 'id') continue;
    if (seen.has(parsed.full)) continue;
    seen.add(parsed.full);
    refs.push(parsed);
  }

  return refs;
}

/**
 * Loose ends declared by this node: `[[?type: descriptor]]` prose links (from the metadata
 * cache's `links`, which record raw wikilink targets regardless of whether they resolve) plus
 * bare `"?type: descriptor"` frontmatter strings, deduped by their raw text. Frontmatter first,
 * then prose in appearance order, matching `outgoingRefs`'s convention.
 */
export function looseEndsOf(
  frontmatter: Record<string, unknown> | undefined,
  proseLinkTargets: string[],
): LooseRef[] {
  const seen = new Set<string>();
  const loose: LooseRef[] = [];

  for (const edge of extractFrontmatterEdges(frontmatter)) {
    for (const value of edge.values) {
      if (value.kind !== 'loose') continue;
      if (seen.has(value.raw)) continue;
      seen.add(value.raw);
      loose.push(value);
    }
  }

  for (const target of proseLinkTargets) {
    if (!target.trim().startsWith('?')) continue;
    const parsed = parseRef(target);
    if (!parsed || parsed.kind !== 'loose') continue;
    if (seen.has(parsed.raw)) continue;
    seen.add(parsed.raw);
    loose.push(parsed);
  }

  return loose;
}

/** Backlinks sorted by address, per renderer-conventions.md §1 ("no explicit type-group headers"). */
export function sortBacklinksById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/** Above this many entries in either column, the References/Backlinks grid stacks full-width. */
export const RELATIONS_WIDE_THRESHOLD = 12;

/**
 * Whether the References/Backlinks grid should switch from side-by-side to the stacked
 * `.wide` layout, per renderer-conventions.md §1 ("once either list exceeds 12 entries").
 */
export function isWideRelations(
  referencesCount: number,
  backlinksCount: number,
  threshold: number = RELATIONS_WIDE_THRESHOLD,
): boolean {
  return referencesCount > threshold || backlinksCount > threshold;
}

/**
 * Whether the section ending at `lineEnd` (0-indexed, from `MarkdownSectionInformation`) is the
 * last section of a document whose full source text is `fullText` (per Obsidian's own quirk,
 * `getSectionInfo(el).text` is the *whole* document, not just this section — see
 * src/render/relations.ts for how this is used). A document commonly ends with a trailing
 * newline (and sometimes more than one blank line after that), which after `split('\n')`
 * shows up as one or more trailing empty strings that aren't really "lines" any section spans
 * — so instead of comparing against the raw element count, this walks back from the end to the
 * last genuinely non-empty line and compares against that.
 */
export function isLastSection(fullText: string, lineEnd: number): boolean {
  const lines = fullText.split('\n');
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty > 0 && lines[lastNonEmpty].trim() === '') lastNonEmpty--;
  return lineEnd >= lastNonEmpty;
}
