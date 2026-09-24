// Runs the env-gated terminal stress harness (e2e/stress.spec.ts).
// Usage: npm run test:stress [-- --no-build] [-- --seconds=30]
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const secondsArg = args.find((a) => a.startsWith('--seconds='))

const run = (cmd, cmdArgs, env) => {
  // Single command string: npm/npx are .cmd shims on Windows and need a shell (args are static, no user input).
  const r = spawnSync([cmd, ...cmdArgs].join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!noBuild) run('npm', ['run', 'build'])

run('npx', ['playwright', 'test', 'e2e/stress.spec.ts', '--reporter=list'], {
  CREWDECK_STRESS: '1',
  ...(secondsArg ? { CREWDECK_STRESS_SECONDS: secondsArg.split('=')[1] } : {}),
})
