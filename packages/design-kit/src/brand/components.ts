/**
 * Brand components: small, tested CSS + layer-markup recipes that brand.css ships, so a
 * generated design uses a known-good badge or sign-off instead of rebuilding it (the spike
 * model built the badge wrong in two of four first attempts: the letter was painted under
 * its shape). Each component documents its markup with an `example()` that the test suite
 * renders and lints.
 */
import { parseStylesheet, urlReferences, walkDeclarations } from "../html/css.ts";
import type { BrandTokens, ResolvedUsage } from "./tokens.ts";

export interface ComponentContext {
  tokens: BrandTokens;
  usage: ResolvedUsage;
  /** Colour token names. */
  colors: string[];
  /** First logo made for light backgrounds (or any logo), for examples. */
  logo: { name: string; path: string; aspect: number } | null;
}

export interface ComponentExampleOptions {
  /** Layer id of the component's root layer; child ids are derived from it. */
  id: string;
  left: number;
  top: number;
}

export interface BrandComponent {
  /** kebab-case; classes are `brand-<name>` and `brand-<name>__part`. */
  name: string;
  /** One or two sentences for generation prompts. */
  description: string;
  /** CSS rules. Must not reference any URL. */
  css(ctx: ComponentContext): string;
  /** Layer markup using the component (contract-conformant, positioned absolutely). */
  example(ctx: ComponentContext, options: ComponentExampleOptions): string;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function defineComponent(component: BrandComponent): BrandComponent {
  if (!NAME.test(component.name))
    throw new Error(`component name "${component.name}" must be kebab-case`);
  return component;
}

/** Ordered set of components that brand.css includes. */
export class ComponentRegistry {
  readonly #items = new Map<string, BrandComponent>();

  constructor(components: readonly BrandComponent[] = []) {
    for (const c of components) this.register(c);
  }

  /** Add or replace a component (a brand can override a built-in by name). */
  register(component: BrandComponent): this {
    defineComponent(component);
    this.#items.set(component.name, component);
    return this;
  }

  unregister(name: string): this {
    this.#items.delete(name);
    return this;
  }

  get(name: string): BrandComponent | undefined {
    return this.#items.get(name);
  }

