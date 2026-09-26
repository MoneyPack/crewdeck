/**
 * `crewdeck-browser` — drive crewdeck's built-in browser pane from any terminal agent.
 * Launched by the PTY shims via ELECTRON_RUN_AS_NODE=1.
 */
import { parseCliArgs } from '../../shared/browser';
import { BridgeError, formatResult, runCommand } from './bridgeClient';

const USAGE = `usage: crewdeck-browser <command> [args]

  open <url>                    navigate (aliases: goto, navigate)
  back | forward | reload
  snapshot [-i|--interactive]   accessibility snapshot with @eN refs
  click <@ref>                  hover <@ref>
  fill <@ref> <text...>         type <text...>
  press <key>                   e.g. Enter, Control+a
  scroll [@ref] <down|up|left|right> [px]
  wait <text|@ref> [--timeout=ms]
  screenshot [--full] [--annotate]
  console [--clear]             status`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const cmd = parseCliArgs(argv);
  if (!cmd) {
    process.stderr.write(`crewdeck-browser: invalid command: ${argv.join(' ')}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const result = await runCommand(cmd, 'cli');
    (result.ok ? process.stdout : process.stderr).write(`${formatResult(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`crewdeck-browser: ${err instanceof BridgeError ? err.message : String(err)}\n`);
    return 3;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
