// Plugin-load smoke test: there is no Obsidian GUI in this environment, and the `obsidian` npm
// package is types-only (no runtime — see package.json / node_modules/obsidian/package.json's
// `"main": ""`), which is exactly why nothing else exercises `VairePlugin.onload()` wiring up
// all ~20 `register*` passes from `src/main.ts` end to end. This test builds a minimal but
// functional fake `obsidian` runtime (tests/fakes/obsidian.ts) plus a real (happy-dom) DOM
// (tests/fakes/dom.ts), installs both via `mock.module` *before* `../src/main` is ever
// imported, and then actually runs `onload()`/`onunload()` against them.
//
// What this does and doesn't prove: it proves the wiring in `onload()` — every `register*` call,
// every command/view registration, the settings tab's `display()` — runs without throwing
// against a plausible (if simplified) Obsidian host, and that ids/view-types don't collide. It
// does not prove any feature's actual behavior (rendering, suggestions, CLI calls, ...) — those
// are covered by each feature's own pure-logic unit tests.

import { beforeAll, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import { installDom } from './fakes/dom';
import * as fakeObsidian from './fakes/obsidian';

// ---- install the DOM + module mocks, before anything imports '../src/main' -------------------

installDom();

const VAULT_BASE_PATH = '/tmp/vaire-test-vault';

mock.module('obsidian', () => fakeObsidian);

// ---- load the plugin (and settings) modules only now that the mocks are in place -------------

type MainModule = typeof import('../src/main');
type SettingsModule = typeof import('../src/settings');

let VairePlugin: MainModule['default'];
let DEFAULT_SETTINGS: SettingsModule['DEFAULT_SETTINGS'];
let VaireSettingTab: SettingsModule['VaireSettingTab'];

let plugin: InstanceType<MainModule['default']>;
let settingTab: InstanceType<SettingsModule['VaireSettingTab']>;

beforeAll(async () => {
  ({ default: VairePlugin } = await import('../src/main'));
  ({ DEFAULT_SETTINGS, VaireSettingTab } = await import('../src/settings'));

  const app = fakeObsidian.createFakeApp(VAULT_BASE_PATH);
  const manifest = {
    id: 'vaire-obsidian',
    name: 'Vairë',
    version: '0.1.0',
    minAppVersion: '1.0.0',
    description: 'Vairë knowledge packages inside Obsidian',
    author: 'test',
  };

  // `app`/`manifest` are the fake runtime objects `mock.module('obsidian', ...)` substitutes in
  // at runtime — `tsc` still checks this file against the *real* `obsidian` package's types
  // (see tests/fakes/obsidian.ts's doc comment), which our fakes don't structurally satisfy
  // (real `App` carries many more members this smoke test never touches). `as never` opts out
  // of that structural check at the two call sites that hand a fake object somewhere typed for
  // the real one; everything else in this file is checked normally.
  plugin = new VairePlugin(app as never, manifest as never);
  // No real `vaire` is spawned: an explicit, nonexistent binary path makes every CLI call fail
  // fast with ENOENT, exactly like a missing binary. (A process-wide `mock.module` of
  // `node:child_process` would also do it, but Bun module mocks leak into every other test file
  // in the same run and broke the real-git history integration tests.)
  await plugin.saveData({ binaryPath: '/nonexistent/vaire-smoke-test' });

  // The thing this whole test is for: `onload()` wires up every `register*` pass (rendering,
  // suggestions, views, graph, diagnostics, status bar, authoring, supersede, type colors,
  // health, workbench, tree, nav, query blocks) plus commands/events/the settings tab. It must
  // resolve without throwing against the fake host.
  await plugin.onload();
});

// ---- onload -------------------------------------------------------------------------------

describe('VairePlugin.onload()', () => {
  test('type label settings toggle the body classes the stylesheet hides labels with', async () => {
    plugin.settings.typeLabelsOnLinks = false;
    plugin.settings.typeLabelsInTabs = false;
    await plugin.saveSettings();
    expect(document.body.classList.contains('vaire-hide-link-types')).toBe(true);
    expect(document.body.classList.contains('vaire-hide-tab-types')).toBe(true);

    plugin.settings.typeLabelsOnLinks = true;
    plugin.settings.typeLabelsInTabs = true;
    await plugin.saveSettings();
    expect(document.body.classList.contains('vaire-hide-link-types')).toBe(false);
    expect(document.body.classList.contains('vaire-hide-tab-types')).toBe(false);
  });

  test('resolves without throwing (covered by beforeAll — this just asserts the plugin came up)', () => {
    expect(plugin).toBeInstanceOf(VairePlugin);
    expect(plugin.settings).toBeTruthy();
    expect(plugin.cli).toBeTruthy();
    expect(plugin.packages).toBeTruthy();
    expect(plugin.cache).toBeTruthy();
  });

  test('no duplicate command ids among addCommand calls', () => {
    const commands = (plugin as unknown as { __commands: () => fakeObsidian.Command[] }).__commands();
    expect(commands.length).toBeGreaterThan(0);

    const seen = new Map<string, number>();
    for (const cmd of commands) seen.set(cmd.id, (seen.get(cmd.id) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} (x${count})`);

    expect(duplicates, `duplicate command ids: ${duplicates.join(', ')}`).toEqual([]);
  });

  test('every registered view type is unique', () => {
    const registrations = (plugin as unknown as { __viewTypeRegistrations: () => string[] }).__viewTypeRegistrations();
    expect(registrations.length).toBeGreaterThan(0);

    const seen = new Map<string, number>();
    for (const type of registrations) seen.set(type, (seen.get(type) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([type, count]) => `${type} (x${count})`);

    expect(duplicates, `duplicate view types: ${duplicates.join(', ')}`).toEqual([]);
  });

  test('every DEFAULT_SETTINGS key is a key of VaireSettings, and plugin.settings carries them all', () => {
    // `export const DEFAULT_SETTINGS: VaireSettings = {...}` (src/settings.ts) already makes
    // this a compile-time guarantee — `tsc` (via `bun run typecheck`) rejects that object
    // literal outright if it's missing a `VaireSettings` key or carries an extra one, so there
    // is no separate runtime check that could catch something `tsc` wouldn't. What we *can*
    // check at runtime is that `onload()`'s `Object.assign({}, DEFAULT_SETTINGS, await
    // this.loadData())` actually landed every one of those keys on the live plugin instance
    // (e.g. nothing renamed on one side and not the other, no key dropped by a bad merge).
    const defaultKeys = Object.keys(DEFAULT_SETTINGS);
    expect(defaultKeys.length).toBeGreaterThan(25);
    for (const key of defaultKeys) {
      expect(Object.prototype.hasOwnProperty.call(plugin.settings, key), `plugin.settings missing "${key}"`).toBe(true);
    }
  });
});

// ---- settings tab ---------------------------------------------------------------------------

describe('VaireSettingTab', () => {
  test('display() runs without throwing and renders more than 20 Setting rows', () => {
    settingTab = new VaireSettingTab(plugin.app as never, plugin as never);
    expect(() => settingTab.display()).not.toThrow();

    const rows = settingTab.containerEl.querySelectorAll('.setting-item');
    expect(rows.length).toBeGreaterThan(20);
  });
});

// ---- onunload -------------------------------------------------------------------------------

describe('VairePlugin.onunload()', () => {
  test('runs without throwing, and every register(...)/registerEvent(...)/registerDomEvent(...)/registerInterval(...) cleanup runs without throwing', () => {
    // `plugin.unload()` (inherited from the fake Component/Plugin base, mirroring real
    // Obsidian's Component lifecycle) calls VairePlugin's own `onunload()` override first —
    // closing the MCP pool, flushing the cache, clearing auto-index timers — and then runs
    // every cleanup callback registered via `register`/`registerEvent`/`registerDomEvent`/
    // `registerInterval` across all ~20 register* passes, in reverse registration order. A
    // throw anywhere in that chain fails this test.
    expect(() => plugin.unload()).not.toThrow();
  });
});
