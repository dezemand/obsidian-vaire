import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { VaireError } from '../src/cli';
import { McpClient, type SpawnFn } from '../src/mcp/client';
import {
  LatencyTracker,
  LineBuffer,
  needsSpawnFallback,
  parseToolResult,
  percentile,
  toolArgs,
} from '../src/mcp/pure';
import { McpClientPool } from '../src/mcp/pool';

// ---- LineBuffer -----------------------------------------------------------------------

describe('LineBuffer', () => {
  test('yields nothing until a newline arrives', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}')).toEqual([]);
    expect(buf.pending()).toBe('{"a":1}');
  });

  test('yields one line once terminated', () => {
    const buf = new LineBuffer();
    buf.push('{"a":1}');
    expect(buf.push('\n')).toEqual(['{"a":1}']);
    expect(buf.pending()).toBe('');
  });

  test('yields multiple lines delivered in one chunk', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('carries a partial line across chunks', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push('1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('a blank line is still yielded (framing artifact, not an error)', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n\n{"b":2}\n')).toEqual(['{"a":1}', '', '{"b":2}']);
  });

  test('an unterminated tail at end of stream stays pending, never yielded', () => {
    const buf = new LineBuffer();
    buf.push('{"a":1}\n{"trailing":true}');
    expect(buf.pending()).toBe('{"trailing":true}');
  });
});

// ---- toolArgs / needsSpawnFallback -----------------------------------------------------

describe('toolArgs', () => {
  test('resolve and render carry only id', () => {
    expect(toolArgs('resolve', { id: 'concept:reference' })).toEqual({ id: 'concept:reference' });
    expect(toolArgs('render', { id: 'concept:reference' })).toEqual({ id: 'concept:reference' });
  });

  test('backlinks omits unset type/limit', () => {
    expect(toolArgs('backlinks', { id: 'concept:reference' })).toEqual({ id: 'concept:reference' });
    expect(toolArgs('backlinks', { id: 'concept:reference', type: 'decision', limit: 5 })).toEqual({
      id: 'concept:reference',
      type: 'decision',
      limit: 5,
    });
  });

  test('refs maps depth and type', () => {
    expect(toolArgs('refs', { id: 'concept:reference', depth: 2 })).toEqual({ id: 'concept:reference', depth: 2 });
    expect(toolArgs('refs', { id: 'concept:reference' })).toEqual({ id: 'concept:reference' });
  });

  test('search drops `all` — the MCP tool schema has no catalog-wide flag', () => {
    expect(
      toolArgs('search', { query: 'reference graph', type: 'concept', limit: 5, local: true, all: true, scope: 'cli:vaire' }),
    ).toEqual({ query: 'reference graph', type: 'concept', limit: 5, local: true, scope: 'cli:vaire' });
  });

  test('suggest drops `all` the same way', () => {
    expect(toolArgs('suggest', { descriptor: 'loose end', all: true, local: true })).toEqual({
      descriptor: 'loose end',
      local: true,
    });
  });

  test('unresolved maps allPackages -> all_packages (snake_case)', () => {
    expect(toolArgs('unresolved', { allPackages: true })).toEqual({ all_packages: true });
    expect(toolArgs('unresolved', {})).toEqual({});
    expect(toolArgs('unresolved', { type: 'document', scope: 'project:atlas' })).toEqual({
      type: 'document',
      scope: 'project:atlas',
    });
  });

  test('deps takes no arguments', () => {
    expect(toolArgs('deps', {})).toEqual({});
  });
});

describe('needsSpawnFallback', () => {
  test('true only for search/suggest with all:true', () => {
    expect(needsSpawnFallback('search', { query: 'q', all: true })).toBe(true);
    expect(needsSpawnFallback('suggest', { descriptor: 'd', all: true })).toBe(true);
    expect(needsSpawnFallback('search', { query: 'q' })).toBe(false);
    expect(needsSpawnFallback('search', { query: 'q', all: false })).toBe(false);
    expect(needsSpawnFallback('resolve', { id: 'x:y' })).toBe(false);
    expect(needsSpawnFallback('deps', {})).toBe(false);
  });
});

// ---- parseToolResult --------------------------------------------------------------------

describe('parseToolResult', () => {
  test('parses the JSON text content of a successful result', () => {
    const result = parseToolResult<{ id: string }>({
      content: [{ type: 'text', text: '{"id":"concept:reference"}' }],
      isError: false,
    });
    expect(result).toEqual({ id: 'concept:reference' });
  });

  test('throws a VaireError built from the embedded error envelope when isError', () => {
    const errorText = JSON.stringify({ error: { code: 5, kind: 'id_not_found', message: "no node with id 'x:y'" } });
    expect(() => parseToolResult({ content: [{ type: 'text', text: errorText }], isError: true })).toThrow(VaireError);
    try {
      parseToolResult({ content: [{ type: 'text', text: errorText }], isError: true });
      throw new Error('expected parseToolResult to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaireError);
      expect((err as VaireError).code).toBe(5);
      expect((err as VaireError).kind).toBe('id_not_found');
      expect((err as VaireError).message).toContain("x:y");
    }
  });

  test('isError with non-envelope text still throws, with the raw text as the message', () => {
    try {
      parseToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true });
      throw new Error('expected parseToolResult to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaireError);
      expect((err as VaireError).message).toBe('boom');
    }
  });

  test('missing content is tolerated (empty object)', () => {
    expect(parseToolResult<Record<string, never>>({})).toEqual({});
  });
});

