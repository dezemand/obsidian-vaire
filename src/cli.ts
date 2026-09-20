// Adapter over the `vaire` CLI binary. Desktop-only (uses Node's child_process/fs), but
// intentionally does not import `obsidian` so it can be unit-tested with a fake `exec`.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CatalogList,
  CheckResult,
  CleanResult,
  DepsResult,
  PackResult,
  PullResult,
  RefsResult,
  RegistryList,
  RegistryShow,
  ReleasePlan,
  RenderResult,
  ResolveResult,
  SearchResult,
  StatusResult,
  SuggestResult,
  UnresolvedResult,
  VaireErrorEnvelope,
  BacklinksResult,
} from './types';
import type { McpClient } from './mcp/client';
import { McpClientPool } from './mcp/pool';
import { LatencyTracker, needsSpawnFallback, toolArgs, type LatencySnapshot, type McpCommand, type ToolArgsInput } from './mcp/pure';

export class VaireError extends Error {
  code: number;
  kind: string;
  constructor(message: string, code: number, kind: string) {
    super(message);
    this.name = 'VaireError';
    this.code = code;
    this.kind = kind;
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout?: number },
) => Promise<ExecResult>;

export interface RunOpts {
  repo?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** What `VaireCli` needs from settings. `binaryPath` is required (existing behavior);
 *  `cliTransport` is optional so every existing caller (tests, `main.ts` before this branch)
 *  keeps compiling unchanged and gets the `'spawn'` default. */
export interface VaireCliSettings {
  binaryPath: string;
  /** `perf/mcp-transport`: `'spawn'` (default) — every read spawns a fresh `vaire` process, as
   *  on `main`. `'mcp'` — the eight read commands (resolve/render/backlinks/refs/search/
   *  suggest/unresolved/deps) are routed through a persistent per-package-root `vaire mcp`
   *  server (src/mcp/). Maintenance commands (index, check, status, add, pull, catalog,
   *  registry, release, pack, push, init) always spawn regardless of this setting — the MCP
   *  server only exposes reads. Switchable at runtime; see BRANCHES.md. */
  cliTransport?: 'spawn' | 'mcp';
  /** `feat/dep-updates`: when true, every call adds the global `--frozen` flag (registry.md
   *  §7: "resolution answers only from the store", refusing a dependency that resolves to a
   *  working copy instead of a pulled release). Optional for the same reason `cliTransport`
   *  is — existing callers (tests, any code that predates this branch) keep compiling and get
   *  the `false`/off default. A refusal this causes comes back as an ordinary `VaireError`
   *  from `run()`, so it flows through the same error-rendering paths every other CLI failure
   *  already uses (Notices, inline `.vaire-error` divs) — no special-casing needed here. */
  frozen?: boolean;
}

/** Hooks for events `VaireCli` can't itself turn into UI (it deliberately never imports
 *  `obsidian` — see the file header comment) but that `main.ts` wants to react to. */
export interface VaireCliHooks {
  /** A package root's MCP client crashed too many times in a row and has permanently fallen
   *  back to spawn for the rest of the session (`McpClientPool`'s restart budget). */
  onMcpFallback?: (absRoot: string, reason: string) => void;
}

/** Builds the memo key `VairePlugin.resolveMemo` is keyed by. Shared between the per-link
 *  fallback (`main.ts`'s `resolveViaCli`) and the refs-prefetch pass (`render/prefetch.ts`) so
 *  a prefetch-seeded entry is found by the fallback instead of triggering a redundant spawn.
 *  `\u0000`-separated (spelled as the escape, not a literal byte, so this file stays text —
 *  see `run()`'s `dedupeKey` above) since an id could in principle collide with `absRoot`
 *  under a plain separator. */
export function resolveMemoKey(absRoot: string, id: string): string {
  return `${absRoot}\u0000${id}`;
}

/** One command's spawn count, as returned by `VaireCli.stats()`. */
export interface CliCommandCount {
  command: string;
  count: number;
}

/** Live CLI activity, as shown by the status bar (src/status-bar.ts). */
export interface CliStats {
  /** Total real spawns since the last `resetStats()` (post-dedupe: a shared in-flight call
   *  counts once). */
  total: number;
  /** Calls currently awaiting a result (spawns in flight/queued behind the concurrency limit,
   *  plus MCP tool calls awaiting a response). */
  inFlight: number;
  /** Per top-level command, highest count first. Spawn commands are keyed by their bare name
   *  (`resolve`, `render`, ...); calls made through the MCP transport (`perf/mcp-transport`)
   *  are keyed `mcp:<tool>` (`mcp:resolve`, ...) so the two transports are visible side by side
   *  without merging their counts. */
  byCommand: CliCommandCount[];
}

/** p50/p95 over the last 50 call durations (ms), spawn vs MCP — `perf/mcp-transport`'s
 *  comparison aid, shown in the status bar tooltip. */
export interface CliLatencyStats {
  spawn: LatencySnapshot;
  mcp: LatencySnapshot;
}

const CONCURRENCY_LIMIT = 4;
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB
const EXTRA_PATH_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Same PATH-augmented env every child process (spawn or MCP) gets — see the class doc comment
 *  above `EXTRA_PATH_DIRS`. Exported so `src/mcp/client.ts`/`src/mcp/pool.ts` build their child
 *  environment identically without duplicating the PATH-prepend logic. */
export function childEnv(): NodeJS.ProcessEnv {
  const extra = EXTRA_PATH_DIRS.map(expandHome);
  const current = process.env.PATH ?? '';
  return { ...process.env, PATH: [...extra, current].filter(Boolean).join(path.delimiter) };
}

/** `which vaire`-style scan of PATH, for auto-detection when no binaryPath is configured. */
function whichVaire(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'vaire');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function detectBinary(): string {
  const onPath = whichVaire();
  if (onPath) return onPath;
  for (const candidate of EXTRA_PATH_DIRS) {
    const expanded = path.join(expandHome(candidate), 'vaire');
    if (fs.existsSync(expanded)) return expanded;
  }
  return 'vaire'; // last resort: let the child process's PATH resolve it (or fail loudly)
}

function defaultExec(
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env, maxBuffer: opts.maxBuffer, timeout: opts.timeout, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const errCode = (error as NodeJS.ErrnoException).code;
          const code = typeof errCode === 'number' ? errCode : 1;
          resolve({ stdout: stdout ?? '', stderr: stderr || error.message, code });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        }
      },
    );
  });
}

