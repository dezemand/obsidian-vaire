// Pure logic for "Rename node id…" — no `obsidian` import, so this stays unit-testable in
// plain `bun test`. See the vaire-versioning skill: an address *is* the identity, so a rename
// is really a removal + an addition. Removal is a MAJOR change for anything outside this
// package unless a tombstone keeps the old address resolving (vaire-package-curation: "moving
// knowledge between packages with tombstones" — a same-package rename is the same shape).
// This module offers both strategies as data so the modal (rename-modal.ts) can lay them out
// side by side and apply whichever one is picked:
//
//  - **tombstone** (release-safe, default): the old address keeps resolving. A new file is
//    written at `<same folder>/<new id>.md` carrying the old frontmatter (id/type changed,
//    `updated` bumped) and the old body verbatim; the old file is stripped down to a minimal
//    tombstone (`id`/`type`/`name`/`scope` kept, `superseded_by` + `updated` added, body
//    replaced by a one-line redirect note). In-vault references can optionally be rewritten to
//    the new id — cosmetic, since the redirect already keeps them resolving (mirrors
//    supersede-pure.ts's rewrite option), but defaults to *on* here because a rename (unlike a
//    supersede-to-a-different-node) is usually meant to actually relocate the address people
//    type.
//  - **rewrite-in-place**: the file itself is renamed and its frontmatter changed in place, no
//    tombstone. The old address stops resolving entirely, so every in-vault reference is
//    rewritten unconditionally (not optional — the alternative is a self-inflicted
//    `dangling_ref`), and any backlink from outside this package (a dependent package that
//    referenced the old id) is left to dangle — that is the MAJOR-for-outsiders trade-off this
//    strategy makes explicit.
//
// `withChangedIdentity` and the frontmatter/body split helpers operate on raw file text (not a
// parsed-then-reserialized frontmatter object) specifically so that comments and key order in
// the rest of the frontmatter survive — something `app.fileManager.processFrontMatter` does not
// guarantee, since it re-serializes the whole block.

import { validateSlug, yamlScalar } from './pure';

// ---- frontmatter/body splitting -----------------------------------------------------------

export interface SplitFile {
  /** Raw text between the two `---` fences (fences excluded, no leading/trailing newline). */
  frontmatterText: string;
  /** Everything after the closing fence's newline, verbatim. */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Splits a node file's raw content into its frontmatter text and body. `null` if `content`
 *  doesn't start with a `---` frontmatter block at all (not a Vairë node file). */
export function splitFrontmatter(content: string): SplitFile | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;
  return { frontmatterText: match[1], body: match[2] };
}

/** Inverse of `splitFrontmatter`: reassembles a file's raw content from its parts. */
export function joinFrontmatter(frontmatterText: string, body: string): string {
  return `---\n${frontmatterText}\n---\n${body}`;
}

// ---- identity rewriting on raw frontmatter text -------------------------------------------

const ID_LINE_RE = /^id:(\s.*)?$/;
const TYPE_LINE_RE = /^type:(\s.*)?$/;
const UPDATED_LINE_RE = /^updated:(\s.*)?$/;

/**
 * Rewrites `frontmatterText` (as produced by `splitFrontmatter`) so its `id:`/`type:` lines
 * carry the new values and its `updated:` line reads `today` — every other line (other keys,
 * blank lines, `# comment` lines) is returned byte-for-byte unchanged, so key order and
 * comments survive. `id`/`type` are always the bare unquoted slug form vaire-files uses, so no
 * YAML quoting is needed for those two lines. If a file is somehow missing its `id:`/`type:`
 * line (should not happen for an indexed node), the new line is appended rather than dropped
 * silently; `updated:` is appended the same way when absent.
 */
