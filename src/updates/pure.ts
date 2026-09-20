// Pure helpers for dependency updates and store maintenance: turning `vaire pull [--dry-run]`
// and `vaire clean --dry-run` output into something renderable, and reading pin state out of
// `knowledge.lock`. No `obsidian` import (Node builtins + `smol-toml` are fine, same as
// src/views/pure-ext.ts) so this stays unit-testable with plain `bun test` — see
// tests/updates.test.ts, which exercises these against the real JSON captured from the 0.3.2
// binary (tests/fixtures/*.json) per DESIGN.md's "CLI contract nuances": `pull`'s JSON shape is
// undocumented, so every parser here is tolerant by construction — an unrecognized shape falls
// back to `raw` rather than throwing or silently dropping data.
//
// Mirrors the pattern of src/release/pure.ts and src/deps.ts: the UI in section.ts/index.ts is a
// thin, mostly-untested shell around these functions.

import { parse as parseToml } from 'smol-toml';
import type { HealthIssue } from '../health/pure';

// ---- `vaire pull [--dry-run]` ----------------------------------------------------------------

/** One dependency `vaire pull --dry-run` reported it would fetch/replace. `from` is filled in
 *  by the caller (section.ts), which cross-references the currently-resolved version from
 *  `vaire deps` — the pull JSON itself only ever names the version it would fetch *to*. */
export interface PullUpdate {
  name: string;
  from?: string;
  to?: string;
  /** Entities this package cites that changed in the release being adopted (registry.md §6.4's
   *  "adopted-changes digest") — present only when the dry run's JSON carries something that
   *  looks like it under one of a few guessed field names (the shape isn't documented). */
  citedChanges?: string[];
}

/** One registry-side problem `vaire pull --dry-run` reported for a specific dependency (the
 *  `failed` array) — distinct from a whole-call failure (network unreachable, `--locked` with
 *  nothing reproducible), which `run()`/`VaireCli.pull` surfaces as a thrown `VaireError`
 *  instead and never reaches this parser. */
export interface PullError {
  /** Extracted from the message's "looked in <registry>" clause when present (every registry
   *  error we captured phrases it that way); absent when the message doesn't name one. */
  registry?: string;
  message: string;
  /** The dependency this error is about, when the entry names one. */
  package?: string;
}

