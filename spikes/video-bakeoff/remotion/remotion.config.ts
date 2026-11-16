import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setColorSpace("bt709"); // tag + convert as BT.709 (the Remotion 5 default)
// The default Remotion-patched chrome-headless-shell (158.0.8127.2-remotion-v3) never finishes
// "Waiting for root component to load" on this Mac (macOS 27.0.1, M3), even for a minimal composition.
// Chrome for Testing works. See ../REPORT.md.
Config.setChromeMode("chrome-for-testing");
// One tab: byte-identical output run-to-run, and faster than the default 4 tabs on this 16 GB M3.
// With 2-4 tabs, frames containing the scaled product photo differ between runs (PSNR ~50 dB).
Config.setConcurrency(1);
