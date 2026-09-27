// Runs the Playwright smoke test against the packaged app (release/win-unpacked).
// Builds the package first unless --no-build is passed and the exe already exists.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = resolve(root, 'release', 'win-unpacked', process.platform === 'win32' ? 'crewdeck.exe' : 'crewdeck');
const skipBuild = process.argv.includes('--no-build');

function run(cmd, args, env = process.env) {
  // Single command string avoids Node's DEP0190 (args + shell:true); args here are static.
  const r =
    process.platform === 'win32'
      ? spawnSync([cmd, ...args].join(' '), { cwd: root, stdio: 'inherit', shell: true, env })
      : spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!skipBuild || !existsSync(exe)) run('npm', ['run', 'dist']);
if (!existsSync(exe)) {
  console.error(`packaged exe not found: ${exe}`);
  process.exit(1);
}

console.log(`e2e against ${exe}`);
run('npx', ['playwright', 'test'], { ...process.env, CREWDECK_E2E_EXE: exe });
