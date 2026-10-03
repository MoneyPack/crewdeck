<p align="center">
  <img src="build/banner.svg" alt="CrewDeck — Coding-agent CLIs, side by side." width="800">
</p>
<p align="center"><img src="build/tagline.svg" alt="claude · codex · gemini · shell — side by side" width="800"></p>

<p align="center">
  <a href="https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml"><img src="https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/MoneyPack/crewdeck/releases"><img src="https://img.shields.io/github/v/release/MoneyPack/crewdeck" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

A Windows desktop app for running several coding-agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode, your own agents, or a plain shell) side by side in one project.

## Install

Download `crewdeck Setup <version>.exe` from [Releases](https://github.com/MoneyPack/crewdeck/releases).

Windows SmartScreen may warn until code signing is live: click "More info" → "Run anyway".

## Usage

1. Open a project folder.
2. Add agent panes (Claude Code, Codex, Gemini CLI, OpenCode, a custom agent, or shell). Each pane runs in its own terminal.
3. Use the composer to send prompts to one or more panes.
4. Open a browser pane to let agents drive a built-in browser through the bridge, CLI, or MCP tools below.

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

## Code signing

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Privacy

crewdeck runs entirely on your machine and collects no telemetry or user data. The only network request it makes on its own is the update check against GitHub Releases.

## License

[MIT](LICENSE)
