// Multi-occurrence rewrite for the loose-end workbench: resolving a group means rewriting
// *every* occurrence of it, in every file it appears in, to the same id — unlike
// `applyResolution` (src/suggest/index.ts), which resolves exactly one `[[?...]]` at the
// cursor/click location. This module reuses the same line-level primitives
// (`findLooseEndByDescriptor`/`rewriteLooseEnd` from src/suggest/pure.ts) rather than
// re-deriving the rewrite logic, and preserves each occurrence's own descriptor wording as
// display text, same as `applyResolution` does.

import { Notice, TFile } from 'obsidian';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import type { Candidate } from '../suggest/pure';
import { findLooseEndByDescriptor, rewriteLooseEnd } from '../suggest/pure';
import type { LooseEndItem } from '../types';
import { vaultPathFor } from '../views/pure-pkg';
import type { LooseEndGroup } from './pure';

export interface ResolveGroupResult {
  succeeded: number;
  failed: number;
}

/**
 * Rewrites every occurrence in `group` to `[[<candidate.id>|<that occurrence's own
 * descriptor>]]`. Occurrences are grouped by file so each file gets exactly one
 * `vault.process` call (one atomic read-modify-write instead of one per occurrence); within a
 * file, occurrences are rewritten highest-line-first ("bottom-up") so that if a future change
 * to the rewrite step ever shifts line counts, an earlier (higher-line) rewrite never
 * invalidates a later (lower-line) occurrence's line number — today's `rewriteLooseEnd` never
 * changes the number of lines, but locating each occurrence by its own line + descriptor text
 * (not by index) is what actually makes this safe either way.
 *
 * Runs `plugin.rebuildIndex(pkg)` once at the end when at least one occurrence succeeded (the
 * same "rewrite then rebuild" sequence every other mutating action in this codebase follows —
 * see src/views/deps-actions.ts), and shows one summary `Notice` covering the whole group.
 * Does not reload any view; callers re-render after this resolves.
 */
export async function resolveGroup(
  plugin: VairePlugin,
  pkg: PackageInfo,
  group: LooseEndGroup,
  candidate: Candidate,
): Promise<ResolveGroupResult> {
  const byVaultPath = new Map<string, LooseEndItem[]>();
  for (const occurrence of group.occurrences) {
    const vaultPath = vaultPathFor(pkg.dir, occurrence.path);
    const bucket = byVaultPath.get(vaultPath);
    if (bucket) bucket.push(occurrence);
    else byVaultPath.set(vaultPath, [occurrence]);
  }

  let succeeded = 0;
  let failed = 0;

  for (const [vaultPath, occurrences] of byVaultPath) {
    const file = plugin.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      failed += occurrences.length;
      continue;
    }

    const bottomUp = [...occurrences].sort((a, b) => b.line - a.line);
    try {
      await plugin.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        for (const occurrence of bottomUp) {
          const idx = occurrence.line - 1;
          const lineText = lines[idx];
          if (lineText === undefined) {
            failed++;
            continue;
          }
          const found = findLooseEndByDescriptor(lineText, occurrence.descriptor);
          if (!found) {
            failed++;
            continue;
          }
          lines[idx] = rewriteLooseEnd(lineText, found, candidate.id);
          succeeded++;
        }
        return lines.join('\n');
      });
    } catch {
      failed += occurrences.length;
    }
  }

  if (succeeded > 0) await plugin.rebuildIndex(pkg);

  new Notice(
    failed === 0
      ? `Vairë: resolved ${succeeded} occurrence(s) to ${candidate.id}`
      : `Vairë: resolved ${succeeded} occurrence(s) to ${candidate.id} — ${failed} could not be found (the file may have changed)`,
  );

  return { succeeded, failed };
}
