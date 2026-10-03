<p align="center">
  <img src="build/banner.svg" alt="CrewDeck — Coding-agent CLIs, side by side." width="800">
</p>
<p align="center"><img src="build/tagline.svg" alt="claude · codex · gemini · opencode · your agent · shell — side by side" width="800"></p>

<p align="center">
  <a href="https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml"><img src="https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/MoneyPack/crewdeck/releases"><img src="https://img.shields.io/github/v/release/MoneyPack/crewdeck?color=ff4d00" alt="Release"></a>
  <a href="https://github.com/MoneyPack/crewdeck/releases"><img src="https://img.shields.io/github/downloads/MoneyPack/crewdeck/total?color=c6f432" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fe0ff" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0c0c0a" alt="Windows">
</p>

<table align="center"><tr>
<td width="110" align="center"><img src="build/crewbot.svg" width="96" alt="CrewBot, the CrewDeck mascot waving"></td>
<td>
<b>Hey, captain. Your crew is waking up.</b><br>
CrewDeck is a Windows desktop app that runs several coding-agent CLIs — <b>Claude Code, Codex, Gemini CLI, OpenCode</b>, any CLI you bring, or a plain shell — side by side against one project folder. Tile up to four panes, send one prompt to many with <code>@mentions</code>, and let agents drive a built-in browser.
</td></tr></table>

## Why CrewDeck

|                             |                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent-agnostic**          | First-class profiles for Claude Code, Codex, Gemini CLI and OpenCode, one-click install, plus _bring your own agent_ (any command + args + env).                                              |
| **Diff Race**               | Same task to 2–4 agents, each in its own git worktree. Compare their diffs side by side, **keep one** — it merges; the rest are discarded. Agents compete, you judge.                         |
| **Attention Inbox**         | Every agent asking "allow? (y/n)" lands in one inbox with the question text and one-click answers. Never hunt for the blocked pane again.                                                     |
| **One prompt, many agents** | The composer routes a message to one pane or all of them with `@claude @codex …`. Compare answers, keep the best.                                                                             |
| **Built-in browser bridge** | Agents open pages, fill forms, click and screenshot through a local HTTP bridge, the `crewdeck-browser` CLI, or the `crewdeck-mcp` MCP server.                                                |
| **BYOK for 10 providers**   | Anthropic, OpenAI, Gemini, Google, OpenRouter, Groq, Mistral, xAI, DeepSeek, DashScope, or any custom env name — encrypted with the Windows credential vault and injected into every session. |
| **Fast, dark, no fluff**    | Instant boot splash, 60 fps WebGL terminals, command palette (`Ctrl+Shift+P`), git panel, routing log, session restore.                                                                       |
| **Auto-updates**            | Ships with a built-in updater. Install once, stay current.                                                                                                                                    |

## Install

