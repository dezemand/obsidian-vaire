// Pure helpers for the external read-only view and the catalog/registry browser. No `obsidian`
// import here (Node builtins + `smol-toml` are fine) so this stays unit-testable in `bun test`.
// See DESIGN.md "Features §4 External read-only pages" and "§5 Catalog and registries".

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** Splits a Markdown file's leading `---` frontmatter block from its body. CRLF-tolerant. */
export function splitFrontmatter(text: string): { frontmatterText: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { frontmatterText: '', body: text };
  }
  const lines = normalized.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatterText: '', body: text };
  return { frontmatterText: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/** `<repo>/knowledge.toml`'s `name`/`version`/`description`, or `null` if missing/unreadable/incomplete. */
export function readManifest(repo: string): { name: string; version: string; description?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(repo, 'knowledge.toml'), 'utf8');
    const data = parseToml(raw) as Record<string, unknown>;
    if (typeof data.name !== 'string' || typeof data.version !== 'string') return null;
    const description = typeof data.description === 'string' ? data.description : undefined;
    return { name: data.name, version: data.version, description };
  } catch {
    return null;
  }
}

/** The text of the first level-1 Markdown heading (`# ...`, not `##`), trimmed. CRLF-tolerant. */
export function firstH1(body: string): string | undefined {
  const normalized = body.replace(/\r\n/g, '\n');
  const match = /^#(?!#)[ \t]+(.+?)[ \t]*$/m.exec(normalized);
  return match ? match[1].trim() : undefined;
}

const UNITS: Array<[string, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** A short "N units ago"/"in N units" string for a unix-seconds timestamp relative to `now`. */
export function relativeTime(unixSeconds: number, now: number): string {
  const diff = now - unixSeconds;
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < 30) return 'just now';
  for (const [label, secs] of UNITS) {
    if (abs >= secs) {
      const count = Math.floor(abs / secs);
      const plural = count === 1 ? label : `${label}s`;
      return future ? `in ${count} ${plural}` : `${count} ${plural} ago`;
    }
  }
  const count = Math.max(1, Math.floor(abs));
  const plural = count === 1 ? 'second' : 'seconds';
  return future ? `in ${count} ${plural}` : `${count} ${plural} ago`;
}

export interface DescribedRegistryPackage {
  name: string;
  versions: string[];
  description?: string;
}

export interface DescribedRegistry {
  rows: Array<[string, string]>;
  packages: DescribedRegistryPackage[];
  raw?: string;
}

function scalarToString(v: string | number | boolean): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

function versionsOf(pkg: Record<string, unknown>): string[] {
  const fromArray = (arr: unknown[]): string[] =>
    arr.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.version === 'string') return obj.version;
        if (typeof obj.tag === 'string') return obj.tag;
      }
      return String(item);
    });
  if (Array.isArray(pkg.versions)) return fromArray(pkg.versions);
  if (Array.isArray(pkg.releases)) return fromArray(pkg.releases);
  if (pkg.latest !== undefined && pkg.latest !== null) return [String(pkg.latest)];
  return [];
}

/**
 * Best-effort rendering of `registry show`'s unpinned-down JSON shape (DESIGN.md "CLI contract
 * nuances"): known top-level scalar fields become rows, a `packages` array (objects with `name`
 * and `versions`/`releases`/`latest`) becomes a packages table, and — only when neither of those
 * produced anything — the whole thing falls back to pretty-printed JSON.
 */
export function describeRegistryShow(result: Record<string, unknown>): DescribedRegistry {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(result)) {
    if (key === 'packages') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rows.push([key, scalarToString(value)]);
    }
  }

  const packages: DescribedRegistryPackage[] = [];
  if (Array.isArray(result.packages)) {
    for (const item of result.packages) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== 'string') continue;
      packages.push({
        name: obj.name,
        versions: versionsOf(obj),
        description: typeof obj.description === 'string' ? obj.description : undefined,
      });
    }
  }

  if (rows.length === 0 && packages.length === 0) {
    return { rows, packages, raw: JSON.stringify(result, null, 2) };
  }
  return { rows, packages };
}

/** The `sourcePath` passed to `MarkdownRenderer.render` for an external page (see DESIGN.md). */
export function externalSourcePath(repo: string, filePath: string): string {
  return `__vaire_external__/${encodeURIComponent(repo)}/${filePath}`;
}

// ---- Render-mode external pages (feat/ext-render-mode) -----------------------------------
//
// `vaire render <id>` returns Markdown whose resolvable `[[...]]` links are already rewritten
// to plain `[Display](relative/path.md)` links (same-package hrefs relative to the rendered
// file's own directory, cross-package hrefs real filesystem-relative paths through the
// resolved dependency root — see DESIGN.md "CLI contract nuances" / scratchpad `cli-contract.md`
// §7). Obsidian's own reading-mode renderer doesn't know how to resolve either shape against
// a dependency's on-disk layout, so `rewriteRenderedLinks` turns every such link into a
// `vaire://<absolute-path>` href the post processor can route (see `render/reading.ts`).

