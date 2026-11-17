// The renderer alone in a browser (`pnpm --filter @studio/desktop dev:renderer`): the
// component gallery at /?route=gallery and headless render checks. Same config as the app's
// renderer (electron.vite.config.ts), including the /api proxy to the local host.
import type { UserConfig } from "vite";
import config from "./electron.vite.config.ts";

const renderer = (config as { renderer: UserConfig }).renderer;
export default renderer;
