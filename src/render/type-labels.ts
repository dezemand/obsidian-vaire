// Type label visibility. Link labels and tab-title labels are drawn by CSS and by nav/titles.ts,
// so hiding them is a body class the stylesheet keys on (styles/00-base.css); the file explorer
// label is handled by explorer.ts itself via `settings.explorerBadges`.

import type VairePlugin from '../main';

const HIDE_LINK_TYPES = 'vaire-hide-link-types';
const HIDE_TAB_TYPES = 'vaire-hide-tab-types';

export function registerTypeLabels(plugin: VairePlugin): void {
  const apply = (): void => {
    document.body.classList.toggle(HIDE_LINK_TYPES, !plugin.settings.typeLabelsOnLinks);
    document.body.classList.toggle(HIDE_TAB_TYPES, !plugin.settings.typeLabelsInTabs);
  };
  apply();
  plugin.registerEvent(plugin.events.on('settings-changed', apply));
  plugin.register(() => document.body.classList.remove(HIDE_LINK_TYPES, HIDE_TAB_TYPES));

  plugin.addCommand({
    id: 'toggle-type-labels',
    name: 'Toggle type labels',
    callback: async () => {
      const s = plugin.settings;
      const anyOn = s.typeLabelsOnLinks || s.explorerBadges || s.typeLabelsInTabs;
      s.typeLabelsOnLinks = s.explorerBadges = s.typeLabelsInTabs = !anyOn;
      await plugin.saveSettings();
    },
  });
}
