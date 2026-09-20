// Copies the built plugin into a vault's `.obsidian/plugins/vaire/` and makes sure it is
// enabled. Run via `bun run install:vault [vaultPath]` — the vault path is either the first
// argument or the OBSIDIAN_VAULT environment variable; with neither set, this prints usage and
// exits non-zero rather than guessing a machine-specific default.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'vaire';
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error('Usage: bun run install:vault <vaultPath>');
  console.error('       (or set the OBSIDIAN_VAULT environment variable)');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pluginDir = path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
fs.mkdirSync(pluginDir, { recursive: true });
console.log(`Vault: ${vault}`);
console.log(`Plugin dir: ${pluginDir}`);

let missing = false;
for (const file of ARTIFACTS) {
  const src = path.join(repoRoot, file);
  if (!fs.existsSync(src)) {
    console.error(`  missing ${file} at ${src} — run \`bun run build\` first.`);
    missing = true;
    continue;
  }
  const dest = path.join(pluginDir, file);
  fs.copyFileSync(src, dest);
  console.log(`  copied ${file}`);
}

const obsidianDir = path.join(vault, '.obsidian');
fs.mkdirSync(obsidianDir, { recursive: true });
const communityPluginsPath = path.join(obsidianDir, 'community-plugins.json');

let plugins: string[] = [];
if (fs.existsSync(communityPluginsPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(communityPluginsPath, 'utf8'));
    if (Array.isArray(parsed)) plugins = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    console.warn(`  could not parse existing ${communityPluginsPath}; replacing it.`);
  }
}

if (plugins.includes(PLUGIN_ID)) {
  console.log(`  "${PLUGIN_ID}" already listed in community-plugins.json`);
} else {
  plugins.push(PLUGIN_ID);
  fs.writeFileSync(communityPluginsPath, JSON.stringify(plugins, null, 2) + '\n');
  console.log(`  added "${PLUGIN_ID}" to community-plugins.json`);
}

if (missing) {
  console.error('Done, with errors — some build artifacts were missing.');
  process.exitCode = 1;
} else {
  console.log('Done.');
}
