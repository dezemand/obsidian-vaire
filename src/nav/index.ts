// Navigation feature (feat/tab-titles): node names in tab headers/the view title
// (src/nav/titles.ts) and scope breadcrumbs (src/nav/breadcrumbs.ts — 'header' placement is
// wired directly from src/render/header.ts; this only registers the 'view' placement's own
// leaf-watching pass). See DESIGN.md-adjacent doc comments in each file for the DOM contract.

import type VairePlugin from '../main';
import { registerViewBreadcrumbs } from './breadcrumbs';
import { registerTabTitles } from './titles';

export function registerNav(plugin: VairePlugin): void {
  registerTabTitles(plugin);
  registerViewBreadcrumbs(plugin);
}
