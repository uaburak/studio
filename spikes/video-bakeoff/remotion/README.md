# Remotion variant

The same Venta Borinc 8 s Reel (1080x1920, 30 fps) as a React composition.

- `src/Venta.tsx` holds the composition, the zod props schema and the default props. `src/Root.tsx` registers it and `src/index.ts` is the entry point.
- Engine: `remotion`, `@remotion/cli`, `@remotion/player`, `@remotion/fonts`, `@remotion/zod-types` 4.0.544, with `react`/`react-dom` 19.3.1 and `zod` 4.6.7.
- Brand tokens and copy arrive once, as props validated by `ventaSchema`. Studio shows them as an editable props panel.
- Font: Montserrat 800/600 TTF in `public/fonts/`, loaded with `@remotion/fonts` `loadFont()` and `staticFile()`. Nothing is fetched from the network at render time.
- ffmpeg/ffprobe ship with Remotion (`@remotion/compositor-darwin-arm64`).

## `remotion.config.ts`: settings this machine needs

| Setting | Why |
|---|---|
| `Config.setChromeMode("chrome-for-testing")` | The default Remotion-patched `chrome-headless-shell` 158.0.8127.2-remotion-v3 fails on this Mac (macOS 27.0.1, M3), even with a one-div composition. It always ends with `A delayRender() "Waiting for root component to load …" was called but not cleared after 28000ms`. Chrome for Testing 158.0.8127.2 works. |
| `Config.setConcurrency(1)` | With the default 4 tabs (and with 2), the frames that contain the scaled product photo differ between runs (PSNR around 50 dB). One tab gives byte-identical output, and on this 16 GB M3 it is also faster: 16 s against 25 s. |
| `Config.setColorSpace("bt709")` | Without it the raw file is `yuvj420p` tagged bt470bg. bt709 becomes the default in Remotion 5. |

## Commands

```bash
cd spikes/video-bakeoff/remotion && npm ci
npm run render         # -> ../out/remotion-raw.mp4 (~16 s warm). The first run downloads Chrome for Testing (376 MB) into node_modules/.remotion
npm run studio         # Remotion Studio, with a props panel generated from the zod schema (not exercised in this spike)

# Reels normalisation + verification (both engines)
cd ../tools && npm run normalize

# Player demo (@remotion/player + live prop edits)
npm run build:player   # esbuild bundle -> player-demo/dist/main.js
python3 -m http.server 8812 --bind 127.0.0.1   # then open http://127.0.0.1:8812/player-demo/index.html
```

`node_modules/.remotion/chrome-headless-shell` (459 MB) is the default browser that failed. It is left in place as evidence and can be deleted.
