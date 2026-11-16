# F0-2 spike: design generation and render (T1 + T2)

Headless Claude writes a post as constrained HTML/CSS. Chromium renders it locally, a linter checks it,
Claude critiques its own render once and revises it, and the result is rendered again.
Independent npm project; it is not part of the root pnpm workspace.

Results and verdict: FINDINGS.md (the agent could not write report files; its full text is in the F0-2 hand-off report, to be saved here by the project lead). Rules for designs: [CONTRACT.md](CONTRACT.md).

## Look at these first

| file | what |
|---|---|
| `out/03-carousel/compare.jpg` | 3-slide carousel, first pass vs revised |
| `out/01-product-intro/compare.jpg` | product post with the real photo |
| `out/02-typographic/compare.jpg` | type-only post |
| `out/04-image-slot/compare.jpg` | post with an empty image slot; `out/04-image-slot/v2-filled/slide-1.filled.jpg` is the same design with the slot filled by a synthetic busy texture |
| `out/<id>/v2/slide-N.jpg` | final renders, 1080×1350 sRGB JPEG |
| `out/<id>/critique.json` | the model's own art-director critique and change list |

## Layout

```
CONTRACT.md                 design contract v0 (what Claude must follow; what the linter enforces)
brand/venta/                PROVISIONAL pilot brand profile
  brand.json  DESIGN.md  VOICE.md  facts.json  colors.sampled.json
  brand.css                 generated from brand.json (fonts, tokens, type styles, slot placeholder)
  fonts/                    self-hosted Archivo + Montserrat (OFL, from Fontsource)
  logos/                    TYPESET STAND-IN logos (not the real artwork)
  assets/                   product photo (copied from spikes/gemini-image/refs)
briefs/                     the four Turkish briefs
prompts/                    system / generate / revise prompt templates
scripts/
  generate.mjs              brief -> Claude -> lint+render -> critique+revise -> final
  lint.mjs, render.mjs      lint+render one HTML file / render only
  fill-slot.mjs             editor stand-in: fill an image slot, re-lint, re-render
  t1-verify.mjs             headless Claude checks (structured output, vision, confinement, usage)
  t1-sdk.mjs                the same through the Claude Agent SDK
  build-brand-css.mjs, make-standin-logos.mjs, sample-colors.mjs
  lib/studio.mjs            Chromium setup: virtual origin, JS off, network blocked, sRGB JPEG
  lib/lint-inpage.js        DOM/CSS/geometry checks run inside the page
  lib/check.mjs             render + lint + pixel contrast in one page load
  lib/claude.mjs            headless transports (cli, handoff), clean env, locked-down flags
fixtures/                   good.html (passes), bad.html (24 errors on purpose)
out/<brief-id>/             v1/ v2/ html+jpg+png+lint.json, compare.jpg, captions, critique.json, run.json, llm/
logs/                       T1 probe logs
```

## Setup

```bash
cd spikes/design-render
npm install                      # local deps only
npx playwright install chromium  # the only machine-level download (Chromium 159, ~100 MB)
```

## Reproduce without any model call

```bash
npm run brand:css                # brand.json -> brand/venta/brand.css
npm run logos                    # stand-in logos
npm run fixtures                 # linter on a passing and a deliberately broken design
node scripts/lint.mjs out/03-carousel/v2/slide-2.html --out /tmp/check   # lint + render any design
node scripts/fill-slot.mjs out/04-image-slot/v2/slide-1.html field-photo fixtures/busy-test-photo.jpg --out out/04-image-slot/v2-filled/slide-1.filled
for b in briefs/*.json; do node scripts/generate.mjs $b --transport handoff; done   # re-lints and re-renders the stored responses
```

## Run with headless Claude (plain terminal, not inside a Claude session)

The standalone CLI on this Mac was **not logged in** during the spike (`claude auth status` → `loggedIn: false`;
the stored refresh token was rejected). Log in once, then run:

```bash
claude auth login                # or: claude setup-token, then export CLAUDE_CODE_OAUTH_TOKEN=...
npm run t1                       # 5 small calls: structured output, vision x2, confinement x2 -> logs/t1-results.json
npm run t1:sdk                   # same via the Agent SDK -> logs/t1-sdk.messages.json
node scripts/generate.mjs briefs/01-product-intro.json --transport cli --model opus --tag cli   # 2 calls -> out/01-product-intro--cli/
for b in briefs/*.json; do node scripts/generate.mjs $b --transport cli --tag cli; done          # all four briefs: 8 calls
```

`generate.mjs` caches each model response in `out/<id>/llm/*.output.json`; use a new `--tag` to call the model again without touching the stored spike outputs.
Options: `--model` (default `opus`), `--effort low|medium|high|xhigh|max`, `STUDIO_CLAUDE_BIN` for another claude binary.

## Headless recipe (what scripts/lib/claude.mjs does)

```bash
env -i HOME="$HOME" PATH="$PATH" USER="$USER" TMPDIR="$TMPDIR" LANG=en_US.UTF-8 \
  claude -p --input-format stream-json --output-format stream-json --verbose \
  --system-prompt-file system.md --tools "" \
  --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --json-schema "$(cat schema.json)" --model opus  < message.jsonl
# message.jsonl: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."},
#                 {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"..."}}]}}
# Read the last line with "type":"result": structured_output, usage, modelUsage, total_cost_usd, duration_ms.
```

Never `--bare` (it ignores the subscription login). Never pass `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
or `ANTHROPIC_BASE_URL` to the child (`env -i` / an allow-list does that).
