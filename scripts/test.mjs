// Runs unit tests under Electron's Node (ELECTRON_RUN_AS_NODE) so native
// modules built for Electron's ABI (better-sqlite3) load correctly.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');

const build = spawnSync(process.execPath, ['scripts/build-electron.mjs', '--test'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const dir = path.join('dist-electron', 'tests');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.cjs'))
  .map((f) => path.join(dir, f));

const res = spawnSync(electron, ['--test', '--enable-source-maps', ...files], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(res.status ?? 1);
