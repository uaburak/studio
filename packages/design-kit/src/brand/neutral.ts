/**
 * The neutral default the Mac worker renders with when a brand has no approved profile (or its
 * tokens do not parse): system fonts present on every Mac, quiet colours, no logo. The editor
 * builds the same brand.css from it, so its live canvas matches the worker's render.
 * (A copy of apps/worker/src/generate/brand.ts NEUTRAL_TOKENS; keep the two equal.)
 */
export const NEUTRAL_BRAND_TOKENS = {
  id: "neutral-default",
  name: "Nötr varsayılan",
  status: "neutral-default",
  version: "0",
  color: {
    paper: { value: "#FFFFFF", use: "default background" },
    mist: { value: "#F1F1EE", use: "secondary background, panels, empty slots" },
    ink: { value: "#151515", use: "headlines, primary text" },
    graphite: { value: "#2E2E2E", use: "body text" },
    stone: { value: "#666666", use: "secondary text (>= 28px)" },
    line: { value: "#D9D9D6", use: "hairlines" },
    accent: { value: "#2F5D50", use: "the single accent: rules, bands, large type" },
    "accent-deep": { value: "#22453B", use: "accent text on light, background for white text" },
  },
  font: {
    display: {
      family: "Helvetica Neue",
      files: [],
      fallback: "sans-serif",
      default: { weight: 700, leading: 1.0 },
    },
    text: {
      family: "Helvetica Neue",
      files: [],
      fallback: "sans-serif",
      default: { weight: 400, leading: 1.38 },
    },
  },
  type: {
    "display-l": { font: "display", size: 120, weight: 800, leading: 0.98, tracking: "-0.02em" },
    "display-m": { font: "display", size: 88, weight: 800, leading: 1.0, tracking: "-0.015em" },
    headline: { font: "display", size: 72, weight: 700, leading: 1.04, tracking: "-0.01em" },
    title: { font: "text", size: 52, weight: 700, leading: 1.1 },
    "body-l": { font: "text", size: 36, weight: 400, leading: 1.34 },
    body: { font: "text", size: 30, weight: 400, leading: 1.4 },
    eyebrow: {
      font: "text",
      size: 26,
      weight: 700,
      leading: 1.2,
      tracking: "0.12em",
      transform: "uppercase",
    },
    caption: { font: "text", size: 24, weight: 500, leading: 1.3, tracking: "0.02em" },
  },
  space: {
    unit: 8,
    margin: 72,
    gutter: 24,
    columns: 6,
    scale: [8, 16, 24, 32, 48, 64, 72, 96, 128, 160],
  },
  radius: { sm: 8, md: 16, lg: 32, pill: 999 },
  rule: { width: 56, thickness: 6, color: "accent" },
  logos: {},
  usage: {
    background: "paper",
    text: "ink",
    accent: "accent",
    muted: "stone",
    slotFill: "mist",
    slotInk: "accent-deep",
    textFont: "text",
    displayFont: "display",
  },
} as const;
