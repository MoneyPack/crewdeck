import { build, context } from 'esbuild';
import { readdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'node-pty', 'better-sqlite3'],
  loader: { '.sql': 'text' },
  logLevel: 'info',
};

if (process.argv.includes('--test')) {
  // Unit tests: bundle each tests/*.test.ts into dist-electron/tests/*.cjs.
  const entryPoints = readdirSync('tests')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f}`);
  await build({ ...common, entryPoints, outdir: 'dist-electron/tests', logLevel: 'warning' });
} else {
  const entryPoints = ['electron/main.ts', 'electron/preload.ts', 'electron/cli/crewdeck-browser.ts', 'electron/cli/crewdeck-mcp.ts'];
  if (process.argv.includes('--smoke')) entryPoints.push('electron/smoke.ts');

  if (watch) {
    const ctx = await context({ ...common, entryPoints });
    await ctx.watch();
  } else {
    await build({ ...common, entryPoints });
  }
}
