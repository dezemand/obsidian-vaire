// Data lookup for the hover-preview feature: given a parsed id ref and the resolution root it
// was rendered against (exactly the `{ref, repo}` `createRefElement` was called with — see the
// `data-vaire-ref`/`data-vaire-repo` attributes `ref-el.ts` and `live.ts` now carry), fetches
// enough of the target node to render a popover without a full `MarkdownRenderer` pass: type,
// full address, name, aliases, `updated`/`status`, frontmatter edges as plain text, and the
// first paragraph of the body. See BRANCHES.md's `feat/hover-preview` entry and DESIGN.md
// "Local index" / "Features §4 External read-only pages" for the two resolution paths mirrored
// here (`resolveLocalSync` from ref-el.ts, `resolveDependencyRoot` from external-catalog.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { displayNameFrom, extractFrontmatterEdges, type FrontmatterEdge, type IdRef } from '../ids';
import type { LocalNode } from '../packages';
import type VairePlugin from '../main';
import type { ResolveResult } from '../types';
import { resolveDependencyRoot } from '../views/external-catalog';
import { firstH1, readManifest, splitFrontmatter } from '../views/pure-ext';
import { resolveLocalSync } from './ref-el';
import { basenameNoExt } from './pure';
import { aliasesFrom, createTtlCache, firstParagraph, scalarField, type PlainEdge } from './preview-pure';

export interface NodePreview {
  type: string;
  id: string;
  /** Full address as it would be written inside `[[...]]`, including any `@pkg/` prefix. */
  full: string;
  pkg?: string;
  name: string;
  aliases: string[];
  updated?: string;
  status?: string;
  edges: PlainEdge[];
  firstParagraph: string;
}

const PREVIEW_TTL_MS = 60_000;
const cache = createTtlCache<NodePreview | null>(PREVIEW_TTL_MS);

/** Drops every cached preview — call on `index-rebuilt` so a stale read doesn't linger for the full TTL. */
export function clearPreviewCache(): void {
  cache.clear();
}

/**
 * Looks up preview data for `ref` as rendered against resolution root `repo` (i.e. exactly the
 * `opts.repo` `createRefElement` was given). `null` covers every "nothing to show" outcome
 * alike — not found, an unlinked/unresolvable dependency, or a read/CLI failure — since the
 * popover only ever needs to decide between "show this" and "say not found". Memoized per
 * `repo full-address` for 60s (see `clearPreviewCache`).
 */
export function previewFor(plugin: VairePlugin, ref: IdRef, repo: string): Promise<NodePreview | null> {
  const key = `${repo} ${ref.full}`;
  return cache.get(key, () => computePreview(plugin, ref, repo));
}

async function computePreview(plugin: VairePlugin, ref: IdRef, repo: string): Promise<NodePreview | null> {
  const local = resolveLocalSync(plugin, ref, repo);
  if (local) return localPreview(plugin, ref, local);

  if (ref.pkg) {
    const depRoot = await resolveDependencyRoot(plugin, ref.pkg, repo);
    if (!depRoot) return null; // package not linked/known here
    return externalPreview(plugin, ref, depRoot);
  }

  // No `@pkg` and no vault-local hit: `repo` is itself an external resolution root (e.g. inside
  // the external view, or a same-package ref the local index hasn't caught up on) — mirrors
  // ref-el.ts's `settleAsync`, which falls through to the CLI the same way.
  return externalPreview(plugin, ref, repo);
}

function edgesToPlain(edges: FrontmatterEdge[]): PlainEdge[] {
  return edges.map((edge) => ({
    key: edge.key,
    values: edge.values.map((v) => (v.kind === 'text' ? v.text : v.kind === 'id' ? v.full : v.raw)),
  }));
}

async function localPreview(plugin: VairePlugin, ref: IdRef, node: LocalNode): Promise<NodePreview | null> {
  try {
    const raw = await plugin.app.vault.cachedRead(node.file);
    const { body } = splitFrontmatter(raw);
    return {
      type: node.type,
      id: node.id,
      // `ref.full` (not `node.full`) so a cross-package-but-still-in-vault reference (§ ref-el.ts
      // "resolution order" case 2) shows the `@pkg/...` address the author actually wrote,
      // matching the tooltip `createRefElement` gives that same element.
      full: ref.full,
      pkg: ref.pkg,
      name: node.name,
      aliases: node.aliases,
      updated: scalarField(node.frontmatter, 'updated'),
      status: scalarField(node.frontmatter, 'status'),
      edges: edgesToPlain(extractFrontmatterEdges(node.frontmatter)),
      firstParagraph: firstParagraph(body),
    };
  } catch {
    return null;
  }
}

async function externalPreview(plugin: VairePlugin, ref: IdRef, depRoot: string): Promise<NodePreview | null> {
  let result: ResolveResult | null;
  try {
    result = await plugin.resolveViaCli(depRoot, ref.local);
  } catch {
    return null; // dependency error, spawn failure, index not built, ...
  }
  if (!result) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(depRoot, result.path), 'utf8');
  } catch {
    return null;
  }

  const { body } = splitFrontmatter(raw);
  const fm = result.frontmatter as Record<string, unknown> | undefined;
  const name = displayNameFrom(fm, firstH1(body), basenameNoExt(result.path));
  // `ref.pkg` is absent for a same-package link found *inside* the external view (the source
  // markdown has no reason to write `@pkg/` for a link within its own package) — fall back to
  // the dependency's own manifest, same as external-view.ts's header, so the popover still
  // shows a proper `@pkg/...` address rather than a bare, context-free `type:id`.
  const pkgName = ref.pkg ?? result.package ?? readManifest(depRoot)?.name;

  return {
    type: ref.type,
    id: ref.id,
    full: pkgName ? `@${pkgName}/${ref.local}` : ref.full,
    pkg: pkgName,
    name,
    aliases: aliasesFrom(fm),
    updated: scalarField(fm, 'updated'),
    status: scalarField(fm, 'status'),
    edges: edgesToPlain(extractFrontmatterEdges(fm)),
    firstParagraph: firstParagraph(body),
  };
}
