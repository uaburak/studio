// Electron main entry. Sets up what has to exist before anything else (name, data folder, the
// `studio://` scheme), then lets only the first copy of the app start: a second copy hands over
// to the first (its "second-instance" event focuses the window) and quits without constructing
// anything — no settings, no host (which could stop the first copy's children), no window.
import { join } from "node:path";
import { app } from "electron";
import { startApp } from "./app.ts";
import { stateDirectory } from "./host/environment.ts";
import { registerSchemePrivileges } from "./protocol.ts";

app.setName("Studio");
// Chromium's own data stays in a sub folder; the host's files live next to it (shared with
// the AppKit app).
app.setPath("userData", join(stateDirectory(), "desktop"));
registerSchemePrivileges();

if (app.requestSingleInstanceLock()) {
  startApp();
} else {
  app.quit();
}
