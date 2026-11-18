// The hidden canvas runner's page (shared/canvas-runner.ts, features/canvas-runner): no UI, only
// Wecra's engine for the chat agent's canvas jobs while no post window has the post open.
import { startCanvasRunnerPage } from "./features/canvas-runner/page.ts";

const runner = window.studio?.canvasRunner;
if (runner) startCanvasRunnerPage(runner);
