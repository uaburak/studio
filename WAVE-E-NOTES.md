# Wave E — Studio.app packaging (S3, G5, P1, P2, P9)

Branch: `worktree-agent-a27aa4042025421c6`. Resume notes; delete this file before merging.

## Setup in this worktree

- `pnpm install --frozen-lockfile` (pnpm at ~/.local/bin).
- Electron binary: `cd apps/desktop/node_modules/electron && node install.js` (extracts from
  ~/Library/Caches/electron, no network).
- Wecra: `apps/desktop/src/renderer/vendor/wecra-editor` → symlink to the main checkout's copy
  (gitignored, never commit).

## Plan (priority order)

1. Packaging: electron-builder config (`apps/desktop/electron-builder.config.cjs`), icon, fuses,
   entitlements, ad-hoc signing, `package` scripts, output `apps/desktop/release/`.
2. Packaged host: `scripts/build-host.mjs` stages `resources/host/` (API bundle + migrations +
   wrangler runtime, gateway script, worker esbuild bundle + sharp/playwright-core, agent/skills);
   `host/layout.ts` resolves dev vs packaged paths; node children run Electron's binary with
   `ELECTRON_RUN_AS_NODE=1`; hard-coded repo path fallback removed.
3. `--self-test` headless mode (temp state, alt ports, mock keychain, no window, no dock).
4. Health (P9) + state-folder lock file.
5. External tools (Playwright Chromium install, ffmpeg/whisper detection), worker env secrets
   store + one-time `.env` import in dev, P2 (login item, keep-awake, crashReporter, About,
   electron-updater behind a disabled flag).

## Status

- [ ] 1 packaging
- [ ] 2 packaged host
- [ ] 3 self-test
- [ ] 4 health + lock
- [ ] 5 tools / keys / P2