export function withChangedIdentity(frontmatterText: string, id: string, type: string, today: string): string {
  const lines = frontmatterText.split('\n');
  let sawId = false;
  let sawType = false;
  let sawUpdated = false;

  const rewritten = lines.map((line) => {
    if (ID_LINE_RE.test(line)) {
      sawId = true;
      return `id: ${id}`;
    }
    if (TYPE_LINE_RE.test(line)) {
      sawType = true;
      return `type: ${type}`;
    }
    if (UPDATED_LINE_RE.test(line)) {
      sawUpdated = true;
      return `updated: ${today}`;
    }
    return line;
  });

  if (!sawId) rewritten.push(`id: ${id}`);
  if (!sawType) rewritten.push(`type: ${type}`);
  if (!sawUpdated) rewritten.push(`updated: ${today}`);

  return rewritten.join('\n');
}

// ---- tombstone body ------------------------------------------------------------------------

/** The old file's body once it becomes a tombstone: a one-line redirect note, per the
 *  vaire-package-curation skill's "replace its content with frontmatter carrying
 *  `superseded_by`" — the body is replaced the same way a moved-knowledge tombstone's is. */
export function tombstoneBody(name: string, newFull: string): string {
  return `# ${name}\n\nMoved to [[${newFull}]].\n`;
}

/** The old file's minimal tombstone frontmatter text (id/type/name/scope kept, superseded_by +
 *  updated added) — hand-built rather than derived from `withChangedIdentity` because *every
 *  other* key from the old frontmatter is deliberately dropped here (it moved to the new file),
 *  not preserved. `name` is the only field that might need YAML quoting. */
function tombstoneFrontmatterText(input: {
  id: string;
  type: string;
  name: string;
  scope?: string;
  supersededBy: string;
  updated: string;
}): string {
  const lines = [`id: ${input.id}`, `type: ${input.type}`, `name: ${yamlScalar(input.name)}`];
  if (input.scope) lines.push(`scope: ${input.scope}`);
  lines.push(`superseded_by: ${input.supersededBy}`, `updated: ${input.updated}`);
  return lines.join('\n');
}

// ---- backlinks -----------------------------------------------------------------------------

/** The bits of `BacklinkEntry` (src/types.ts) this module needs — kept structural so this file
 *  doesn't have to import `src/types.ts` just for one interface. */
export interface RenameBacklinkRow {
  id: string;
  type: string;
  /** Path relative to the owning package's root (this package for an in-vault row). */
  path: string;
  /** Present only when the referencing node lives in a dependency (or another catalog
   *  package) — the split this module (and supersede-pure.ts before it) uses for "in this
   *  package" vs. "dependency/other-package". */
  package?: string;
  ref_type: string;
  line: number;
}

/** Splits `backlinks` into in-vault (same-package, rewritable) rows and dependency/other-
 *  package rows — the latter are read-only from here, so a rename can only ever leave them
 *  resolving (tombstone) or dangling (rewrite-in-place), never rewrite them. */
export function splitBacklinks(backlinks: RenameBacklinkRow[]): {
  inVault: RenameBacklinkRow[];
  external: RenameBacklinkRow[];
} {
  const inVault: RenameBacklinkRow[] = [];
  const external: RenameBacklinkRow[] = [];
  for (const b of backlinks) (b.package ? external : inVault).push(b);
  return { inVault, external };
}

// ---- the plan --------------------------------------------------------------------------------

export type RenameStrategy = 'tombstone' | 'rewrite-in-place';

export interface RenameNodeInput {
  /** Vault-relative path of the file being renamed, relative to the package root (matches
   *  `BacklinkEntry.path`'s convention) — the caller joins it to the package dir when touching
   *  the actual vault. */
  path: string;
  id: string;
  type: string;
  /** Container id (`type:id`) for a scoped node — unchanged by a rename. */
  scope?: string;
  /** Full old id, e.g. `type:id` or `scope/type:id`. */
  full: string;
  name: string;
  frontmatterText: string;
  body: string;
}

