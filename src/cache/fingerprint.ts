// Cheap staleness check for `persistentCache: 'trust-until-reindex'`: whether a package's
// on-disk index has moved since we last trusted its cached resolve/backlink entries. See
// src/cache/store.ts and src/cache/query.ts.
//
// Deliberately just `mtime + size` of `.vaire/index.db`, not a content hash — hashing would
// mean reading a file that can be large, on every cache-consulting call. `vaire`'s own index
// writes are a replace-on-write (never an in-place mutation), so any reindex changes the
// file's mtime, and very nearly always its size too. DESIGN.md also allows folding in
// `last_indexed_commit` (from `vaire status`) "when cheap"; that's deliberately not done here.
// `status` is a CLI spawn, so getting it into this function without spawning it on every
// lookup (which would defeat the whole point of `trust-until-reindex`) would mean some call
// sites compute the fingerprint with the commit and others without — two different formats
// that would look "changed" against each other forever. A real fix needs a shared, already-
// fresh `StatusResult` to fold in opportunistically; nothing in this codebase caches one long
// enough to rely on yet (see src/health/index.ts, which fetches status fresh every time it
// runs). Left as a documented simplification rather than risking that correctness trap.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `<absRoot>/.vaire/index.db`'s mtime and size, joined as one opaque string. `null` when the
 * file can't be stat'd (no index built yet, a typo'd root, a filesystem error, ...) —
 * `src/cache/pure.ts`'s `isFresh` treats `null` as never fresh, even against a previous
 * `null`, so a package that can't be fingerprinted always falls through to a real CLI call.
 */
export function fingerprint(absRoot: string): string | null {
  try {
    const st = fs.statSync(path.join(absRoot, '.vaire', 'index.db'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}