function parseEnvelope(text: string): VaireErrorEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      parsed.error &&
      typeof parsed.error.code === 'number' &&
      typeof parsed.error.kind === 'string' &&
      typeof parsed.error.message === 'string'
    ) {
      return parsed as VaireErrorEnvelope;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

function parseJsonTolerant<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return {} as T; // non-JSON-producing commands (index, add, pull, ...) on success
  }
}

/** A JSON object on stdout that is not an error envelope (used for outcome exit codes 6/7). */
function parseOutcomeJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !('error' in parsed)) return parsed as T;
  } catch {
    // not JSON
  }
  return null;
}

function tail(text: string, lines: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.split('\n').slice(-lines).join('\n').trim();
}

const READ_ONLY_COMMANDS = new Set([
  'resolve',
  'render',
  'backlinks',
  'refs',
  'search',
  'suggest',
  'unresolved',
  'deps',
  'status',
  'check',
]);

/** Whether a command is read-only and therefore eligible for in-flight dedupe. */
function isReadOnly(args: string[]): boolean {
  const [cmd, sub] = args;
  if (READ_ONLY_COMMANDS.has(cmd)) return true;
  if (cmd === 'catalog' && sub === 'list') return true;
  if (cmd === 'registry' && (sub === 'list' || sub === 'show')) return true;
  return false;
}

export class VaireCli {
  private readonly getSettings: () => VaireCliSettings;
  private readonly exec: ExecFn;
  private readonly hooks: VaireCliHooks;
  private cachedAutoPath: string | null = null;
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();

  // ---- CLI activity counter (src/status-bar.ts) --------------------------
  private readonly callCounts = new Map<string, number>();
  private inFlightSpawns = 0;

  // ---- MCP transport (perf/mcp-transport; src/mcp/) ----------------------
  private pool: McpClientPool | null = null;
  private readonly latency = { spawn: new LatencyTracker(), mcp: new LatencyTracker() };

  constructor(getSettings: () => VaireCliSettings, exec: ExecFn = defaultExec, hooks: VaireCliHooks = {}) {
    this.getSettings = getSettings;
    this.exec = exec;
    this.hooks = hooks;
  }