export interface PlanRenameInput {
  node: RenameNodeInput;
  newId: string;
  newType: string;
  strategy: RenameStrategy;
  backlinks: RenameBacklinkRow[];
  /** Tombstone strategy only — the "rewrite in-vault references" checkbox (default on in the
   *  modal). Ignored for `rewrite-in-place`, which always rewrites: there is no redirect to
   *  fall back on there. */
  rewriteRefs: boolean;
  /** `YYYY-MM-DD`, pre-formatted by the caller so tests can pin the clock. */
  today: string;
  /** Every full id already known to the package (`pkg.index`'s keys) — the collision check. */
  existingFullIds: string[];
}

export interface RenameWrite {
  path: string;
  content: string;
}

export interface RenameMove {
  oldPath: string;
  newPath: string;
}

/** A full-content rewrite of just the frontmatter block of an existing file (`vault.process`);
 *  the body is left untouched by whatever applies this. */
export interface RenameFrontmatterRewrite {
  path: string;
  frontmatterText: string;
}

/** The old node's transformation into a tombstone: `keep` names the only frontmatter keys that
 *  survive (everything else in the live frontmatter object is dropped), `body` is the new file
 *  content's body. Applying this is naturally two calls — `processFrontMatter` to prune/set the
 *  keys, `vault.process` to replace the body — since pruning unknown keys is what
 *  `processFrontMatter`'s mutate-in-place object is for. */
export interface RenameTombstone {
  path: string;
  keep: { id: string; type: string; name: string; scope?: string };
  supersededBy: string;
  updated: string;
  body: string;
}

export interface RenameReferenceRewrite {
  /** Package-relative path (see `RenameNodeInput.path`). */
  path: string;
  line: number;
  oldFull: string;
  newFull: string;
}

export interface RenamePlan {
  strategy: RenameStrategy;
  oldFull: string;
  newFull: string;
  /** New files to create verbatim (`vault.create`). */
  writes: RenameWrite[];
  /** File renames (`fileManager.renameFile`). */
  renames: RenameMove[];
  /** Frontmatter-only rewrites of an existing file (`vault.process`). */
  frontmatterRewrites: RenameFrontmatterRewrite[];
  /** Set only for the tombstone strategy. */
  tombstone: RenameTombstone | null;
  /** Per-line reference rewrites in this package's vault files (`vault.process`, reusing
   *  `rewriteReference` from supersede-pure.ts). */
  referenceRewrites: RenameReferenceRewrite[];
  inVaultBacklinks: RenameBacklinkRow[];
  /** Dependency/other-package backlinks — informational for the tombstone strategy (they keep
   *  resolving through the redirect just like in-vault ones), the "will dangle" list for
   *  rewrite-in-place. */
  externalBacklinks: RenameBacklinkRow[];
}

/** The new file path for `newId` in the same directory as `oldPath` (both package-relative) —
 *  exported so `rename-modal.ts` can compute the same target path for its live "a file already
 *  exists there" check before a plan is even built. */
export function siblingPath(oldPath: string, newId: string): string {
  const slash = oldPath.lastIndexOf('/');
  const dir = slash >= 0 ? oldPath.slice(0, slash) : '';
  return dir ? `${dir}/${newId}.md` : `${newId}.md`;
}

/**
 * Builds the exact set of file operations for a rename, for either strategy. Throws a plain
 * `Error` (message meant for the modal's Notice/inline error) when the input itself is invalid:
 * a bad slug, a no-op rename, or a new id that collides with an existing one in the package.
 * Everything else — which files to touch, what their new content is, which backlink lines to
 * rewrite — is computed here so `rename-modal.ts` only has to execute the plan.
 */
