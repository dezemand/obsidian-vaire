// Pure helpers for the per-document prefetch pass (prefetch.ts) — no `obsidian` import, so
// these stay unit-testable in plain `bun test` (see tests/prefetch.test.ts). See DESIGN.md
// "CLI adapter" / "JSON shapes" (`render`'s markdown rewrites every resolvable reference to
// `[Display](relative/path.md)`) and BRANCHES.md `perf/refs-prefetch`.

export interface RenderedLink {
  /** The link's visible text, exactly as written (may contain parens, punctuation, etc.). */
  display: string;
  /** The link's raw destination, exactly as written in the markdown. */
  href: string;
}

/**
 * Blanks out every inline code span (`` `...` ``, `` ``...`` ``, `` ```...``` `` — same-length
 * backtick delimiters, non-greedy) with spaces of equal length, so a later regex pass can't
 * mistake a link-shaped snippet inside code for a real link, while every other character's
 * offset in the line is preserved.
 */
function maskCodeSpans(line: string): string {
  return line.replace(/(`{1,3})[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
}

/** Matches `[display](href)`, optionally preceded by `!` for an image link (captured so the
 *  caller can skip it). `display` may contain parens/punctuation; `href` may not contain `)`. */
const LINK_RE = /(!)?\[([^\]]*)\]\(([^)]*)\)/g;

/**
 * Extracts every non-image Markdown link `[display](href)` from a `render`-command markdown
 * body: `![...](...)` image links and anything inside a fenced code block or inline code span
 * are ignored. Order follows first appearance in the text; a target linked more than once
 * appears more than once (callers that want the first display name should take the first
 * match).
 */
export function extractRenderedLinks(markdown: string): RenderedLink[] {
  const links: RenderedLink[] = [];
  const lines = markdown.split('\n');
  let fenceChar: string | null = null; // '`' or '~' while inside a fenced code block, else null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      fenceChar = fenceChar === null ? ch : fenceChar === ch ? null : fenceChar;
      continue;
    }
    if (fenceChar !== null) continue;

    const masked = maskCodeSpans(rawLine);
    LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(masked))) {
      const isImage = !!match[1];
      if (isImage) continue;
      const href = match[3].trim();
      if (!href) continue;
      links.push({ display: match[2], href });
    }
  }

  return links;
}

/** Splits a path/href into its non-empty, non-`.`/`..` segments (order preserved). */
function segments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

/**
 * Whether `href` (a link destination from rendered markdown — same-package relative, or a
 * `../../.vaire/store/<pkg>/<version>/...` path into a dependency root) points at `path` (a
 * `refs`/`resolve` result's path, relative to the owning package's root): true when `href`'s
 * trailing path segments equal `path`'s segments exactly, per DESIGN.md's "match on the
 * trailing path segment" rule for `@pkg` refs.
 */
export function hrefMatchesPath(href: string, path: string): boolean {
  const hrefSegs = segments(href);
  const pathSegs = segments(path);
  if (pathSegs.length === 0 || hrefSegs.length < pathSegs.length) return false;
  const tail = hrefSegs.slice(hrefSegs.length - pathSegs.length);
  return tail.join('/') === pathSegs.join('/');
}