// ---- percentile / LatencyTracker ---------------------------------------------------------

describe('percentile', () => {
  test('empty input is 0', () => {
    expect(percentile([], 50)).toBe(0);
  });

  test('single value', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  test('p50 of an evenly spaced set', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  test('p95 is near the top of the set', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 95)).toBeCloseTo(95.05, 1);
  });

  test('unsorted input is sorted before computing', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  });
});

describe('LatencyTracker', () => {
  test('empty tracker reports null percentiles', () => {
    const t = new LatencyTracker();
    expect(t.snapshot()).toEqual({ count: 0, p50: null, p95: null });
  });

  test('reports count and percentiles after recording', () => {
    const t = new LatencyTracker();
    for (const ms of [10, 20, 30, 40, 50]) t.record(ms);
    const snap = t.snapshot();
    expect(snap.count).toBe(5);
    expect(snap.p50).toBe(30);
  });

  test('keeps only the last `maxSamples` recordings (ring buffer)', () => {
    const t = new LatencyTracker(3);
    t.record(1);
    t.record(2);
    t.record(3);
    t.record(100); // evicts the 1
    const snap = t.snapshot();
    expect(snap.count).toBe(3);
    expect(snap.p50).toBe(3); // sorted [2,3,100] -> median 3
  });
});

// ---- McpClient (fake spawn — a tiny in-process JSON-RPC "server") -----------------------

/** A fake `SpawnFn` standing in for `child_process.spawn`: a minimal stdio-shaped
 *  EventEmitter pair the test drives directly, with a `respond` hook installed on the
 *  returned object so each test can script the fake server's replies. */
function fakeChildProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: (_data: string) => true };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => {} });
  proc.kill = () => proc.emit('exit', null, 'SIGTERM');
  return proc;
}

function makeSpawn(handle: (proc: ReturnType<typeof fakeChildProcess>, msg: any) => void): {
  spawn: SpawnFn;
  proc: ReturnType<typeof fakeChildProcess>;
  writes: string[];
} {
  const proc = fakeChildProcess();
  const writes: string[] = [];
  proc.stdin.write = (data: string) => {
    writes.push(data);
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      handle(proc, JSON.parse(line));
    }
    return true;
  };
  const spawn: SpawnFn = () => proc as unknown as ReturnType<SpawnFn>;
  return { spawn, proc, writes };
}

function emitLine(proc: ReturnType<typeof fakeChildProcess>, obj: unknown): void {
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
}

describe('McpClient', () => {
  test('performs the initialize handshake then sends notifications/initialized', async () => {
    const { spawn, proc, writes } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      }
    });
    // tools/call is deliberately never answered by the fake handler above; a short timeout
    // keeps the test itself fast while still exercising the handshake that happens first.
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn, requestTimeoutMs: 10 });
    await client.callTool('deps', {}).catch(() => {});
    expect(writes.some((w) => w.includes('"method":"initialize"'))).toBe(true);
    expect(writes.some((w) => w.includes('"method":"notifications/initialized"'))).toBe(true);
  });

  test('callTool resolves with the parsed tool result', async () => {
    const { spawn } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      } else if (msg.method === 'tools/call') {
        emitLine(p, {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: '{"id":"concept:reference","type":"concept"}' }], isError: false },
        });
      }
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn });
    const result = await client.callTool<{ id: string; type: string }>('resolve', { id: 'concept:reference' });
    expect(result).toEqual({ id: 'concept:reference', type: 'concept' });
  });

  test('callTool throws the VaireError built from an isError result', async () => {
    const { spawn } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      } else if (msg.method === 'tools/call') {
        emitLine(p, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: { code: 5, kind: 'id_not_found', message: 'nope' } }) }],
            isError: true,
          },
        });
      }
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn });
    await expect(client.callTool('resolve', { id: 'x:nope' })).rejects.toMatchObject({ code: 5, kind: 'id_not_found' });
  });

  test('a JSON-RPC protocol error (malformed call) rejects with its message', async () => {
    const { spawn } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      } else if (msg.method === 'tools/call') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: "missing required argument 'id'" } });
      }
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn });
    await expect(client.callTool('resolve', {})).rejects.toThrow(/missing required argument/);
  });

  test('exit rejects every pending request and marks the client dead', async () => {
    const { spawn, proc } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      }
      // tools/call is never answered — simulates a crash mid-request.
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn });
    const pending = client.callTool('resolve', { id: 'x:y' });
    // let the handshake resolve first
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 1, null);
    await expect(pending).rejects.toBeInstanceOf(VaireError);
    expect(client.isDead).toBe(true);
  });

  test('a request that times out rejects without killing the client', async () => {
    const { spawn } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      }
      // tools/call is never answered.
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn, requestTimeoutMs: 10 });
    await expect(client.callTool('resolve', { id: 'x:y' })).rejects.toThrow(/timed out/);
    expect(client.isDead).toBe(false);
  });

  test('close() rejects pending requests and marks dead', async () => {
    const { spawn } = makeSpawn((p, msg) => {
      if (msg.method === 'initialize') {
        emitLine(p, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } });
      }
    });
    const client = new McpClient({ binary: 'vaire', repo: '/repo', env: {}, spawn });
    const pending = client.callTool('resolve', { id: 'x:y' });
    await new Promise((r) => setTimeout(r, 0));
    client.close();
    await expect(pending).rejects.toBeInstanceOf(VaireError);
    expect(client.isDead).toBe(true);
  });
});

