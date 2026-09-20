// CLI activity counter, in the status bar. A comparison aid for several variants at once:
// `perf/refs-prefetch` (how many `vaire` processes are spawned, post-dedupe, live),
// `perf/mcp-transport` (spawn vs MCP call counts, already keyed `mcp:<tool>` in
// `stats().byCommand`, plus p50/p95 latency per transport), and `perf/disk-cache` (on-disk cache
// hits, misses and revalidations, so a warm start can be compared with a cold one). See
// DESIGN.md "CLI adapter" and BRANCHES.md "Comparing variants on `main`".

import type { CliLatencyStats, CliStats } from './cli';
import type { CacheStats } from './cache/store';
import type { LatencySnapshot } from './mcp/pure';
import type VairePlugin from './main';

const POLL_MS = 300;

export function registerStatusBar(plugin: VairePlugin): void {
  const item = plugin.addStatusBarItem();
  item.addClass('vaire-cli-status');

  const render = (): void => {
    const stats = plugin.cli.stats();
    const transportBadge = plugin.settings.cliTransport === 'mcp' ? ' (mcp)' : '';
    item.setText(
      stats.inFlight > 0
        ? `vaire ⟳ ${stats.inFlight}${transportBadge}`
        : `vaire · ${stats.total} call${stats.total === 1 ? '' : 's'}${transportBadge}`,
    );
    const tooltip = tooltipFor(stats, plugin.cli.latencyStats(), plugin.cache.stats(), plugin.settings.persistentCache);
    item.setAttribute('aria-label', tooltip);
    item.setAttribute('title', tooltip);
  };

  render();
  plugin.registerInterval(window.setInterval(render, POLL_MS));

  plugin.addCommand({
    id: 'vaire-reset-cli-stats',
    name: 'Reset CLI call counter',
    callback: () => {
      plugin.cli.resetStats();
      render();
    },
  });
}

function formatLatency(label: string, snapshot: LatencySnapshot): string {
  if (snapshot.count === 0) return `${label}: no calls yet`;
  return `${label}: p50 ${Math.round(snapshot.p50 ?? 0)}ms · p95 ${Math.round(snapshot.p95 ?? 0)}ms (n=${snapshot.count})`;
}

function tooltipFor(stats: CliStats, latency: CliLatencyStats, cache: CacheStats, cacheMode: string): string {
  const lines: string[] = [];
  if (!stats.byCommand.length) {
    lines.push('vaire: no CLI calls yet');
  } else {
    lines.push('vaire CLI calls (since last reset):');
    lines.push(...stats.byCommand.map((c) => `  ${c.command}: ${c.count}`));
  }
  lines.push('', 'Latency (last 50 calls):');
  lines.push(`  ${formatLatency('spawn', latency.spawn)}`);
  lines.push(`  ${formatLatency('mcp', latency.mcp)}`);
  lines.push(
    '',
    cacheMode === 'off'
      ? 'Persistent cache: off'
      : `Persistent cache (${cacheMode}): ${cache.hits} hit${cache.hits === 1 ? '' : 's'}, ` +
          `${cache.misses} miss${cache.misses === 1 ? '' : 'es'}, ${cache.revalidations} revalidated, ` +
          `${cache.entries} entries on disk`,
  );
  return lines.join('\n');
}
