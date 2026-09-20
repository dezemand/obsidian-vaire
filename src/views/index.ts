// Views feature entry point. Each pair of views lives in its own module so they can be built
// independently; this file only wires them up.

import type VairePlugin from '../main';
import { registerPackageAndNodeViews } from './package-node';
import { registerExternalAndCatalogViews } from './external-catalog';

export function registerViews(plugin: VairePlugin): void {
  registerPackageAndNodeViews(plugin);
  registerExternalAndCatalogViews(plugin);
}
