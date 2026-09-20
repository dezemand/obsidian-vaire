// Runs a real `vaire mcp --repo <root>` server, read-only, against a real Vairë package —
// the MCP counterpart of tests/cli.integration.test.ts. Skipped entirely when the binary isn't
// on PATH (or the usual fallback locations), same as that suite, or when VAIRE_TEST_REPO isn't
// set (see README.md "Running the tests").
//
// Also measures both transports over 20 calls each (against the same `resolve` call, so the
// comparison isn't skewed by different commands doing different amounts of work) and prints
// the p50s — not an assertion (machine load varies too much to gate CI on it), just a visible
// number for BRANCHES.md-style comparison. Closes the MCP client when done so the test process
// can exit cleanly.

import { expect, test } from 'bun:test';
import { VaireCli, childEnv } from '../src/cli';
import { McpClient } from '../src/mcp/client';
import { percentile } from '../src/mcp/pure';

const REPO = process.env.VAIRE_TEST_REPO;

const spawnCli = new VaireCli(() => ({ binaryPath: '' }));
const available = !!REPO && (await spawnCli.available());

test.skipIf(!available)('MCP resolve/suggest/search match the spawn transport shapes', async () => {
  const client = new McpClient({ binary: spawnCli.binary(), repo: REPO!, env: childEnv() });
  try {
    const resolved = await client.callTool<{ id: string; type: string; path: string; frontmatter: unknown }>('resolve', {
      id: 'concept:reference',
    });
    expect(resolved.id).toBe('concept:reference');
    expect(resolved.type).toBe('concept');
    expect(typeof resolved.path).toBe('string');
    expect(resolved.frontmatter).toBeTruthy();

    const suggested = await client.callTool<{ descriptor: string; suggestions: Array<{ id: string; type: string; name: string; score: number }>; count: number }>(
      'suggest',
      { descriptor: 'loose end' },
    );
    expect(suggested.descriptor).toBe('loose end');
    expect(suggested.suggestions.length).toBeGreaterThan(0);
    for (const s of suggested.suggestions) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.type).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.score).toBe('number');
    }

    const searched = await client.callTool<{ query: string; results: Array<{ id: string; type: string; score: number; anchors: unknown[] }> }>(
      'search',
      { query: 'reference graph' },
    );
    expect(searched.query).toBe('reference graph');
    expect(searched.results.length).toBeGreaterThan(0);
    for (const hit of searched.results) {
      expect(typeof hit.id).toBe('string');
      expect(typeof hit.type).toBe('string');
      expect(typeof hit.score).toBe('number');
      expect(Array.isArray(hit.anchors)).toBe(true);
    }

    // Cross-check against the spawn transport's shape for the same node (same JSON, per the
    // vaire-query-mcp skill: "results are the CLI --json shapes verbatim").
    const spawnResolved = await spawnCli.resolve(REPO!, 'concept:reference');
    expect(resolved.id).toBe(spawnResolved.id);
    expect(resolved.type).toBe(spawnResolved.type);
    expect(resolved.path).toBe(spawnResolved.path);
  } finally {
    client.close();
  }
});

test.skipIf(!available)('MCP tool error envelope matches the spawn transport error shape', async () => {
  const client = new McpClient({ binary: spawnCli.binary(), repo: REPO!, env: childEnv() });
  try {
    await expect(client.callTool('resolve', { id: 'concept:definitely-not-a-real-node' })).rejects.toMatchObject({
      code: 5,
      kind: 'id_not_found',
    });
  } finally {
    client.close();
  }
});

test.skipIf(!available)(
  'transport latency: spawn vs MCP over 20 resolve calls each',
  async () => {
    const client = new McpClient({ binary: spawnCli.binary(), repo: REPO!, env: childEnv() });
    try {
      // Warm up the MCP handshake before timing so it's an apples-to-apples per-call cost.
      await client.callTool('resolve', { id: 'concept:reference' });

      const N = 20;
      const spawnDurations: number[] = [];
      for (let i = 0; i < N; i++) {
        const started = Date.now();
        await spawnCli.resolve(REPO!, 'concept:reference');
        spawnDurations.push(Date.now() - started);
      }

      const mcpDurations: number[] = [];
      for (let i = 0; i < N; i++) {
        const started = Date.now();
        await client.callTool('resolve', { id: 'concept:reference' });
        mcpDurations.push(Date.now() - started);
      }

      const spawnP50 = percentile(spawnDurations, 50);
      const mcpP50 = percentile(mcpDurations, 50);
      // eslint-disable-next-line no-console
      console.log(
        `[mcp.integration] resolve x${N} — spawn p50 ${spawnP50.toFixed(1)}ms, MCP p50 ${mcpP50.toFixed(1)}ms ` +
          `(spawn samples: ${spawnDurations.map((d) => d.toFixed(0)).join(',')}; MCP samples: ${mcpDurations.map((d) => d.toFixed(0)).join(',')})`,
      );

      expect(spawnDurations.length).toBe(N);
      expect(mcpDurations.length).toBe(N);
    } finally {
      client.close();
    }
  },
  30_000,
);
