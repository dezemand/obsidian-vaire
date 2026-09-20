// Builds the manual-install archive: `vaire-<version>.zip` containing a single `vaire/`
// folder with the three files Obsidian loads, so unzipping it into
// `<vault>/.obsidian/plugins/` yields a working plugin directory. Run after `bun run build`.

import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const FILES = ['main.js', 'manifest.json', 'styles.css'];
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as { id: string; version: string };
const stageDir = join('dist', manifest.id);
const zipName = `${manifest.id}-${manifest.version}.zip`;

for (const file of FILES) {
  if (!existsSync(file)) {
    console.error(`missing ${file} — run \`bun run build\` first`);
    process.exit(1);
  }
}

rmSync('dist', { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const file of FILES) copyFileSync(file, join(stageDir, file));

// `zip` ships with macOS and the GitHub runners; -r keeps the `vaire/` folder inside the archive.
const result = spawnSync('zip', ['-qr', join('..', zipName), manifest.id], { cwd: 'dist', stdio: 'inherit' });
if (result.status !== 0) {
  console.error('zip failed');
  process.exit(result.status ?? 1);
}
console.log(`wrote ${zipName} (unzip into <vault>/.obsidian/plugins/)`);
