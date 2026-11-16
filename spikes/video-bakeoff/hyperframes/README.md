# HyperFrames variant

Venta Borinc 8 s Reel (1080x1920, 30 fps) as one HTML file: `index.html`.

- Engine: `hyperframes` 0.9.56 (CLI), `@hyperframes/player` 0.9.56, `@hyperframes/sdk` 0.9.56, `gsap` 3.15.1.
- Brand tokens and copy are declared once in `data-composition-variables` on `<html>`. Colours reach CSS as `var(--colorPrimary)` and the other tokens. Text and the image use `data-var-text` / `data-var-src`.
- Font: Montserrat 800/600 TTF in `assets/fonts/` (OFL). GSAP is loaded from `assets/vendor/gsap.min.js`. Nothing is fetched from the network at render time.
- ffmpeg/ffprobe: HyperFrames does not bundle them. `../tools/env.sh` points `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` at the npm binaries in `../tools`, and turns off telemetry (`HYPERFRAMES_NO_TELEMETRY=1`) and the automatic skills install.

## Commands

```bash
cd spikes/video-bakeoff/tools && npm ci          # local ffmpeg 6.0 + ffprobe 4.4.1 (arm64), font package
cd ../hyperframes && npm ci

npm run doctor     # environment check (FFmpeg/FFprobe should show the tools/ paths)
npm run lint       # static contract: 0 errors, 3 warnings (it prefers one sub-composition per scene)
npm run check      # browser check: layout, Reels/TikTok/Shorts safe zones, contrast, motion, craft
npm run render     # -> ../out/hyperframes-raw.mp4 (~7 s warm on an M3)

# Reels normalisation + verification (both engines)
cd ../tools && npm run normalize

# Player demo (web component + live text/colour edits)
npm run bundle:player                        # compiles index.html -> player-dist/index.html (runtime + inlined assets)
python3 -m http.server 8811 --bind 127.0.0.1 # then open http://127.0.0.1:8811/player-demo/index.html

# Headless editing probe with @hyperframes/sdk (writes player-dist/sdk-edited.html; index.html is not touched)
node scripts/sdk-edit-probe.mjs
```

Useful render flags that were measured: `--workers 1`, `--gpu` (VideoToolbox encode), `--no-browser-gpu`.

On the first render the CLI downloads its own `chrome-headless-shell` 152.0.7977.30 into `~/.cache/hyperframes/chrome` (194 MB). It also writes `~/.hyperframes/config.json`.