// ---- McpClientPool ------------------------------------------------------------------------

describe('McpClientPool', () => {
  function fakeClient(overrides: Partial<{ isDead: boolean }> = {}) {
    return {
      isDead: overrides.isDead ?? false,
      repo: '/repo',
      callTool: async () => ({}),
      close: () => {},
    } as unknown as import('../src/mcp/client').McpClient;
  }

  test('creates one client per absRoot and reuses it', () => {
    const created: string[] = [];
    const pool = new McpClientPool({
      binary: () => 'vaire',
      env: () => ({}),
      createClient: (opts) => {
        created.push(opts.repo);
        return fakeClient();
      },
    });
    const a1 = pool.get('/repo-a');
    const a2 = pool.get('/repo-a');
    const b1 = pool.get('/repo-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(created).toEqual(['/repo-a', '/repo-b']);
  });

  test('restarts a dead client on the next get()', () => {
    let deadFlag = false;
    let createCount = 0;
    const pool = new McpClientPool({
      binary: () => 'vaire',
      env: () => ({}),
      createClient: () => {
        createCount++;
        return new Proxy(fakeClient(), {
          get(target, prop) {
            if (prop === 'isDead') return deadFlag;
            return (target as any)[prop];
          },
        });
      },
    });
    const first = pool.get('/repo');
    expect(createCount).toBe(1);
    deadFlag = true;
    const second = pool.get('/repo');
    expect(createCount).toBe(2);
    expect(second).not.toBe(first);
  });

  test('falls back to spawn (returns null) after exceeding the restart budget', () => {
    let deadFlag = true; // every freshly created client is immediately "dead" in this test
    let fallbackReason: string | null = null;
    const pool = new McpClientPool({
      binary: () => 'vaire',
      env: () => ({}),
      onFallback: (_absRoot, reason) => {
        fallbackReason = reason;
      },
      createClient: () =>
        new Proxy(fakeClient(), {
          get(target, prop) {
            if (prop === 'isDead') return deadFlag;
            return (target as any)[prop];
          },
        }),
    });
    // First get() creates a fresh (not-yet-dead-checked) client.
    expect(pool.get('/repo')).not.toBeNull();
    // Each subsequent get() finds the previous client dead and restarts, up to the budget.
    expect(pool.get('/repo')).not.toBeNull(); // restart 1
    expect(pool.get('/repo')).not.toBeNull(); // restart 2
    expect(pool.get('/repo')).not.toBeNull(); // restart 3 (budget: 3/min)
    expect(pool.get('/repo')).toBeNull(); // budget exceeded -> permanent fallback
    expect(fallbackReason ?? '').toContain('crashed');
    // Once fallen back, every further get() for this root stays null without creating clients.
    expect(pool.get('/repo')).toBeNull();
    void deadFlag;
  });

  test('restart() drops the client so the next get() creates a fresh one', () => {
    let createCount = 0;
    const pool = new McpClientPool({
      binary: () => 'vaire',
      env: () => ({}),
      createClient: () => {
        createCount++;
        return fakeClient();
      },
    });
    pool.get('/repo');
    expect(createCount).toBe(1);
    pool.restart('/repo');
    pool.get('/repo');
    expect(createCount).toBe(2);
  });

  test('closeAll() closes every pooled client and forgets them', () => {
    const closed: string[] = [];
    const pool = new McpClientPool({
      binary: () => 'vaire',
      env: () => ({}),
      createClient: (opts) => ({ ...fakeClient(), close: () => closed.push(opts.repo) }) as unknown as import('../src/mcp/client').McpClient,
    });
    pool.get('/repo-a');
    pool.get('/repo-b');
    pool.closeAll();
    expect(closed.sort()).toEqual(['/repo-a', '/repo-b']);
  });
});