  /** settings.binaryPath if set, else the auto-detected (and cached) path. */
  binary(): string {
    const configured = this.getSettings().binaryPath;
    if (configured && configured.trim()) return configured.trim();
    if (!this.cachedAutoPath) this.cachedAutoPath = detectBinary();
    return this.cachedAutoPath;
  }

  /** Lazily creates the MCP client pool (one per `VaireCli` instance — matches the one
   *  `binary()`/env resolution it already owns). Not created at all unless `cliTransport` is
   *  ever set to `'mcp'`, so a plugin that never touches the setting never spawns a `vaire mcp`
   *  process. */
  private getPool(): McpClientPool {
    if (!this.pool) {
      this.pool = new McpClientPool({
        binary: () => this.binary(),
        env: () => childEnv(),
        onFallback: (absRoot, reason) => this.hooks.onMcpFallback?.(absRoot, reason),
      });
    }
    return this.pool;
  }

  /** Closes every pooled MCP client. Called by `main.ts` on plugin unload and whenever
   *  `cliTransport` switches away from `'mcp'` — otherwise a `vaire mcp` child process would
   *  keep running (idle-shutdown is 5 minutes) after the user turned the feature off. Safe to
   *  call even if no pool was ever created. */
  closeMcpPool(): void {
    this.pool?.closeAll();
  }

  /** Restarts (drops) the pooled MCP client for one package root, if any — called by `main.ts`
   *  after `index-rebuilt` for that root. See src/mcp/pool.ts's `restart()` doc comment for why
   *  this branch restarts rather than reuses the client across a rebuild. */
  restartMcpClient(absRoot: string): void {
    this.pool?.restart(absRoot);
  }

  /** p50/p95 latency over the last 50 calls, spawn vs MCP — status bar tooltip. */
  latencyStats(): CliLatencyStats {
    return { spawn: this.latency.spawn.snapshot(), mcp: this.latency.mcp.snapshot() };
  }

