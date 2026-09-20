// Pure, unit-tested pieces of the MCP transport (perf/mcp-transport — see DESIGN.md "CLI
// adapter" and BRANCHES.md). No `obsidian` import, no I/O: everything here is data in, data
// out, so `tests/mcp.test.ts` can exercise it without a real `vaire mcp` process.

import { VaireError } from '../cli';

// ---- newline-delimited JSON framing ---------------------------------------------------

/**
 * Buffers arbitrary chunks of a child process's stdout and yields complete lines as they
 * become available. `vaire mcp` speaks plain newline-delimited JSON-RPC (one message per
 * `\n`-terminated line — verified against the 0.3.2 binary: no `Content-Length` framing), so
 * this is intentionally simpler than the LSP-style header framing some MCP transports use.
 */
export class LineBuffer {
  private carry = '';

  /** Feeds one chunk (already decoded to a string) and returns every complete line it
   *  produced, in order. A line with no content (two consecutive `\n`s) is still returned as
   *  `''` — callers skip blank lines themselves, since a blank line is a framing artifact, not
   *  a parse error. */
  push(chunk: string): string[] {
    this.carry += chunk;
    const parts = this.carry.split('\n');
    this.carry = parts.pop() ?? '';
    return parts;
  }

  /** Whatever has been fed but not yet terminated by a `\n`. Exposed for diagnostics/tests
   *  only — a well-behaved server always terminates its last line before exit. */
  pending(): string {
    return this.carry;
  }
}

// ---- tool-call argument mapping --------------------------------------------------------

/** The eight read commands the MCP server exposes as tools (`vaire-query-mcp` skill), mapped
 *  from the same option shapes `VaireCli`'s typed wrappers already take. */
export interface ToolArgsInput {
  resolve: { id: string };
  render: { id: string };
  backlinks: { id: string; type?: string; limit?: number };
  refs: { id: string; depth?: number; type?: string };
  search: { query: string; type?: string; limit?: number; all?: boolean; local?: boolean; scope?: string };
  suggest: { descriptor: string; type?: string; limit?: number; all?: boolean; local?: boolean };
  unresolved: { allPackages?: boolean; type?: string; scope?: string };
  deps: Record<string, never>;
}

export type McpCommand = keyof ToolArgsInput;

/**
 * Maps a `VaireCli` wrapper's options to the MCP tool's `arguments` object, verified against
 * `tools/list`'s `inputSchema` on the 0.3.2 binary (see the experiment transcript this branch
 * was built from). Argument names mostly match the CLI's long flags 1:1 (`--type` → `type`,
 * `--limit` → `limit`, `--depth` → `depth`, `--local` → `local`, `--scope` → `scope`), with two
 * differences:
 *
 * - `unresolved --all-packages` → `all_packages` (snake_case, unlike every other MCP argument
 *   name here, which is camelCase-free single words anyway — this is the one where the CLI
 *   flag's dash would have mattered).
 * - `search`/`suggest --all` (search/suggest across every catalog package, not just this
 *   package and its linked dependencies) has **no MCP equivalent** — the tool schema simply
 *   doesn't expose it. Passing `all` in the arguments object is silently ignored by the server
 *   (extra properties don't error), so this function drops it rather than send a no-op; callers
 *   that need `all: true` semantics must use `needsSpawnFallback` to route that call through
 *   spawn instead, where `--all` really is honored.
 */
export function toolArgs<C extends McpCommand>(command: C, opts: ToolArgsInput[C]): Record<string, unknown> {
  switch (command) {
    case 'resolve':
    case 'render': {
      const o = opts as ToolArgsInput['resolve'];
      return { id: o.id };
    }
    case 'backlinks': {
      const o = opts as ToolArgsInput['backlinks'];
      const args: Record<string, unknown> = { id: o.id };
      if (o.type) args.type = o.type;
      if (o.limit != null) args.limit = o.limit;
      return args;
    }
    case 'refs': {
      const o = opts as ToolArgsInput['refs'];
      const args: Record<string, unknown> = { id: o.id };
      if (o.depth != null) args.depth = o.depth;
      if (o.type) args.type = o.type;
      return args;
    }
    case 'search': {
      const o = opts as ToolArgsInput['search'];
      const args: Record<string, unknown> = { query: o.query };
      if (o.type) args.type = o.type;
      if (o.limit != null) args.limit = o.limit;
      if (o.local) args.local = true;
      if (o.scope) args.scope = o.scope;
      return args;
    }
    case 'suggest': {
      const o = opts as ToolArgsInput['suggest'];
      const args: Record<string, unknown> = { descriptor: o.descriptor };
      if (o.type) args.type = o.type;
      if (o.limit != null) args.limit = o.limit;
      if (o.local) args.local = true;
      return args;
    }
    case 'unresolved': {
      const o = opts as ToolArgsInput['unresolved'];
      const args: Record<string, unknown> = {};
      if (o.allPackages) args.all_packages = true;
      if (o.type) args.type = o.type;
      if (o.scope) args.scope = o.scope;
      return args;
    }
    case 'deps':
      return {};
    default: {
      const exhaustive: never = command;
      throw new Error(`unknown MCP command: ${String(exhaustive)}`);
    }
  }
}

/** True when `opts` asks for something the MCP tool for `command` cannot express (today: only
 *  `search`/`suggest`'s catalog-wide `all`), meaning the call must go through spawn instead of
 *  the MCP pool. Checked by `VaireCli` before it ever touches the pool. */
export function needsSpawnFallback<C extends McpCommand>(command: C, opts: ToolArgsInput[C]): boolean {
  if (command === 'search' || command === 'suggest') {
    return (opts as { all?: boolean }).all === true;
  }
  return false;
}

// ---- tool-result parsing ----------------------------------------------------------------

export interface McpToolResultContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpToolResultContent[];
  isError?: boolean;
}

/**
 * Parses a `tools/call` result. The text content is the command's JSON output, verbatim (same
 * shapes as `src/types.ts`, per the `vaire-query-mcp` skill). `isError: true` means the text is
 * instead the `{"error":{code,kind,message}}` envelope `cli.ts`'s spawn path already knows how
 * to throw — reuse `VaireError` so callers can't tell which transport produced it.
 */
export function parseToolResult<T>(result: McpToolResult): T {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  if (result.isError) {
    const envelope = parsed as { error?: { code: number; kind: string; message: string } };
    if (envelope && envelope.error && typeof envelope.error.code === 'number' && typeof envelope.error.kind === 'string') {
      throw new VaireError(envelope.error.message, envelope.error.code, envelope.error.kind);
    }
    throw new VaireError(text || 'MCP tool call failed', 1, 'mcp_error');
  }
  return parsed as T;
}

// ---- latency tracking (status bar tooltip) -----------------------------------------------

/** Linear-interpolation percentile over `values` (0-100). Empty input returns 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export interface LatencySnapshot {
  count: number;
  p50: number | null;
  p95: number | null;
}

/** Ring buffer of the last `maxSamples` call durations (ms) for one transport, so the status
 *  bar tooltip can show spawn-vs-MCP p50/p95 side by side. */
export class LatencyTracker {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 50) {
    this.maxSamples = maxSamples;
  }

  record(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  snapshot(): LatencySnapshot {
    if (this.samples.length === 0) return { count: 0, p50: null, p95: null };
    return { count: this.samples.length, p50: percentile(this.samples, 50), p95: percentile(this.samples, 95) };
  }
}