export interface ParsedPullDryRun {
  updates: PullUpdate[];
  errors: PullError[];
  /** Dependency names the dry run reported as already at the version the registry would
   *  return (the `already` array) — not an update, not an error, just informational. */
  upToDate: string[];
  /** Set only when the top-level JSON didn't match any of `pulled`/`already`/`failed` at all —
   *  the UI's fallback is to show this verbatim instead of a structured table. */
  raw?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** "name version" (the shape `already`'s string entries use) or "name@version" → `{name, version}`;
 *  a bare name with nothing else recognizable keeps just `name`. */
function splitNameVersion(text: string): { name: string; version?: string } {
  const trimmed = text.trim();
  const at = /^([^\s@]+)@(\S+)$/.exec(trimmed);
  if (at) return { name: at[1], version: at[2] };
  const spaced = /^(\S+)\s+(\S+)$/.exec(trimmed);
  if (spaced) return { name: spaced[1], version: spaced[2] };
  return { name: trimmed };
}

const CITED_CHANGES_KEYS = ['cited_changes', 'citedChanges', 'adopted_changes', 'changes_cited', 'digest'];

function extractCitedChanges(o: Record<string, unknown>): string[] | undefined {
  for (const key of CITED_CHANGES_KEYS) {
    const value = o[key];
    // A type-predicate callback (rather than a plain boolean one) lets `.every` narrow the
    // whole array to `string[]` on its own, so the match below needs no assertion.
    if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) return value;
  }
  return undefined;
}

function parsePulledEntry(entry: unknown): PullUpdate | null {
  if (isPlainObject(entry)) {
    const name = typeof entry.package === 'string' ? entry.package : typeof entry.name === 'string' ? entry.name : undefined;
    if (!name) return null;
    const to = typeof entry.version === 'string' ? entry.version : undefined;
    return { name, to, citedChanges: extractCitedChanges(entry) };
  }
  if (typeof entry === 'string' && entry.trim()) {
    const { name, version } = splitNameVersion(entry);
    return { name, to: version };
  }
  return null;
}

function extractRegistry(message: string): string | undefined {
  const m = /looked in ([a-z0-9][a-z0-9._-]*)/i.exec(message);
  return m?.[1];
}

function parseFailedEntry(entry: unknown): PullError | null {
  if (isPlainObject(entry)) {
    const message = typeof entry.reason === 'string' ? entry.reason : typeof entry.message === 'string' ? entry.message : undefined;
    if (!message) return null;
    const pkg = typeof entry.package === 'string' ? entry.package : typeof entry.name === 'string' ? entry.name : undefined;
    return { message, package: pkg, registry: extractRegistry(message) };
  }
  if (typeof entry === 'string' && entry.trim()) {
    return { message: entry, registry: extractRegistry(entry) };
  }
  return null;
}

function parseAlreadyEntry(entry: unknown): string | null {
  if (isPlainObject(entry)) {
    if (typeof entry.package === 'string') return entry.package;
    if (typeof entry.name === 'string') return entry.name;
    return null;
  }
  if (typeof entry === 'string' && entry.trim()) return splitNameVersion(entry).name;
  return null;
}

/**
 * Tolerant reader for `vaire pull [--dry-run]` JSON (DESIGN.md "CLI contract nuances": "`vaire
 * pull` JSON output shape is undocumented: treat the result as opaque"). Recognizes the 0.3.2
 * binary's `{store, pulled, already, failed, dry_run, warnings}` shape (see
 * tests/fixtures/pull-dry-run-*.json) — `pulled` entries become `updates` (what would be
 * fetched/replaced), `failed` entries become `errors`, `already` entries become `upToDate`.
 * Anything else — not an object, or an object with none of those three arrays — is treated as
 * unrecognized and returned as `raw` with empty `updates`/`errors`/`upToDate`, so the caller can
 * fall back to a raw-JSON view instead of silently showing nothing.
 */
export function parsePullDryRun(json: unknown): ParsedPullDryRun {
  if (!isPlainObject(json)) return { updates: [], errors: [], upToDate: [], raw: json };

  const hasPulled = Array.isArray(json.pulled);
  const hasAlready = Array.isArray(json.already);
  const hasFailed = Array.isArray(json.failed);
  if (!hasPulled && !hasAlready && !hasFailed) return { updates: [], errors: [], upToDate: [], raw: json };

  const updates = hasPulled ? (json.pulled as unknown[]).map(parsePulledEntry).filter((v): v is PullUpdate => v !== null) : [];
  const errors = hasFailed ? (json.failed as unknown[]).map(parseFailedEntry).filter((v): v is PullError => v !== null) : [];
  const upToDate = hasAlready ? (json.already as unknown[]).map(parseAlreadyEntry).filter((v): v is string => v !== null) : [];

  return { updates, errors, upToDate };
}

/** Turns a successful `parsePullDryRun` result into a single "updates available" health-strip
 *  issue, or `null` when there's nothing to report — used by the on-open update check
 *  (src/updates/index.ts) to feed `renderHealthStrip` (src/health/index.ts) without that module
 *  needing to know anything about `pull`'s JSON shape. `action: 'open_index'` reuses the health
 *  strip's existing "jump to the package index" action (src/health/pure.ts); there is no
 *  dedicated "open the Updates section" action yet. */
export function updatesHealthIssue(parsed: ParsedPullDryRun): HealthIssue | null {
  if (parsed.updates.length === 0) return null;
  const names = parsed.updates.map((u) => u.name).join(', ');
  return {
    kind: 'updates_available',
    severity: 'info',
    message: `${parsed.updates.length} dependency update(s) available: ${names}`,
    action: 'open_index',
  };
}

// ---- `vaire clean [--dry-run]` -----------------------------------------------------------------

export interface CleanEntry {
  name?: string;
  version?: string;
  sizeBytes?: number;
}

export interface ParsedCleanDryRun {
  removed: CleanEntry[];
  /** How many store entries the sweep would keep (the 0.3.2 binary's `kept` field — a count,
   *  not a list). */
  kept?: number;
  /** Sum of every `removed` entry's `sizeBytes`, when at least one entry reported one. */
  totalSizeBytes?: number;
  raw?: unknown;
}

const SIZE_KEYS = ['size', 'bytes', 'size_bytes', 'sizeBytes'];

function extractSize(o: Record<string, unknown>): number | undefined {
  for (const key of SIZE_KEYS) {
    const value = o[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseRemovedEntry(entry: unknown): CleanEntry | null {
  if (isPlainObject(entry)) {
    const name = typeof entry.package === 'string' ? entry.package : typeof entry.name === 'string' ? entry.name : undefined;
    const version = typeof entry.version === 'string' ? entry.version : undefined;
    return { name, version, sizeBytes: extractSize(entry) };
  }
  if (typeof entry === 'string' && entry.trim()) {
    const { name, version } = splitNameVersion(entry);
    return { name, version };
  }
  return null;
}

/**
 * Tolerant reader for `vaire clean [--dry-run]` JSON — same undocumented-shape caveat as
 * `parsePullDryRun`. Recognizes `{store, removed, kept, dry_run, warnings}` (tests/fixtures/
 * clean-dry-run.json); an object without a `removed` array at all is unrecognized and comes back
 * as `raw`.
 */
export function parseCleanDryRun(json: unknown): ParsedCleanDryRun {
  if (!isPlainObject(json) || !Array.isArray(json.removed)) return { removed: [], raw: json };

  const removed = json.removed.map(parseRemovedEntry).filter((v): v is CleanEntry => v !== null);
  const kept = typeof json.kept === 'number' ? json.kept : undefined;
  const sizes = removed.map((e) => e.sizeBytes).filter((v): v is number => v != null);
  const totalSizeBytes = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) : undefined;

  return { removed, kept, totalSizeBytes };
}

/** One dependency row for the Updates table, combining a `deps` row's currently-resolved
 *  version with what `parsePullDryRun` reported for that name — see `mergeDepsWithUpdates`. */
export interface MergedDependencyRow {
  name: string;
  current?: string;
  available?: string;
  citedChanges?: string[];
  /** A per-dependency problem from the dry run's `failed` array that named this dependency. */
  error?: string;
}

/**
 * Joins a package's depth-1 dependency rows (name + currently-resolved version, from `vaire
 * deps` / `DepRow`) with a `parsePullDryRun` result, by name. Every `depRows` entry produces
 * exactly one output row (an update/error the dry run reported for a name not in `depRows` —
 * a transitive dependency, typically — is dropped, matching the Dependencies table's own
 * depth-1-only convention in src/views/package-view.ts's `renderDepActions`). Pure so the
 * "current → available" pairing is unit-testable without a real `DepsModel`.
 */
export function mergeDepsWithUpdates(depRows: Array<{ name: string; version?: string }>, parsed: ParsedPullDryRun): MergedDependencyRow[] {
  const updateByName = new Map(parsed.updates.map((u) => [u.name, u] as const));
  const errorByName = new Map(parsed.errors.filter((e): e is PullError & { package: string } => e.package != null).map((e) => [e.package, e] as const));

  return depRows.map(({ name, version }) => {
    const update = updateByName.get(name);
    const error = errorByName.get(name);
    return {
      name,
      current: version,
      available: update?.to,
      citedChanges: update?.citedChanges,
      error: error?.message,
    };
  });
}

// ---- `knowledge.lock` pins --------------------------------------------------------------------

export interface LockfilePin {
  name: string;
  version: string;
}

const PIN_FIELD_KEYS = ['pinned', 'pin', 'locked_by_pin', 'is_pinned'];

/** Renders a byte count as "12.4 MB"-style text for the Clean-store preview, base-1024, one
 *  decimal place past the first unit. Never throws — a negative/non-finite input reads as `?`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const formatted = unit === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

/**
 * Reads `knowledge.lock` (TOML; registry.md §7's `[[package]]` array) for entries the lockfile
 * itself marks pinned. The captured sample (tests/fixtures/knowledge.lock) has no pinned entries
 * to confirm a field name against — the spec says a pin is recorded in the lockfile (§6.3, §8)
 * but not under what key — so this checks a short list of plausible boolean field names and
 * otherwise reports no pins. Tolerant of a missing/malformed/unparseable file: returns `[]`
 * rather than throwing, matching `readManifest` in src/views/pure-ext.ts. Callers (src/updates/
 * section.ts) treat an empty result as "the lockfile doesn't expose pin state (or there are
 * none)", not as "nothing is pinned", and fall back to `VaireSettings.pinnedDependencies`.
 */
export function lockfilePins(lockText: string): LockfilePin[] {
  try {
    const data = parseToml(lockText) as Record<string, unknown>;
    const packages = Array.isArray(data.package) ? data.package : [];
    const pins: LockfilePin[] = [];
    for (const entry of packages) {
      if (!isPlainObject(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const version = typeof entry.version === 'string' ? entry.version : undefined;
      if (!name || !version) continue;
      const pinned = PIN_FIELD_KEYS.some((key) => entry[key] === true);
      if (pinned) pins.push({ name, version });
    }
    return pins;
  } catch {
    return [];
  }
}