  private acquireSlot(): Promise<void> {
    if (this.activeCount < CONCURRENCY_LIMIT) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve)).then(() => {
      this.activeCount++;
    });
  }

  private releaseSlot(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(args: string[], opts: RunOpts = {}): Promise<T> {
    const dedupeKey = isReadOnly(args) ? `${opts.repo ?? ''}\u0000${args.join('\u0000')}` : null;
    if (dedupeKey) {
      const existing = this.inFlight.get(dedupeKey);
      if (existing) return existing as Promise<T>;
    }
    const promise = this.execOnce<T>(args, opts);
    if (dedupeKey) {
      this.inFlight.set(dedupeKey, promise);
      promise.finally(() => this.inFlight.delete(dedupeKey)).catch(() => {});
    }
    return promise;
  }

  private async execOnce<T>(args: string[], opts: RunOpts): Promise<T> {
    this.recordCall(args);
    const startedAt = Date.now();
    await this.acquireSlot();
    try {
      const finalArgs = ['-o', 'json', '--no-color', '-q'];
      if (this.getSettings().frozen) finalArgs.push('--frozen');
      if (opts.repo) finalArgs.push('--repo', opts.repo);
      finalArgs.push(...args);

      let result: ExecResult;
      try {
        result = await this.exec(this.binary(), finalArgs, {
          cwd: opts.cwd ?? opts.repo,
          env: childEnv(),
          maxBuffer: MAX_BUFFER,
          timeout: opts.timeoutMs,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const code = typeof e.code === 'number' ? e.code : 1;
        throw new VaireError(e.message || 'failed to spawn vaire', code, 'spawn');
      }

      if (result.code === 0) {
        return parseJsonTolerant<T>(result.stdout);
      }
      const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
      if (envelope) {
        throw new VaireError(envelope.error.message, envelope.error.code, envelope.error.kind);
      }
      // Outcome exit codes (6: `check` found violations, 7: `release` gated) still print the
      // command's normal JSON, unwrapped — hand that back instead of failing.
      const outcome = parseOutcomeJson<T>(result.stdout);
      if (outcome !== null) return outcome;
      throw new VaireError(tail(result.stderr, 20) || `vaire exited with code ${result.code}`, result.code, 'spawn');
    } finally {
      this.releaseSlot();
      this.inFlightSpawns--;
      this.latency.spawn.record(Date.now() - startedAt);
    }
  }

  /** Counts one real spawn (post-dedupe — `run()` shares a single `execOnce` between
   *  identical in-flight read calls), keyed by the top-level command (`args[0]`). */
  private recordCall(args: string[]): void {
    this.inFlightSpawns++;
    const command = args[0] ?? '(unknown)';
    this.callCounts.set(command, (this.callCounts.get(command) ?? 0) + 1);
  }

  /**
   * Routes one of the eight MCP-eligible read commands through the persistent per-root pool
   * when `settings.cliTransport === 'mcp'`, falling back to `run()` (spawn) when: the transport
   * setting isn't `'mcp'`; the call needs something the MCP tool schema can't express
   * (`needsSpawnFallback` — today only `search`/`suggest`'s catalog-wide `--all`, which has no
   * MCP argument); or the pool has given up on this package root after too many crashes
   * (`pool.get()` returns `null`). `spawnArgs`/`spawnOpts` are exactly what the caller would
   * have passed to `run()` directly, so every fallback path behaves identically to `main`.
   *
   * Read-call dedupe and the concurrency limit are transport-scoped on purpose: spawn calls
   * still queue behind `CONCURRENCY_LIMIT` (a real OS process cost that limit exists for), but
   * an MCP call never spawns a process — there's nothing to rate-limit — so it skips
   * `acquireSlot()` entirely. Identical in-flight calls are still deduped either way (the two
   * dedupe keys are namespaced apart so a spawn and an MCP call for the same logical request,
   * e.g. mid-transport-switch, never collide).
   */
  private async runRead<C extends McpCommand>(
    command: C,
    repo: string,
    toolOpts: ToolArgsInput[C],
    spawnArgs: string[],
    spawnOpts: RunOpts = {},
  ): Promise<unknown> {
    const transport = this.getSettings().cliTransport ?? 'spawn';
    if (transport !== 'mcp' || needsSpawnFallback(command, toolOpts)) {
      return this.run(spawnArgs, { ...spawnOpts, repo });
    }
    const client = this.getPool().get(repo);
    if (!client) {
      return this.run(spawnArgs, { ...spawnOpts, repo }); // this root permanently fell back to spawn
    }

    const args = toolArgs(command, toolOpts);
    const dedupeKey = `mcp\u0000${repo}\u0000${command}\u0000${JSON.stringify(args)}`;
    const existing = this.inFlight.get(dedupeKey);
    if (existing) return existing;

    const promise = this.callMcpTool(command, client, args);
    this.inFlight.set(dedupeKey, promise);
    promise.finally(() => this.inFlight.delete(dedupeKey)).catch(() => {});
    return promise;
  }

  private async callMcpTool<C extends McpCommand>(
    command: C,
    client: McpClient,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.recordMcpCall(command);
    const startedAt = Date.now();
    try {
      return await client.callTool(command, args);
    } finally {
      this.inFlightSpawns--;
      this.latency.mcp.record(Date.now() - startedAt);
    }
  }

  /** Counts one MCP tool call, keyed `mcp:<command>` so the status bar shows spawn vs MCP
   *  counts side by side (see `CliStats.byCommand`). */
  private recordMcpCall(command: McpCommand): void {
    this.inFlightSpawns++;
    const key = `mcp:${command}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
  }

  /** Live spawn + MCP counts for the status bar; see `CliStats`. */
  stats(): CliStats {
    const byCommand = [...this.callCounts.entries()]
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));
    const total = byCommand.reduce((sum, c) => sum + c.count, 0);
    return { total, inFlight: this.inFlightSpawns, byCommand };
  }

  /** Clears the call counter (command "Reset CLI call counter"). Does not affect `inFlight`. */
  resetStats(): void {
    this.callCounts.clear();
  }

  /** `vaire --version`, outside the JSON/queue machinery since it isn't a JSON command. */
  async version(): Promise<string | null> {
    try {
      const result = await this.exec(this.binary(), ['--version'], {
        env: childEnv(),
        maxBuffer: 1024 * 1024,
      });
      if (result.code !== 0) return null;
      const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
      return match ? match[1] : result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async available(): Promise<boolean> {
    return (await this.version()) !== null;
  }

  // ---- typed wrappers ---------------------------------------------------

  resolve(repo: string, id: string): Promise<ResolveResult> {
    return this.runRead('resolve', repo, { id }, ['resolve', id]) as Promise<ResolveResult>;
  }

  render(repo: string, id: string): Promise<RenderResult> {
    return this.runRead('render', repo, { id }, ['render', id]) as Promise<RenderResult>;
  }

  backlinks(repo: string, id: string, opts: { type?: string; limit?: number } = {}): Promise<BacklinksResult> {
    const args = ['backlinks', id];
    if (opts.type) args.push('--type', opts.type);
    if (opts.limit != null) args.push('--limit', String(opts.limit));
    return this.runRead('backlinks', repo, { id, ...opts }, args) as Promise<BacklinksResult>;
  }

  refs(repo: string, id: string, depth?: number): Promise<RefsResult> {
    const args = ['refs', id];
    if (depth != null) args.push('--depth', String(depth));
    return this.runRead('refs', repo, { id, depth }, args) as Promise<RefsResult>;
  }

  search(
    repo: string,
    query: string,
    opts: { limit?: number; type?: string; all?: boolean; local?: boolean; scope?: string } = {},
  ): Promise<SearchResult> {
    const args = ['search', query];
    if (opts.type) args.push('--type', opts.type);
    if (opts.limit != null) args.push('--limit', String(opts.limit));
    if (opts.local) args.push('--local');
    if (opts.all) args.push('--all');
    if (opts.scope) args.push('--scope', opts.scope);
    return this.runRead('search', repo, { query, ...opts }, args) as Promise<SearchResult>;
  }

  suggest(
    repo: string,
    descriptor: string,
    opts: { limit?: number; type?: string; all?: boolean; local?: boolean } = {},
  ): Promise<SuggestResult> {
    const args = ['suggest', descriptor];
    if (opts.type) args.push('--type', opts.type);
    if (opts.limit != null) args.push('--limit', String(opts.limit));
    if (opts.local) args.push('--local');
    if (opts.all) args.push('--all');
    return this.runRead('suggest', repo, { descriptor, ...opts }, args) as Promise<SuggestResult>;
  }

  unresolved(repo: string, opts: { allPackages?: boolean } = {}): Promise<UnresolvedResult> {
    const args = ['unresolved'];
    if (opts.allPackages) args.push('--all-packages');
    return this.runRead('unresolved', repo, { ...opts }, args) as Promise<UnresolvedResult>;
  }

  deps(repo: string): Promise<DepsResult> {
    return this.runRead('deps', repo, {}, ['deps']) as Promise<DepsResult>;
  }

  status(repo: string): Promise<StatusResult> {
    return this.run(['status'], { repo });
  }

  check(repo: string, opts: { workingTree?: boolean; strict?: boolean } = {}): Promise<CheckResult> {
    const args = ['check'];
    if (opts.workingTree) args.push('--working-tree');
    if (opts.strict) args.push('--strict');
    return this.run(args, { repo });
  }

  index(repo: string, opts: { workingTree?: boolean; full?: boolean } = {}): Promise<Record<string, never>> {
    const args = ['index'];
    if (opts.workingTree) args.push('--working-tree');
    if (opts.full) args.push('--full');
    return this.run(args, { repo });
  }

  /**
   * Scaffolds `knowledge.toml` (+ `.vaire/.gitignore`) in an existing directory — `vaire init
   * <path>` (spec/cli.md §4.4). `path` is the target directory itself (an absolute path here),
   * not a `--repo`: an explicit path argument is discovery-independent and takes precedence
   * over `--repo`/`VAIRE_REPO`, which is exactly what a not-yet-a-package folder needs. `name`
   * in the resulting manifest is derived from the directory's basename — `init` has no flag to
   * override it (see `src/health/index.ts`'s init-package flow for how a different requested
   * name is applied afterward). Exits with a usage error (kind `usage`/`spawn`) if
   * `<path>/knowledge.toml` already exists — never clobbers an existing manifest.
   */
  init(path: string): Promise<Record<string, never>> {
    return this.run(['init', path]);
  }

  add(repo: string, name: string, opts: { link?: string } = {}): Promise<Record<string, never>> {
    const args = ['add', name];
    if (opts.link) args.push('--link', opts.link);
    return this.run(args, { repo });
  }

  /**
   * `vaire pull [SPEC] [--registry] [--dry-run] [--locked]` — fetch a release into the store
   * (registry.md §5). `opts.locked` is `--locked` ("Reproduce knowledge.lock exactly...
   * Takes no package name" per `vaire pull --help`); callers must not combine it with `name`.
   * Return type is the loose, undocumented `PullResult` (see its doc comment) — `src/updates/
   * pure.ts`'s `parsePullDryRun` is what actually makes sense of it.
   */
  pull(
    repo: string,
    name?: string,
    opts: { registry?: string; dryRun?: boolean; locked?: boolean } = {},
  ): Promise<PullResult> {
    const args = ['pull'];
    if (name) args.push(name);
    if (opts.registry) args.push('--registry', opts.registry);
    if (opts.dryRun) args.push('--dry-run');
    if (opts.locked) args.push('--locked');
    return this.run(args, { repo });
  }

  /** `vaire pin <name>@<version>` — hold a dependency at one exact version (registry.md §6.3);
   *  `version` is the currently resolved one (`DepRow.version` / a `deps` row), per `vaire pin
   *  --help`'s "the version must already be in the store". */
  pin(repo: string, name: string, version: string): Promise<Record<string, never>> {
    return this.run(['pin', `${name}@${version}`], { repo });
  }

  /** `vaire unpin <name>` — release a hold so resolution picks the highest satisfying version again. */
  unpin(repo: string, name: string): Promise<Record<string, never>> {
    return this.run(['unpin', name], { repo });
  }

  /**
   * `vaire clean [PACKAGE] [--dry-run]` — sweep store entries nothing needs (registry.md §8).
   * `opts.package` is the optional positional: "stop holding this package, then sweep" (a
   * named pull's standing request), distinct from `repo`, which is the corpus context every
   * other wrapper also passes. Return type is the loose, undocumented `CleanResult` — see
   * `src/updates/pure.ts`'s `parseCleanDryRun`.
   */
  clean(repo: string, opts: { package?: string; dryRun?: boolean } = {}): Promise<CleanResult> {
    const args = ['clean'];
    if (opts.package) args.push(opts.package);
    if (opts.dryRun) args.push('--dry-run');
    return this.run(args, { repo });
  }

  /** `vaire release --dry-run [--major]` — classify and report; writes nothing (registry.md §3.1). */
  releaseDryRun(repo: string, opts: { major?: boolean } = {}): Promise<ReleasePlan> {
    const args = ['release', '--dry-run'];
    if (opts.major) args.push('--major');
    return this.run(args, { repo });
  }

  /**
   * `vaire release --summary <file> [--major]` — commits and tags. Never pushes. `status:
   * "blocked"` (exit 7, an outcome not an error — see `execOnce`) means the classifier saw a
   * MAJOR that `--major` did not acknowledge (or a MAJOR still missing its `--notes`); it is
   * returned like any other successful call, not thrown.
   */
  release(repo: string, opts: { summaryFile: string; major?: boolean }): Promise<ReleasePlan> {
    const args = ['release', '--summary', opts.summaryFile];
    if (opts.major) args.push('--major');
    return this.run(args, { repo });
  }

  /** `vaire pack` — builds `.vaire/dist/<name>-<version>.tgz` from the committed tree. */
  pack(repo: string): Promise<PackResult> {
    return this.run(['pack'], { repo });
  }

  /** `vaire push --registry <name>` — uploads release tags the registry lacks. */
  push(repo: string, opts: { registry?: string } = {}): Promise<Record<string, unknown>> {
    const args = ['push'];
    if (opts.registry) args.push('--registry', opts.registry);
    return this.run(args, { repo });
  }

  catalogList(): Promise<CatalogList> {
    return this.run(['catalog', 'list']);
  }

  catalogAdd(path: string): Promise<Record<string, never>> {
    return this.run(['catalog', 'add', path]);
  }

  catalogRm(nameOrPath: string): Promise<Record<string, never>> {
    return this.run(['catalog', 'rm', nameOrPath]);
  }

  catalogScan(dir: string): Promise<Record<string, never>> {
    return this.run(['catalog', 'scan', dir]);
  }

  registryList(): Promise<RegistryList> {
    return this.run(['registry', 'list']);
  }

  registryShow(name: string): Promise<RegistryShow> {
    return this.run(['registry', 'show', name]);
  }

  registryAdd(name: string, url: string): Promise<Record<string, never>> {
    return this.run(['registry', 'add', name, url]);
  }

  registryRm(name: string): Promise<Record<string, never>> {
    return this.run(['registry', 'rm', name]);
  }
}
