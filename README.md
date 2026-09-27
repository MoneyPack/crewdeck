# crewdeck

[![CI](https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml)

A Windows desktop app for running several coding-agent CLIs (Claude Code, Codex, Gemini CLI, or a plain shell) side by side in one project.

## Install

Download `crewdeck Setup <version>.exe` from the [Releases](https://github.com/MoneyPack/crewdeck/releases) page and run it. The installer is not code-signed yet, so Windows SmartScreen may warn on first launch ("More info" → "Run anyway").

## Usage

1. Open a project folder.
2. Add agent panes (Claude Code, Codex, Gemini CLI, or shell). Each pane runs in its own terminal.
3. Use the composer to send prompts to one or more panes.
4. Open a browser pane to let agents drive a built-in browser through the bridge, CLI, or MCP tools below.

## Browser bridge

When the app starts, it launches a local HTTP bridge:

- Binds to `127.0.0.1` on a random port (never exposed to the network).
- A fresh 32-byte token is generated per session.
- Send the token as `Authorization: Bearer <token>` or `x-crewdeck-token: <token>`.

| Method | Route     | Purpose               |
| ------ | --------- | --------------------- |
| `GET`  | `/health` | Liveness check        |
| `GET`  | `/state`  | Current browser state |
| `POST` | `/run`    | Run a browser command |

Agent panes started by crewdeck receive the bridge address and token automatically.

## CLI: `crewdeck-browser`

```
usage: crewdeck-browser <command> [args]
```

Run `crewdeck-browser --help` for the command list.

| Exit code | Meaning                                 |
| --------- | --------------------------------------- |
| `0`       | Success (including `--help`)            |
| `1`       | Command failed                          |
| `2`       | Usage error (no or invalid command)     |
| `3`       | Bridge unreachable / connection failure |

## MCP server: `crewdeck-mcp`

Exposes the browser to MCP-capable agents via stdio. Tools:

| Tool                 | Description                        |
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

## License

UNLICENSED. All rights reserved.