Download `crewdeck Setup <version>.exe` from [Releases](https://github.com/MoneyPack/crewdeck/releases).

Windows SmartScreen may warn until code signing is live: click "More info" → "Run anyway".

## Usage

1. Open a project folder.
2. Add agent panes (Claude Code, Codex, Gemini CLI, OpenCode, a custom agent, or shell). Each pane runs in its own terminal with a CrewDeck header, clear and copy actions.
3. Use the composer to send prompts to one or more panes.
4. Open a browser pane to let agents drive a built-in browser through the bridge, CLI, or MCP tools below.
5. `Ctrl+,` opens Settings — every option has a one-line description; API keys live under **API keys (BYOK)**.

### Diff Race

Click **⚑ Race**, pick 2–4 agents, describe the task once. Every racer gets the identical prompt in an isolated worktree on a `crewdeck/*` branch. The race view shows each racer's live diff vs your checkout (files, +/−). **Keep** commits that racer's work and merges it; the other worktrees are removed. **Drop** discards one racer early.

### Attention Inbox

The toolbar badge `N need you` opens an inbox listing every pane that is waiting on a human — with the last lines it printed. Answer with **y / n / Enter / Esc** or type a reply, without leaving what you're doing.

### Resume past sessions

The command palette lists recent **Claude Code** and **Codex** sessions recorded for this project folder (read from `~/.claude/projects` and `~/.codex/sessions`). Pick one to reopen it with `--resume`.

### Reader mode & cost HUD

Each pane has a **Reader** toggle that renders the terminal as readable text — TUI borders and spinners stripped, code fences and bullets kept. The pane header also shows **tokens · $** scraped from whatever the agent prints about usage (approximate; agents differ).

### Pipelines

Chain agents from the composer. Each stage receives the task plus the previous stage's output, and advances automatically when the agent goes quiet or asks for input:

```
@claude -> @codex -> @gemini: build the login page with tests
```

A strip above the composer shows the stage that's running; cancel any time.

### Crew status

Every pane shows **working**, **needs you** (prompt / permission ask detected) or **idle**. The toolbar sums it up across the crew, and panes waiting on you glow orange.

### Project presets

Commit a `.crewdeck.json` to your repo and the deck opens pre-staffed the first time someone opens that folder:

```json
{ "agents": ["claude", "codex", "shell"], "layout": 4 }
```

Agent ids are the profile ids (`claude`, `codex`, `gemini`, `opencode`, `shell`, or a custom agent). Not-installed agents are skipped.

### Summon hotkey

`Ctrl+Alt+C` shows or hides crewdeck from any app. Change it under Settings → Summon hotkey.

## Browser bridge

When the app starts, it launches a local HTTP bridge:

- Binds `127.0.0.1` on a random port (never exposed to the network).
- Fresh 32-byte token per session.
- Send the token as `Authorization: Bearer <token>` or `x-crewdeck-token: <token>`.

| Route         | Purpose               |
| ------------- | --------------------- |
| `GET /health` | Liveness check        |
| `GET /state`  | Current browser state |
| `POST /run`   | Run a browser command |

Agent panes started by crewdeck receive the bridge address and token automatically.

## CLI: `crewdeck-browser`

```
usage: crewdeck-browser <command> [args]
```

Run `crewdeck-browser --help` for the command list.

| Exit code | Meaning                                 |
| --------- | --------------------------------------- |
| 0         | Success (including `--help`)            |
| 1         | Command failed                          |
| 2         | Usage error (no or invalid command)     |
| 3         | Bridge unreachable / connection failure |

## MCP server: `crewdeck-mcp`

Exposes the browser to MCP-capable agents via stdio.

| Tool                 | Purpose                            |
| -------------------- | ---------------------------------- |
| `browser_open`       | Navigate to a URL                  |
| `browser_snapshot`   | Accessibility/DOM snapshot of page |
| `browser_screenshot` | Capture a PNG of the page          |
| `browser_click`      | Click an element                   |
| `browser_hover`      | Hover an element                   |
| `browser_fill`       | Set an input's value               |
| `browser_type`       | Type text into the focused element |
| `browser_press`      | Press a key                        |
| `browser_scroll`     | Scroll the page or an element      |
| `browser_wait`       | Wait for a selector or timeout     |
| `browser_console`    | Read console messages              |

## Screenshots

Screenshots are captured from an offscreen `BrowserWindow` (`paintWhenInitiallyHidden`), so they work even when the browser pane is hidden or minimized.

## Development

Requires Node.js and Windows.

```powershell
npm i
npm run dev        # run in development
npm run build      # build renderer + main
npm start          # run the built app
npm run dist       # build the Windows installer into release/
```

| Script                  | Purpose                        |
| ----------------------- | ------------------------------ |
| `npm run typecheck`     | TypeScript type check          |
| `npm run lint`          | ESLint (JS/MJS)                |
| `npm run format:check`  | Prettier check                 |
| `npm run format`        | Prettier write                 |
| `npm test`              | Unit tests                     |
| `npm run test:e2e`      | Playwright E2E tests           |
| `npm run test:stress`   | Stress tests                   |
| `npm run test:e2e:dist` | E2E against the packaged build |
| `npm run smoke`         | Smoke test                     |

## Roadmap

- [ ] Session recording & replay (share an agent run as a `.crewdeck` file)
- [ ] Split prompt / diff view: send the same task to N agents and diff their patches
- [ ] Agent presets per project (`.crewdeck.json`)
- [ ] Linux & macOS builds
- [ ] Themes beyond Signal (contributions welcome)

Have an idea? [Open an issue](https://github.com/MoneyPack/crewdeck/issues/new) — CrewBot reads them all.

## Code signing

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Privacy

crewdeck runs entirely on your machine and collects no telemetry or user data. The only network request it makes on its own is the update check against GitHub Releases.

## License

[MIT](LICENSE)

<p align="center"><sub>Built by <a href="https://github.com/MoneyPack">MoneyPack</a> · CrewBot is an original CrewDeck character</sub></p>
