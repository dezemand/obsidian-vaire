// One persistent `vaire mcp --repo <root>` child process, speaking MCP JSON-RPC 2.0 over
// stdio. Desktop-only (child_process), but — like cli.ts — does not import `obsidian`, so it
// stays unit-testable with a fake spawn function. See DESIGN.md "CLI adapter" and this branch's
// `perf/mcp-transport` entry in BRANCHES.md for the trade-off this exists to compare.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { VaireError } from '../cli';
import { LineBuffer, parseToolResult, type McpToolResult } from './pure';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'vaire-obsidian', version: '0.1.0' };

/** Matches `child_process.spawn`'s shape closely enough to fake in tests, without pulling the
 *  whole node typings surface into the constructor signature. */
export type SpawnFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface McpClientOptions {
  binary: string;
  /** Absolute package root — passed as `vaire mcp --repo <repo>` and used as the child's cwd. */
  repo: string;
  env: NodeJS.ProcessEnv;
  /** Per-request timeout; a request that outlives this rejects (the client itself stays up —
   *  only that one call fails). Default 15s per the design brief. */
  requestTimeoutMs?: number;
  spawn?: SpawnFn;
  /** Called once, when the child exits or errors for any reason (crash, killed, spawn
   *  failure). Every pending request has already been rejected by the time this fires. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultSpawn: SpawnFn = (file, args, opts) =>
  nodeSpawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * Wraps one `vaire mcp` child: line-buffered JSON-RPC framing, a pending-request map keyed by
 * request id, the `initialize` handshake, and `callTool`. A crashed/exited child rejects every
 * pending request and marks itself dead (`isDead`); it never restarts itself — that's
 * `McpClientPool`'s job (src/mcp/pool.ts), since restart-budget and fallback-to-spawn policy
 * belongs at the per-package-root pool level, not the single-process level.
 */
export class McpClient {
  private readonly opts: McpClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly buffer = new LineBuffer();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private dead = false;

  constructor(opts: McpClientOptions) {
    this.opts = opts;
  }

  get repo(): string {
    return this.opts.repo;
  }

  /** True once the child has exited/errored/been closed. A dead client must be discarded —
   *  callers get a fresh `McpClient` rather than trying to resurrect this one. */
  get isDead(): boolean {
    return this.dead;
  }

  /** Starts the child and completes the `initialize` handshake, idempotently — concurrent
   *  callers before the first call share one startup. */
  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const spawnFn = this.opts.spawn ?? defaultSpawn;
    const child = spawnFn(this.opts.binary, ['mcp', '--repo', this.opts.repo, '-q', '--no-color'], {
      cwd: this.opts.repo,
      env: this.opts.env,
    });
    this.child = child;
    this.dead = false;

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    // `vaire` may print progress/log lines on stderr even with `-q` (cli.ts's convention for
    // the spawn transport is to ignore stderr on success) — nothing here depends on it.
    child.stderr.on('data', () => {});
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (err) => this.handleExit(null, null, err));

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.notify('notifications/initialized', {});
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new VaireError('MCP client not started', 1, 'mcp_closed'));
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VaireError(`MCP request '${method}' timed out after ${timeoutMs}ms`, 1, 'mcp_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child?.stdin.write(payload);
    });
  }

  private onStdout(chunk: Buffer): void {
    for (const line of this.buffer.push(chunk.toString('utf8'))) {
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } } | null = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC message — ignore rather than crash the client over stray output
    }
    if (msg == null || typeof msg !== 'object' || msg.id == null) return; // a notification from the server; nothing to correlate
    const pending = this.pending.get(msg.id);
    if (!pending) return; // late/duplicate response, or a ping we didn't send — ignore
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new VaireError(msg.error.message ?? 'MCP protocol error', 1, 'mcp_protocol'));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (this.dead) return; // already handled (e.g. explicit close())
    this.dead = true;
    const reason = err ? err.message : `vaire mcp exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VaireError(reason, 1, 'mcp_crashed'));
    }
    this.pending.clear();
    this.child = null;
    this.opts.onExit?.({ code, signal });
  }

  /** Starts the client if needed, calls the named tool, and returns the parsed result (or
   *  throws a `VaireError` — either a tool-level error envelope, or a transport failure). */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    const result = await this.request<McpToolResult>('tools/call', { name, arguments: args });
    return parseToolResult<T>(result);
  }

  /** Kills the child (if any) and rejects everything still pending. Idempotent. */
  close(): void {
    if (this.dead && !this.child) return;
    this.dead = true;
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VaireError('MCP client closed', 1, 'mcp_closed'));
    }
    this.pending.clear();
  }
}
