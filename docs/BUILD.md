# Building zapfleet

## Prerequisites (Windows)

- Node 26 and npm (CI uses `NODE_VERSION: '26'`).
- Visual Studio 2022 Build Tools with the C++ x86/x64 toolset.
- MSVC Spectre-mitigated libs. Without them, native rebuilds fail with
  `MSB8040`. Install them with:

  ```powershell
  pwsh ./scripts/ci/install-spectre-libs.ps1
  ```

## Native modules

`node-pty` and `better-sqlite3` are rebuilt against the pinned Electron
(44.4.3) with `@electron/rebuild`:

```powershell
npm ci
npm run rebuild
```

A failed rebuild exits non-zero; CI treats it as a hard failure.

## ABI check

`npm run smoke` builds `electron/smoke.ts` and runs it inside Electron. It
loads both `.node` binaries and exercises db, git, PTY, scrollback, logger and
related modules. An ABI mismatch makes it exit non-zero.

## Packaging

```powershell
npm run dist           # NSIS installer in release/
npm run test:e2e:dist  # packaged smoke against release/win-unpacked
```

## Local-dev fallback: N-API prebuilds

If you cannot install the Spectre libs locally, you can skip `npm run rebuild`
and use the N-API prebuilds that ship with `node-pty` and `better-sqlite3`.
This is for local development only. CI and releases always rebuild from
source and run the ABI check.
