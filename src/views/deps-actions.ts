// Dependency row actions for the package view. See DESIGN.md "Features §3 Dependencies".
// Each action: Notice on start/success/failure (showing `VaireError.message`), then
// `plugin.rebuildIndex(pkg)` on success, returning `true` so the caller knows to refresh.

import { App, Notice, SuggestModal } from 'obsidian';
import { confirm, promptText } from '../ui/prompt-modal';
import type { PackageInfo } from '../packages';
import type { Sighting } from '../types';
import type VairePlugin from '../main';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves with the chosen sighting, or `null` if the picker was dismissed without a choice. */
function pickSighting(app: App, depName: string, sightings: Sighting[]): Promise<Sighting | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Sighting | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    class SightingPickModal extends SuggestModal<Sighting> {
      getSuggestions(query: string): Sighting[] {
        const q = query.trim().toLowerCase();
        if (!q) return sightings;
        return sightings.filter((s) => s.path.toLowerCase().includes(q) || s.version.toLowerCase().includes(q));
      }

      renderSuggestion(sighting: Sighting, el: HTMLElement): void {
        el.createDiv({ text: sighting.path });
        el.createEl('small', { text: `v${sighting.version} · ${sighting.origin}` });
      }

      onChooseSuggestion(sighting: Sighting): void {
        settle(sighting);
      }

      onClose(): void {
        this.contentEl.empty();
        settle(null);
      }
    }

    const modal = new SightingPickModal(app);
    modal.setPlaceholder(`Choose a location for '${depName}'…`);
    modal.open();
  });
}

async function runAdd(plugin: VairePlugin, pkg: PackageInfo, depName: string, linkPath: string): Promise<boolean> {
  new Notice(`Vairë: linking '${depName}'…`);
  try {
    await plugin.cli.add(pkg.absRoot, depName, { link: linkPath });
  } catch (err) {
    new Notice(`Vairë: linking '${depName}' failed — ${errMessage(err)}`);
    return false;
  }
  new Notice(`Vairë: linked '${depName}'`);
  await plugin.rebuildIndex(pkg);
  return true;
}

/**
 * `cli.catalogList()` filtered to live sightings named `depName`: none -> Notice + fall back
 * to `linkFolder`; one -> confirm then link it; several -> a picker modal.
 */
export async function linkFromCatalog(plugin: VairePlugin, pkg: PackageInfo, depName: string): Promise<boolean> {
  let sightings: Sighting[];
  try {
    const list = await plugin.cli.catalogList();
    sightings = list.sightings.filter((s) => s.name === depName && s.state === 'live');
  } catch (err) {
    new Notice(`Vairë: could not read the catalog — ${errMessage(err)}`);
    return false;
  }

  if (sightings.length === 0) {
    new Notice(`Vairë: no catalog sighting for '${depName}' — pick a folder instead.`);
    return linkFolder(plugin, pkg, depName);
  }

  let chosen: Sighting;
  if (sightings.length === 1) {
    const single = sightings[0];
    const ok = await confirm(plugin.app, {
      title: `Link '${depName}'`,
      message: `Link '${depName}' from ${single.path} (v${single.version})?`,
      okLabel: 'Link',
    });
    if (!ok) return false;
    chosen = single;
  } else {
    const picked = await pickSighting(plugin.app, depName, sightings);
    if (!picked) return false;
    chosen = picked;
  }

  return runAdd(plugin, pkg, depName, chosen.path);
}

/** Prompts for an absolute path and links `depName` to it via `cli.add(..., {link})`. */
export async function linkFolder(plugin: VairePlugin, pkg: PackageInfo, depName: string): Promise<boolean> {
  const path = await promptText(plugin.app, {
    title: `Link '${depName}' from folder`,
    placeholder: '/absolute/path/to/package',
    submitLabel: 'Link',
  });
  if (!path || !path.trim()) return false;
  return runAdd(plugin, pkg, depName, path.trim());
}

/** `cli.pull(pkg.absRoot, depName)`. */
export async function pullDependency(plugin: VairePlugin, pkg: PackageInfo, depName: string): Promise<boolean> {
  new Notice(`Vairë: pulling '${depName}'…`);
  try {
    await plugin.cli.pull(pkg.absRoot, depName);
  } catch (err) {
    new Notice(`Vairë: pulling '${depName}' failed — ${errMessage(err)}`);
    return false;
  }
  new Notice(`Vairë: pulled '${depName}'`);
  await plugin.rebuildIndex(pkg);
  return true;
}

/** `cli.pull(pkg.absRoot)` — pulls every unsatisfiable declared dependency. */
export async function pullAll(plugin: VairePlugin, pkg: PackageInfo): Promise<boolean> {
  new Notice('Vairë: pulling dependencies…');
  try {
    await plugin.cli.pull(pkg.absRoot);
  } catch (err) {
    new Notice(`Vairë: pull failed — ${errMessage(err)}`);
    return false;
  }
  new Notice('Vairë: pull complete');
  await plugin.rebuildIndex(pkg);
  return true;
}