  list(): BrandComponent[] {
    return [...this.#items.values()];
  }

  clone(): ComponentRegistry {
    return new ComponentRegistry(this.list());
  }
}

/** Render a component's CSS and check it is self-contained (no URLs, parsable). */
export function componentCss(component: BrandComponent, ctx: ComponentContext): string {
  const css = component.css(ctx).trim();
  const sheet = parseStylesheet(css);
  for (const { decl } of walkDeclarations(sheet.rules)) {
    const refs = urlReferences(decl.tokens);
    if (refs.urls.length || refs.bad || refs.dynamic)
      throw new Error(
        `component "${component.name}" must not reference URLs (found in "${decl.name}")`,
      );
  }
  if (/@import|@font-face/i.test(css))
    throw new Error(`component "${component.name}" must not use @import or @font-face`);
  return css;
}

const HEXAGON = "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";

export const ruleComponent = defineComponent({
  name: "rule",
  description:
    "Short accent rule under an eyebrow or section title: a shape layer with class `brand-rule`.",
  css: () =>
    `.brand-rule { display: block; width: var(--rule-width); height: var(--rule-thickness); background: var(--rule-color); border-radius: 3px; }`,
  example: (_ctx, o) =>
    `<div data-layer="${o.id}" data-type="shape" data-role="decoration" class="brand-rule" style="position:absolute; left:${o.left}px; top:${o.top}px"></div>`,
});

export const badgeComponent = defineComponent({
  name: "badge",
  description:
    "Element/feature badge: a group (`brand-badge`, tone modifier `brand-badge--<colour>`) holding a shape layer (`brand-badge__shape`) and a text layer (`brand-badge__label`). The label is stacked above the shape by the component; do not restyle the stacking.",
  css: (ctx) => {
    const b = ctx.tokens.components?.badge ?? {};
    const shape = b.shape ?? "hexagon";
    const size = b.size ?? 104;
    const aspect = shape === "hexagon" ? 1.1547 : shape === "pill" ? 2 : 1;
    const clip =
      shape === "hexagon"
        ? `clip-path: ${HEXAGON};`
        : shape === "circle"
          ? "border-radius: 50%;"
          : shape === "pill"
            ? "border-radius: 999px;"
            : "";
    const ink = b.ink && ctx.colors.includes(b.ink) ? b.ink : ctx.usage.text;
    const tones = ctx.colors
      .map((c) => `.brand-badge--${c} { --badge-fill: var(--color-${c}); }`)
      .join("\n");
    return `.brand-badge { position: relative; display: grid; place-items: center; width: var(--badge-size, ${size}px); height: calc(var(--badge-size, ${size}px) / ${aspect}); --badge-fill: var(--color-${ctx.usage.accent}); }
.brand-badge > * { grid-area: 1 / 1; }
.brand-badge__shape { position: relative; z-index: 0; width: 100%; height: 100%; background: var(--badge-fill); ${clip} }
.brand-badge__label { position: relative; z-index: 1; font-family: var(--font-${ctx.usage.textFont}); font-size: var(--badge-font-size, ${b.fontSize ?? 40}px); font-weight: 700; line-height: 1; letter-spacing: 0; text-align: center; white-space: nowrap; color: var(--badge-ink, var(--color-${ink})); }
${tones}`;
  },
  example: (ctx, o) => {
    const tone = ctx.colors.includes("amber") ? "amber" : ctx.usage.accent;
    return `<div data-layer="${o.id}" data-type="group" data-role="badge" class="brand-badge brand-badge--${tone}" style="position:absolute; left:${o.left}px; top:${o.top}px">
  <div data-layer="${o.id}-shape" data-type="shape" data-role="decoration" class="brand-badge__shape"></div>
  <p data-layer="${o.id}-label" data-type="text" data-role="badge" class="brand-badge__label">B</p>
</div>`;
  },
});

export const signOffComponent = defineComponent({
  name: "sign-off",
  description:
    "Logo + web address row at the same place on every post: a group (`brand-sign-off`, role `sign-off`) with a logo layer (`brand-sign-off__logo`) and a text layer (`brand-sign-off__text`). Give the group left/top/width.",
  css: (ctx) => {
    const s = ctx.tokens.components?.signOff ?? {};
    return `.brand-sign-off { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.brand-sign-off__logo { flex: none; width: auto; height: var(--sign-off-logo-height, ${s.logoHeight ?? 40}px); }
.brand-sign-off__text { font-family: var(--font-${ctx.usage.textFont}); font-size: ${s.fontSize ?? 28}px; font-weight: 500; line-height: 1.3; letter-spacing: 0.02em; white-space: nowrap; color: var(--color-${ctx.usage.text}); }`;
  },
  example: (ctx, o) => {
    const logo = ctx.logo
      ? `\n  <img data-layer="${o.id}-logo" data-type="logo" class="brand-sign-off__logo" src="/brand/${ctx.logo.path}" alt="${ctx.tokens.name ?? "logo"}">`
      : "";
    return `<div data-layer="${o.id}" data-type="group" data-role="sign-off" class="brand-sign-off" style="position:absolute; left:${o.left}px; top:${o.top}px; width:936px">${logo}
  <p data-layer="${o.id}-web" data-type="text" data-role="caption" class="brand-sign-off__text">www.example.com</p>
</div>`;
  },
});

export const bandComponent = defineComponent({
  name: "band",
  description:
    "Full-width accent band (`brand-band`, a shape layer); `brand-band--tab` adds the raised centre tab. Give it left/top/width/height; it may bleed to the edges.",
  css: (ctx) => {
    const b = ctx.tokens.components?.band ?? {};
    return `.brand-band { display: block; background: var(--band-fill, var(--color-${ctx.usage.accent})); }
.brand-band--tab { overflow: visible; }
.brand-band--tab::before { content: ""; position: absolute; left: 50%; bottom: 100%; width: var(--band-tab-width, ${b.tabWidth ?? 144}px); height: var(--band-tab-height, ${b.tabHeight ?? 12}px); translate: -50% 0; background: inherit; border-radius: 12px 12px 0 0; }`;
  },
  example: (ctx, o) => {
    const h = ctx.tokens.components?.band?.height ?? 24;
    return `<div data-layer="${o.id}" data-type="shape" data-role="decoration" class="brand-band brand-band--tab" style="position:absolute; left:${o.left}px; top:${o.top}px; width:1080px; height:${h}px"></div>`;
  },
});

export const counterComponent = defineComponent({
  name: "counter",
  description:
    'Carousel counter (`brand-counter`, text layer with role `counter`): `2<span class="brand-counter__total"> / 5</span>`. Same position on every slide.',
  css: (ctx) => {
    const c = ctx.tokens.components?.counter ?? {};
    const muted = c.muted && ctx.colors.includes(c.muted) ? c.muted : ctx.usage.muted;
    return `.brand-counter { font-family: var(--font-${ctx.usage.textFont}); font-size: ${c.fontSize ?? 26}px; font-weight: 700; line-height: 1.2; letter-spacing: 0.08em; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--color-${ctx.usage.text}); }
.brand-counter__total { color: var(--color-${muted}); }`;
  },
  example: (_ctx, o) =>
    `<p data-layer="${o.id}" data-type="text" data-role="counter" class="brand-counter" style="position:absolute; left:${o.left}px; top:${o.top}px">1<span class="brand-counter__total"> / 3</span></p>`,
});

export const BUILT_IN_COMPONENTS: readonly BrandComponent[] = [
  ruleComponent,
  badgeComponent,
  signOffComponent,
  bandComponent,
  counterComponent,
];

export function createComponentRegistry(
  components: readonly BrandComponent[] = BUILT_IN_COMPONENTS,
): ComponentRegistry {
  return new ComponentRegistry(components);
}