export function planRename(input: PlanRenameInput): RenamePlan {
  const { node, strategy, today } = input;
  const newId = input.newId.trim();
  const newType = input.newType.trim();

  if (!validateSlug(newId)) {
    throw new Error('Id must be lowercase letters, digits and dashes, starting with a letter or digit.');
  }
  if (!validateSlug(newType)) {
    throw new Error('Type must be lowercase letters, digits and dashes.');
  }

  const newFull = node.scope ? `${node.scope}/${newType}:${newId}` : `${newType}:${newId}`;
  if (newFull === node.full) {
    throw new Error('The new id and type are the same as the current ones.');
  }
  if (input.existingFullIds.includes(newFull)) {
    throw new Error(`${newFull} already exists.`);
  }

  // The new file a rename produces — `writes[0].path` for tombstone, `renames[0].newPath` for
  // rewrite-in-place — computed once up front so the self-reference fix-up below (and each
  // strategy branch) shares it.
  const newPath = siblingPath(node.path, newId);

  const { inVault, external } = splitBacklinks(input.backlinks);
  const doRewrite = strategy === 'rewrite-in-place' ? true : input.rewriteRefs;
  const referenceRewrites: RenameReferenceRewrite[] = doRewrite
    ? inVault.map((b) => ({
        // A backlink row whose path is the node's own (pre-rename) path is a self-reference:
        // the node links to itself in its own body/frontmatter. By the time reference rewrites
        // are applied, that content no longer lives at the old path — tombstone strategy has
        // already moved it to `newPath` (`writes[0]`), and rewrite-in-place has already renamed
        // the file there (`renames[0]`). Route the rewrite at the file's post-rename location
        // instead of its pre-rename one, or it silently finds nothing to rewrite and the
        // self-reference is left pointing at the old (for tombstone: now-tombstoned) id.
        path: b.path === node.path ? newPath : b.path,
        line: b.line,
        oldFull: node.full,
        newFull,
      }))
    : [];

  if (strategy === 'tombstone') {
    const newContent = joinFrontmatter(withChangedIdentity(node.frontmatterText, newId, newType, today), node.body);
    const tombstone: RenameTombstone = {
      path: node.path,
      keep: { id: node.id, type: node.type, name: node.name, scope: node.scope },
      supersededBy: newFull,
      updated: today,
      body: tombstoneBody(node.name, newFull),
    };
    return {
      strategy,
      oldFull: node.full,
      newFull,
      writes: [{ path: newPath, content: newContent }],
      renames: [],
      frontmatterRewrites: [],
      tombstone,
      referenceRewrites,
      inVaultBacklinks: inVault,
      externalBacklinks: external,
    };
  }

  // rewrite-in-place
  return {
    strategy,
    oldFull: node.full,
    newFull,
    writes: [],
    renames: [{ oldPath: node.path, newPath }],
    frontmatterRewrites: [{ path: newPath, frontmatterText: withChangedIdentity(node.frontmatterText, newId, newType, today) }],
    tombstone: null,
    referenceRewrites,
    inVaultBacklinks: inVault,
    externalBacklinks: external,
  };
}

// Exposed for tests and for the modal's own "here's the minimal tombstone frontmatter" preview,
// if it wants one — kept separate from `RenameTombstone.keep` (which is what the modal actually
// applies) so a test can assert on the rendered text directly.
export { tombstoneFrontmatterText };

// ---- summary ---------------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface RenameSummaryInput {
  oldFull: string;
  newFull: string;
  strategy: RenameStrategy;
  filesWritten: number;
  referencesRewritten: number;
  danglingCount: number;
}

/** The one-line Notice text summarizing a completed rename. */
export function summarizeRename(input: RenameSummaryInput): string {
  const parts = [
    `${input.oldFull} → ${input.newFull}`,
    input.strategy === 'tombstone' ? 'old address still resolves' : 'old address removed',
    plural(input.filesWritten, 'file'),
  ];
  if (input.referencesRewritten > 0) parts.push(`${plural(input.referencesRewritten, 'reference')} rewritten`);
  if (input.danglingCount > 0) parts.push(`${plural(input.danglingCount, 'backlink')} now dangling`);
  return parts.join(' · ');
}