const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const FENCE_RE = /^\s*(```|~~~)/;

export interface RewriteRenderedLinksResult {
  markdown: string;
  /** Original href (exactly as it appeared in the input) -> the absolute path it resolved to. Only holds entries for hrefs that were actually rewritten — non-`.md` links (images) and links carrying a URL scheme (`https://`, `mailto:`, …) are left untouched and are not in the map. */
  map: Map<string, string>;
}

/** Resolves a single `.md` href against the directory of the file it appears in, or `null` if `href` isn't a rewritable same-file-tree link (has a URL scheme, or doesn't point at a `.md` file). */
function resolveRewritableHref(href: string, baseDir: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (URL_SCHEME_RE.test(trimmed)) return null; // http:, https:, mailto:, vaire: (already rewritten), …
  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  if (!pathPart.toLowerCase().endsWith('.md')) return null;
  let decoded: string;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    decoded = pathPart;
  }
  return path.normalize(path.join(baseDir, decoded));
}

/**
 * Rewrites every resolvable-`.md` Markdown link `[Display](href)` in `render`-mode output into
 * `[Display](vaire://<encodeURIComponent(absolutePath)>)`, where `absolutePath` is `href`
 * resolved against the directory of the rendered file (`path.dirname(path.join(repo,
 * filePath))`) — this works uniformly for same-package hrefs (`./x.md`, `../y/z.md`) and
 * cross-package hrefs (real filesystem-relative paths into a dependency's store/working-copy
 * root), since both are already plain relative paths in `render` output. Links inside fenced
 * code blocks, non-`.md` links (images) and links with a URL scheme are left untouched. Any
 * `[[...]]` wikilink `render` left unresolved (see DESIGN.md) is untouched too — it isn't
 * `[text](href)` shaped, so it never matches here, and reaches the ordinary post-processor path
 * instead.
 */
export function rewriteRenderedLinks(
  markdown: string,
  opts: { repo: string; filePath: string },
): RewriteRenderedLinksResult {
  const map = new Map<string, string>();
  const baseDir = path.dirname(path.join(opts.repo, opts.filePath));
  let inFence = false;

  const rewrittenLines = markdown.split('\n').map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(MD_LINK_RE, (full: string, display: string, href: string) => {
      const absPath = resolveRewritableHref(href, baseDir);
      if (!absPath) return full;
      map.set(href, absPath);
      return `[${display}](vaire://${encodeURIComponent(absPath)})`;
    });
  });

  return { markdown: rewrittenLines.join('\n'), map };
}

/**
 * A deliberately minimal YAML-scalar reader for a frontmatter block, used only when a node's
 * `id`/`type`/`name`/`scope` are needed but there is no CLI result to read them from (opening a
 * `vaire://` link by absolute path — see `ExternalState.filePath` in `external-view.ts`).
 * Handles exactly two shapes per line: `key: scalar` (optionally quoted) and `key: [a, b, c]`
 * (a flat list of optionally-quoted, comma-separated scalars). Anything else — nested maps,
 * block scalars (`|`/`>`), multi-line lists — is silently skipped for that key; frontmatter
 * this simple covers every bookkeeping field (`id`, `type`, `name`, `scope`, `aliases`) in
 * practice, and this is only ever a display fallback, not a source of truth.
 */
export function frontmatterScalars(text: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (!value) continue; // no scalar on this line — likely a nested block; not handled

    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      result[key] = inner === '' ? [] : inner.split(',').map((item) => unquoteScalar(item.trim()));
      continue;
    }
    result[key] = unquoteScalar(value);
  }
  return result;
}

function unquoteScalar(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Walks up from the directory containing `absPath` to the nearest ancestor holding a
 * `knowledge.toml`, returning that directory — the package root owning the file — or `null` if
 * none is found before the filesystem root. Pure (`fs.existsSync` only); used to route a
 * `vaire://<absolute-path>` click to the right `ExternalState.repo`.
 */
export function findPackageRoot(absPath: string): string | null {
  let dir = path.dirname(absPath);
  // Bound the walk so a pathological input (e.g. a relative path) can't loop forever.
  for (let i = 0; i < 1000; i++) {
    if (fs.existsSync(path.join(dir, 'knowledge.toml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Truncates a long path to at most `max` characters, keeping the start and end, `…` in between. */
export function shortPath(p: string, max: number): string {
  if (p.length <= max) return p;
  if (max <= 1) return p.slice(0, Math.max(0, max));
  const ellipsis = '…';
  const keep = Math.max(0, max - ellipsis.length);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return p.slice(0, head) + ellipsis + (tail > 0 ? p.slice(p.length - tail) : '');
}
