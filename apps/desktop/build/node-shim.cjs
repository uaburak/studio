// Preloaded (`--require`) into every Node child Studio.app runs with its own binary
// (`ELECTRON_RUN_AS_NODE=1`): wrangler, the LAN gateway, the worker. Electron's Node reports
// `process.versions.electron`, and libraries that see it believe they run inside a packaged
// Electron app (yargs then drops wrangler's first argument). These children are plain Node
// programs, so they get a plain Node's view. `STUDIO_ELECTRON_NODE` says where they run.
"use strict";
delete process.versions.electron;
process.env.STUDIO_ELECTRON_NODE = "1";
