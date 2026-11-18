// electron-builder configuration of Studio.app (S3, P1). Used by scripts/package.mjs, which
// first builds the app (electron-vite), stages the self-contained host (scripts/build-host.mjs →
// out/host) and the app's own files (out/package: main, preload, renderer and a package.json
// without dependencies, so no node_modules go into the asar).
//
// Switches (environment variables), all off / ad-hoc by default — docs/PACKAGING.md:
//   STUDIO_APP_ID          bundle id (default net.burakkoc.studio)
//   STUDIO_SIGN_IDENTITY   "Developer ID Application: …" (default "-": ad-hoc signature)
//   STUDIO_NOTARIZE=1      notarize with Apple (needs a Developer ID identity and
//                          APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER, or
//                          APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)
//   STUDIO_UPDATE_URL      generic update feed (writes app-update.yml; the app's updater stays
//                          off until src/main/system-services.ts UPDATES.enabled is set)
//   STUDIO_DMG=1           also build a .dmg (mounts a disk image while building)
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const electronVersion = JSON.parse(
  readFileSync(join(__dirname, "node_modules", "electron", "package.json"), "utf8"),
).version;
const appId = process.env.STUDIO_APP_ID || "net.burakkoc.studio";
const identity = process.env.STUDIO_SIGN_IDENTITY || "-";
const notarize = process.env.STUDIO_NOTARIZE === "1";
const updateUrl = process.env.STUDIO_UPDATE_URL || "";
const targets = [{ target: "zip", arch: ["arm64"] }];
if (process.env.STUDIO_DMG === "1") targets.push({ target: "dmg", arch: ["arm64"] });

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName: "Studio",
  copyright: "© Burak Koç",
  electronVersion,
  // The Electron that pnpm installed (no download).
  electronDist: join(__dirname, "node_modules", "electron", "dist"),
  directories: {
    app: "out/package",
    output: "release",
    buildResources: "build",
  },
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // The host runs outside the asar: native binaries (workerd, esbuild, sharp) and node_modules
  // must be real files.
  extraResources: [{ from: "out/host", to: "host" }],
  artifactName: "Studio-${version}-${arch}.${ext}",
  mac: {
    target: targets,
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    identity,
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    gatekeeperAssess: false,
    notarize,
    minimumSystemVersion: "13.0",
    extendInfo: {
      NSHumanReadableCopyright: "© Burak Koç",
      // Bonjour (the LAN gateway is advertised as _studio._tcp).
      NSBonjourServices: ["_studio._tcp"],
      NSLocalNetworkUsageDescription:
        "Studio, telefonundaki Studio uygulamasının bu Mac'e yerel ağdan bağlanabilmesi için yerel ağı kullanır.",
    },
  },
  dmg: { sign: false },
  electronFuses: {
    // Kept on: the host runs wrangler, the gateway and the worker with this app's own binary as
    // Node (ELECTRON_RUN_AS_NODE=1), so the Mac needs no Node install. Trade-off in
    // docs/PACKAGING.md.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  publish: updateUrl ? [{ provider: "generic", url: updateUrl }] : null,
};
