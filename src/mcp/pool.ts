// One `McpClient` per absolute package root, lazily started. See DESIGN.md "CLI adapter" and
// this branch's `perf/mcp-transport` entry in BRANCHES.md.
//
// Restart-on-`index-rebuilt` note: the MCP server operates against the already-built index
// file and never writes it (per the `vaire-query-mcp` skill) — the open question was whether a
// long-lived server process re-opens/re-reads that file on every call, or only once at
// startup. The experiment this branch was built from (see the scratchpad transcript) only
// confirmed that repeated calls against an *unchanged* index behave correctly; it did not
// exercise a rebuild happening underneath a live server, because the shared fixture repo
// (`packages/vaire`) is used read-only by several other branches' integration tests and
// running `vaire index` against it would leave that shared checkout dirty. Per the design
// brief's guidance for this uncertain case, we take the conservative, cheap option: restart
// (not reuse) the pooled client for a package root whenever that root's index is rebuilt
// (`index-rebuilt`), so a stale in-process read is never possible. The cost is one extra
// process spawn + handshake on the next read after a rebuild — negligible next to a rebuild
// itself.

import type { McpClient, McpClientOptions } from './client';
import { McpClient as RealMcpClient } from './client';

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_RESTARTS_PER_MINUTE = 3;
const RESTART_WINDOW_MS = 60 * 1000;

export type McpClientFactory = (opts: McpClientOptions) => McpClient;

export interface McpClientPoolOptions {
  binary: () => string;
  env: () => NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  idleShutdownMs?: number;
  /** Called once a package root has exceeded its restart budget and every subsequent `get()`
   *  for it will return `null` (permanent fallback to spawn) until the pool is reset for that
   *  root. Intended for a Notice — kept as a plain callback so this module stays free of
   *  `obsidian` imports (main.ts wires it to a real Notice). */
  onFallback?: (absRoot: string, reason: string) => void;
  /** Test seam — defaults to `new McpClient(opts)`. */
  createClient?: McpClientFactory;
}

interface Entry {
  client: McpClient;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamps (ms) of restarts within the trailing `RESTART_WINDOW_MS`. */
  restarts: number[];
  /** Once true, this root has given up on MCP for the session; `get()` returns `null`. */
  fellBack: boolean;
}

export class McpClientPool {
  private readonly opts: McpClientPoolOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: McpClientPoolOptions) {
    this.opts = opts;
  }

  private createClient(absRoot: string): McpClient {
    const factory = this.opts.createClient ?? ((o: McpClientOptions) => new RealMcpClient(o));
    return factory({
      binary: this.opts.binary(),
      repo: absRoot,
      env: this.opts.env(),
      requestTimeoutMs: this.opts.requestTimeoutMs,
      onExit: () => {
        // Nothing to do eagerly here: the client is already marked dead (`isDead`), and the
        // next `get()` call for this root notices that and decides restart-vs-fallback. We
        // don't proactively restart on exit because a client that's simply idle-closed (see
        // `close()` below) also fires `onExit`, and that's not a crash.
      },
    });
  }

  /** Returns a live client for `absRoot` (starting one if needed, restarting one that died),
   *  or `null` once that root has exceeded its restart budget for this session — the caller
   *  (VaireCli) falls back to spawn for that root when this returns `null`. */
  get(absRoot: string): McpClient | null {
    let entry = this.entries.get(absRoot);
    if (entry?.fellBack) return null;

    if (!entry) {
      entry = { client: this.createClient(absRoot), lastUsed: 0, idleTimer: null, restarts: [], fellBack: false };
      this.entries.set(absRoot, entry);
    } else if (entry.client.isDead) {
      const now = Date.now();
      entry.restarts = entry.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (entry.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
        entry.fellBack = true;
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        this.opts.onFallback?.(absRoot, `MCP server for this package crashed ${entry.restarts.length}+ times in the last minute`);
        return null;
      }
      entry.restarts.push(now);
      entry.client = this.createClient(absRoot);
    }

    entry.lastUsed = Date.now();
    this.armIdleTimer(absRoot, entry);
    return entry.client;
  }

  private armIdleTimer(absRoot: string, entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const idleMs = this.opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(absRoot);
      if (!current || current !== entry) return;
      current.client.close();
      this.entries.delete(absRoot);
    }, idleMs);
  }

  /** Closes and drops the client for one package root (its restart/fallback history goes with
   *  it), so the next `get()` starts fresh. Called after `index-rebuilt` for that root — see
   *  the module doc comment above for why. */
  restart(absRoot: string): void {
    const entry = this.entries.get(absRoot);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.client.close();
    this.entries.delete(absRoot);
  }

  /** Closes every pooled client. Called on plugin unload and whenever `cliTransport` switches
   *  away from `'mcp'` (a lingering child process would otherwise outlive the setting). */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.client.close();
    }
    this.entries.clear();
  }
}
