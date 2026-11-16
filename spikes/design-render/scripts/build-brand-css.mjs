// Builds <brandDir>/brand.css from <brandDir>/brand.json.
// The generated stylesheet is the ONLY place where @font-face, colour tokens,
// type styles and the shared slot placeholder look are defined. Designs link it
// as /brand/brand.css and must not redefine fonts.
// Usage: node scripts/build-brand-css.mjs brand/venta
import fs from 'node:fs';
import path from 'node:path';

const brandDir = process.argv[2] ?? 'brand/venta';
const brand = JSON.parse(fs.readFileSync(path.join(brandDir, 'brand.json'), 'utf8'));

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

function fontFaces(role) {
  const f = brand.font[role];
  const out = [];
  for (const file of f.files) {
    const italic = file.includes('italic');
    const ext = file.includes('latin-ext');
    const stretch = f.axes.wdth ? `\n  font-stretch: ${f.axes.wdth[0]}% ${f.axes.wdth[1]}%;` : '';
    out.push(`@font-face {
  font-family: '${f.family}';
  font-style: ${italic ? 'italic' : 'normal'};
  font-weight: ${f.axes.wght[0]} ${f.axes.wght[1]};${stretch}
  font-display: block;
  src: url('/brand/${file}') format('woff2');
  unicode-range: ${ext ? LATIN_EXT : LATIN};
}`);
  }
  return out.join('\n');
}

const colorVars = Object.entries(brand.color).map(([k, v]) => `  --color-${k}: ${v.value};`).join('\n');
const spaceVars = brand.space.scale.map((s) => `  --space-${s}: ${s}px;`).join('\n');
const radiusVars = Object.entries(brand.radius).map(([k, v]) => `  --radius-${k}: ${v}px;`).join('\n');

const typeClasses = Object.entries(brand.type)
  .filter(([k]) => !k.startsWith('$'))
  .map(([name, t]) => {
    const font = brand.font[t.font];
    const lines = [
      `  font-family: var(--font-${t.font});`,
      `  font-size: ${t.size}px;`,
      `  font-weight: ${t.weight};`,
      `  line-height: ${t.leading};`,
    ];
    if (t.tracking) lines.push(`  letter-spacing: ${t.tracking};`);
    if (t.transform) lines.push(`  text-transform: ${t.transform};`);
    if (t.font === 'display') {
      lines.push(`  font-stretch: ${font.default.stretch};`, `  font-style: ${font.default.style};`, `  text-transform: uppercase;`, `  letter-spacing: ${font.default.tracking};`);
    }
    return `.ts-${name} {\n${lines.join('\n')}\n}`;
  })
  .join('\n');

const css = `/* GENERATED from brand.json by scripts/build-brand-css.mjs. Do not edit by hand. */
/* Brand: ${brand.name} (${brand.status}) v${brand.version} */
${fontFaces('display')}
${fontFaces('text')}

:root {
${colorVars}
  --font-display: '${brand.font.display.family}', sans-serif;
  --font-text: '${brand.font.text.family}', sans-serif;
  --margin: ${brand.space.margin}px;
  --gutter: ${brand.space.gutter}px;
${spaceVars}
${radiusVars}
  --rule-width: ${brand.rule.width}px;
  --rule-thickness: ${brand.rule.thickness}px;
}

/* ---- base: identical for every design ---- */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { margin: 0; background: var(--color-paper); }
body {
  font-family: var(--font-text);
  color: var(--color-graphite);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  font-kerning: normal;
  font-synthesis: none;
  hyphens: manual;
}
[data-artboard] { position: relative; overflow: hidden; background: var(--color-paper); }
img { display: block; max-width: none; }

/* ---- type styles (optional helpers; designs may override size/leading per layer) ---- */
${typeClasses}

/* short green rule from the label */
.brand-rule { display: block; width: var(--rule-width); height: var(--rule-thickness); background: var(--color-green); border-radius: 3px; }

/* ---- image slot: shared placeholder look (empty state) ---- */
[data-type="slot"] { position: relative; overflow: hidden; display: block; }
[data-type="slot"] > img[data-slot-image] { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
[data-type="slot"][data-slot-state="empty"] {
  background-color: var(--color-mist);
  background-image: repeating-linear-gradient(135deg, rgba(60,133,41,0.07) 0 2px, transparent 2px 22px);
}
[data-type="slot"][data-slot-state="empty"]::before {
  content: "";
  position: absolute; inset: 24px;
  border: 2px solid rgba(60,133,41,0.28);
  border-radius: inherit;
}
[data-type="slot"][data-slot-state="empty"]::after {
  content: attr(data-slot-label) "  ·  " attr(data-slot-ratio);
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-family: var(--font-text); font-weight: 700; font-size: 24px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--color-green-deep); white-space: nowrap;
  background: var(--color-paper); padding: 14px 22px; border-radius: var(--radius-pill);
}
`;

fs.writeFileSync(path.join(brandDir, 'brand.css'), css);
console.log(`wrote ${path.join(brandDir, 'brand.css')} (${css.length} bytes)`);
