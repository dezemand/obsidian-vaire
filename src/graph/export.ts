// Impure orchestration for "Export local graph to canvas": builds the same graph the local
// graph view shows for the active node (see DESIGN.md's "Export local graph to canvas" feature
// brief), lays it out with `ForceLayout` run to convergence, and writes a JSON Canvas 1.0
// (`.canvas`) file into `settings.canvasFolder`. Kept separate from graph-view.ts and index.ts
// (which both import it) purely to avoid a circular import between the two — the view has a "To
// canvas" toolbar button, the command is `vaire-export-canvas`.

import { normalizePath, Notice, TFile } from 'obsidian';
import { parseRef } from '../ids';
import type VairePlugin from '../main';
import type { PackageInfo } from '../packages';
import { confirm } from '../ui/prompt-modal';
import { canvasFileName, graphToCanvas, scalePositions, type Position } from './canvas';
import { ForceLayout } from './layout';
import { buildGraph, type GraphModel } from './model';
import { hashSeed } from './pure';

/** Full convergence budget — matches the interactive graph view's tick cap (graph-view.ts's
 *  `MAX_TICKS`), but an export has no animation loop to watch so it always pays for the full
 *  300 ticks rather than stopping early on low energy. */
const EXPORT_TICKS = 300;
/** Target average nearest-neighbor spacing, in canvas pixels, per DESIGN.md. */
const CANVAS_NODE_SPACING = 220;
/** Mirrors `GraphView`'s own `MAX_NODES` cap so an export can't produce an unbounded canvas. */
const MAX_EXPORT_NODES = 300;

export const DEFAULT_CANVAS_FOLDER = 'Vairë canvases';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same local-name resolution the graph view uses (`GraphView.namesResolver`): a local id
 *  resolves from the center's own package; an `@pkg/...` id resolves only if that dependency
 *  happens to also be open as a sibling vault package (no CLI round trips either way — see
 *  DESIGN.md "Local index"). Falls back to the bare id, same as `buildGraph` itself does. */
function namesResolver(plugin: VairePlugin, pkg: PackageInfo): (id: string) => string | undefined {
  return (id: string): string | undefined => {
    const ref = parseRef(id);
    if (!ref || ref.kind !== 'id') return undefined;
    if (ref.pkg) {
      const depPkg = plugin.packages.byName(ref.pkg);
      return depPkg?.index.get(ref.local)?.name;
    }
    return pkg.index.get(ref.local)?.name;
  };
}

/** `Vault.createFolder` throws if the folder already exists and doesn't reliably create
 *  intermediate directories, so walk the path a segment at a time. */
async function ensureFolder(plugin: VairePlugin, folderPath: string): Promise<void> {
  let current = '';
  for (const part of folderPath.split('/')) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

/** Runs `ForceLayout` to a fixed 300-tick convergence budget (deterministic seed, from the
 *  center node's id — same recipe `GraphView.startSimulation` uses) and returns final positions
 *  scaled to ~220px average node spacing. */
function layoutForExport(graph: GraphModel): Map<string, Position> {
  const seed = hashSeed(graph.nodes.find((n) => n.isCenter)?.id ?? 'vaire-graph');
  const layout = new ForceLayout(graph.nodes, graph.edges, { seed });
  for (let i = 0; i < EXPORT_TICKS; i++) layout.step();

  const positions = new Map<string, Position>();
  for (const node of layout.all()) positions.set(node.id, { x: node.x, y: node.y });
  return scalePositions(positions, CANVAS_NODE_SPACING);
}

/**
 * Exports the active file's local graph — `cli.refs` to `settings.graphDepth` plus
 * `cli.backlinks`, the same recipe `buildGraph` feeds the local graph view — to a JSON Canvas
 * file in `settings.canvasFolder` (default `"Vairë canvases"`, created if missing), then opens
 * it and shows a Notice with the node/edge counts. Every "can't proceed" path (no active file,
 * not a Vairë node, a CLI failure) shows a Notice instead of throwing, mirroring
 * `GraphView`/`plugin.rebuildIndex`.
 *
 * The canvas folder is never placed inside a package directory on the *export's* behalf — but
 * if the configured folder already resolves inside one (most notably when the vault root itself
 * is a package, since every path is "inside" that one), this only warns via Notice and still
 * writes there. A dotfolder like `.vaire-obsidian/` would dodge that, but dotfolders are hidden
 * in Obsidian's file explorer, which is worse for a feature whose entire point is to produce a
 * canvas the user opens and looks at.
 */
export async function exportLocalGraphToCanvas(plugin: VairePlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) {
    new Notice('Vairë: open a note to export its local graph.');
    return;
  }
  const pkg = plugin.packages.packageFor(file);
  const node = pkg ? pkg.index.byFile(file) : null;
  if (!pkg || !node) {
    new Notice('Vairë: the active file is not a Vairë node.');
    return;
  }

  let graph: GraphModel;
  try {
    const [refs, backlinks] = await Promise.all([
      plugin.cli.refs(pkg.absRoot, node.full, plugin.settings.graphDepth),
      plugin.cli.backlinks(pkg.absRoot, node.full),
    ]);
    graph = buildGraph(
      { center: { id: node.full, type: node.type, name: node.name }, refs, backlinks, names: namesResolver(plugin, pkg) },
      { maxNodes: MAX_EXPORT_NODES },
    );
  } catch (err) {
    new Notice(`Vairë: could not export the graph — ${errMessage(err)}`);
    return;
  }

  const positions = layoutForExport(graph);
  const doc = graphToCanvas(graph, positions, {
    vaultPathFor: (id) => pkg.index.get(id)?.file.path,
  });

  const folderPath = normalizePath(plugin.settings.canvasFolder.trim() || DEFAULT_CANVAS_FOLDER);
  const owningPkg = plugin.packages.packageFor(folderPath);
  if (owningPkg) {
    new Notice(
      `Vairë: the canvas folder "${folderPath}" is inside package '${owningPkg.name}' — exported canvases will sit ` +
        `alongside its nodes. Set "Canvas folder" in Settings → Vairë to a path outside any package root to avoid this.`,
      8000,
    );
  }

  try {
    await ensureFolder(plugin, folderPath);
  } catch (err) {
    new Notice(`Vairë: could not create the canvas folder "${folderPath}" — ${errMessage(err)}`);
    return;
  }

  const filePath = normalizePath(`${folderPath}/${canvasFileName(node.full)}`);
  const json = JSON.stringify(doc, null, 2);
  const existing = plugin.app.vault.getAbstractFileByPath(filePath);

  let target: TFile;
  if (existing instanceof TFile) {
    const overwrite = await confirm(plugin.app, {
      title: 'Overwrite canvas?',
      message: `${filePath} already exists. Overwrite it?`,
      okLabel: 'Overwrite',
    });
    if (!overwrite) return;
    await plugin.app.vault.modify(existing, json);
    target = existing;
  } else if (existing) {
    new Notice(`Vairë: ${filePath} exists and is not a file — pick a different canvas folder.`);
    return;
  } else {
    target = await plugin.app.vault.create(filePath, json);
  }

  await plugin.app.workspace.getLeaf(true).openFile(target);
  new Notice(
    `Vairë: exported ${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}, ` +
      `${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'} to ${filePath}`,
  );
}
