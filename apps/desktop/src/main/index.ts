// Electron main entry. Sets up what has to exist before anything else (name, data folder, the
// `studio://` scheme), then lets only the first copy of the app start: a second copy hands over
// to the first (its "second-instance" event focuses the window) and quits without constructing
// anything — no settings, no host (which could stop the first copy's children), no window.
//
// `--self-test` (self-test.ts) runs instead of the app: a throwaway profile and state folder, no
// window, no single-instance lock (it never touches a running Studio), exit code = result.
import { join } from "node:path";
import { app } from "electron";
import { startApp } from "./app.ts";
import { stateDirectory } from "./host/environment.ts";
import { registerSchemePrivileges } from "./protocol.ts";
import { isSelfTest, prepareSelfTest, runSelfTest } from "./self-test.ts";
import { startCrashReporter } from "./system-services.ts";

app.setName("Studio");
registerSchemePrivileges();

if (isSelfTest()) {
  const context = prepareSelfTest();
  void runSelfTest(context)
    .catch((error: unknown) => {
      console.error(`self-test: ${error instanceof Error ? error.stack : String(error)}`);
      return 1;
    })
    // stdout to a pipe is asynchronous on macOS: let the report out before exiting.
    .then((code) => process.stdout.write("", () => app.exit(code)));
} else {
  // Chromium's own data stays in a sub folder; the host's files live next to it (shared with
  // the AppKit app).
  app.setPath("userData", join(stateDirectory(), "desktop"));
  // P2: crashes are written next to the logs, never uploaded.
  startCrashReporter(join(stateDirectory(), "logs", "crashes"));
  if (app.requestSingleInstanceLock()) {
    startApp();
  } else {
    app.quit();
  }
}
