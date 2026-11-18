// A demo post for the canvas editor without a server (`?demo=post-editor`, headless checks):
// five design-contract slides in a stand-in brand, and an in-memory API that keeps versions
// (the canvas's saves: renders and the Wecra document as in-memory assets) and renders patch
// jobs the worker's way (design-kit patches on the version's HTML).
import {
  type Asset,
  type AssetUploadInput,
  type BrandProfile,
  type Content,
  type ContentVersion,
  type ContentVersionCreate,
  computeContentHash,
  type EditorDocument,
  type Job,
  type Slide,
} from "@studio/contract";
import { applyPatch, type PatchOpInput } from "@studio/design-kit/patch";

const NOW = () => new Date().toISOString();

export const DEMO_TOKENS = {
  id: "demo-agro",
  name: "Demo Agro",
  status: "approved",
  version: "1",
  color: {
    forest: { value: "#2F5D2B", use: "primary dark, backgrounds" },
    leaf: { value: "#7DB462", use: "accent on dark" },
    harvest: { value: "#E8A34A", use: "warm accent" },
    cream: { value: "#F4EFE4", use: "light background" },
    paper: { value: "#FFFFFF", use: "white text, cards" },
    ink: { value: "#1D2A1B", use: "text on light" },
  },
  font: {
    display: {
      family: "Avenir Next",
      files: [],
      fallback: "sans-serif",
      default: { weight: 700, leading: 1.02 },
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
    headline: { font: "display", size: 76, weight: 700, leading: 1.04, tracking: "-0.01em" },
    title: { font: "display", size: 56, weight: 700, leading: 1.08 },
    body: { font: "text", size: 32, weight: 400, leading: 1.4 },
    eyebrow: {
      font: "text",
      size: 26,
      weight: 700,
      leading: 1.2,
      tracking: "0.14em",
      transform: "uppercase",
    },
    caption: { font: "text", size: 24, weight: 500, leading: 1.3, tracking: "0.02em" },
  },
  space: {
    unit: 8,
    margin: 80,
    gutter: 24,
    columns: 6,
    scale: [8, 16, 24, 32, 48, 64, 80, 96, 128],
  },
  radius: { sm: 8, md: 16, lg: 32, pill: 999 },
  rule: { width: 56, thickness: 6, color: "harvest" },
  logos: {},
  usage: {
    background: "cream",
    text: "ink",
    accent: "harvest",
    muted: "forest",
    slotFill: "cream",
    slotInk: "forest",
    textFont: "text",
    displayFont: "display",
  },
};

export const DEMO_PROFILE: BrandProfile = {
  id: "demo-profile",
  brandId: "demo-brand",
  version: 1,
  status: "approved",
  isCurrent: true,
  tokens: DEMO_TOKENS,
  designRules: "",
  voice: "",
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  approvedAt: "2026-11-01T09:00:00.000Z",
};

function page(width: number, height: number, style: string, body: string): string {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="${width}x${height}">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    [data-artboard] { position: relative; background: var(--color-cream); }
    .t-eyebrow { font-family: var(--font-text); font-size: 26px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; margin: 0; }
    .t-head { font-family: var(--font-display); font-size: 76px; font-weight: 700; line-height: 1.04; letter-spacing: -0.01em; margin: 0; text-wrap: balance; }
    .t-body { font-family: var(--font-text); font-size: 32px; line-height: 1.4; margin: 0; }
    .t-num { font-family: var(--font-display); font-size: 150px; font-weight: 800; line-height: 1; margin: 0; letter-spacing: -0.03em; }
    ${style}
  </style>
</head>
<body>
  <main data-artboard style="width:${width}px;height:${height}px">
${body}
  </main>
</body>
</html>`;
}

const FEED = { width: 1080, height: 1350 };

const COVER = page(
  FEED.width,
  FEED.height,
  ".cover { background: linear-gradient(180deg, #E9A65A 0%, #B4642A 55%, #3B1D0C 100%); }",
  `    <div data-layer="background" data-type="shape" data-role="background" class="cover" style="position:absolute;left:0;top:0;width:1080px;height:1350px"></div>
    <p data-layer="brand-name" data-type="text" data-role="eyebrow" class="t-eyebrow" style="position:absolute;left:80px;top:96px;color:var(--color-paper)">Demo Agro</p>
    <h1 data-layer="headline" data-type="text" data-role="headline" class="t-head" style="position:absolute;left:80px;top:700px;width:920px;color:var(--color-paper);font-size:88px">Hasat bitti, toprak dinlenmeye hazır mı?</h1>
    <p data-layer="subhead" data-type="text" data-role="subhead" class="t-body" style="position:absolute;left:80px;top:1040px;width:860px;color:var(--color-paper);opacity:.92">Organik madde ile toprağı kışa hazırla</p>
    <p data-layer="swipe" data-type="text" data-role="cta" class="t-body" style="position:absolute;left:820px;top:1190px;width:180px;text-align:right;color:var(--color-paper);font-weight:600">Kaydır →</p>`,
);

function step(n: string, title: string, body: string, dark: boolean): string {
  const ink = dark ? "var(--color-paper)" : "var(--color-ink)";
  const num = dark ? "var(--color-leaf)" : "var(--color-leaf)";
  return page(
    FEED.width,
    FEED.height,
    dark ? "[data-artboard] { background: var(--color-forest); }" : "",
    `    <div data-layer="background" data-type="shape" data-role="background" style="position:absolute;left:0;top:0;width:1080px;height:1350px;background-color:${dark ? "var(--color-forest)" : "var(--color-cream)"}"></div>
    <p data-layer="number" data-type="text" data-role="decoration" class="t-num" style="position:absolute;left:80px;top:96px;color:${num}">${n}</p>
    <h2 data-layer="title" data-type="text" data-role="headline" class="t-head" style="position:absolute;left:80px;top:300px;width:900px;color:${ink};font-size:64px">${title}</h2>
    <p data-layer="body" data-type="text" data-role="body" class="t-body" style="position:absolute;left:80px;top:470px;width:820px;color:${ink};opacity:.82">${body}</p>
    <div data-layer="rule" data-type="shape" data-role="decoration" style="position:absolute;left:80px;top:1160px;width:920px;height:2px;background-color:${dark ? "var(--color-leaf)" : "var(--color-forest)"};opacity:.4"></div>
    <p data-layer="sign-off" data-type="text" data-role="sign-off" class="t-eyebrow" style="position:absolute;left:80px;top:1200px;font-size:22px;color:${ink}">Demo Agro</p>
    <p data-layer="counter" data-type="text" data-role="counter" class="t-body" style="position:absolute;left:880px;top:1196px;width:120px;text-align:right;font-size:26px;color:${ink}">${n.replace(/^0/, "")}<span class="brand-counter__total"> / 5</span></p>`,
  );
}

const CTA = page(
  FEED.width,
  FEED.height,
  "[data-artboard] { background: var(--color-harvest); }",
  `    <div data-layer="background" data-type="shape" data-role="background" style="position:absolute;left:0;top:0;width:1080px;height:1350px;background-color:var(--color-harvest)"></div>
    <div data-layer="logo-mark" data-type="shape" data-role="decoration" style="position:absolute;left:80px;top:96px;width:96px;height:96px;border-radius:999px;background-color:var(--color-forest)"></div>
    <h2 data-layer="headline" data-type="text" data-role="headline" class="t-head" style="position:absolute;left:80px;top:560px;width:900px;color:var(--color-forest);font-size:84px">Doğru planı birlikte kuralım</h2>
    <p data-layer="body" data-type="text" data-role="body" class="t-body" style="position:absolute;left:80px;top:820px;width:820px;color:var(--color-forest)">Size en yakın bayi toprak analizinizi ücretsiz yorumlar.</p>
    <p data-layer="cta" data-type="text" data-role="cta" class="t-body" style="position:absolute;left:80px;top:980px;padding:18px 36px;border-radius:999px;background-color:var(--color-forest);color:var(--color-paper);font-weight:600">demoagro.com.tr</p>`,
);

const STORY = page(
  1080,
  1920,
  ".story { background: linear-gradient(180deg, #F1B66E 0%, #C26A2C 55%, #2A1407 100%); }",
  `    <div data-layer="background" data-type="shape" data-role="background" class="story" style="position:absolute;left:0;top:0;width:1080px;height:1920px"></div>
    <p data-layer="brand-name" data-type="text" data-role="eyebrow" class="t-eyebrow" style="position:absolute;left:80px;top:300px;color:var(--color-paper)">Demo Agro</p>
    <h1 data-layer="headline" data-type="text" data-role="headline" class="t-head" style="position:absolute;left:80px;top:1000px;width:900px;color:var(--color-paper);font-size:104px">Kış öncesi toprak bakım kiti</h1>
    <p data-layer="subhead" data-type="text" data-role="subhead" class="t-body" style="position:absolute;left:80px;top:1260px;width:900px;color:var(--color-paper)">Bayilerde 30 Kasım'a kadar</p>
    <p data-layer="cta" data-type="text" data-role="cta" class="t-body" style="position:absolute;left:285px;top:1750px;width:510px;text-align:center;font-size:44px;font-weight:600;color:var(--color-paper)">Kaydır, teklifi gör ↑</p>`,
);

export const DEMO_SLIDES = {
  carousel: [
    COVER,
    step(
      "01",
      "Toprak analizi yaptır",
      "Hasattan sonra pH ve organik madde ölçümüyle başlayın. Doğru gübre planı buradan çıkar.",
      false,
    ),
    step(
      "02",
      "Organik madde ekle",
      "Ahır gübresi ya da kompost, toprağın su tutma kapasitesini artırır ve kışın erozyonu azaltır.",
      true,
    ),
    step(
      "03",
      "Örtü bitkisi ek",
      "Fiğ ve çavdar kış boyunca toprağı örter, bahara azot bırakır.",
      false,
    ),
    CTA,
  ],
  story: [STORY],
};

export async function demoPost(
  format: "carousel" | "story",
): Promise<{ content: Content; version: ContentVersion }> {
  const html = DEMO_SLIDES[format];
  const slides: Slide[] = html.map((h) => ({
    html: h,
    width: 1080,
    height: format === "story" ? 1920 : 1350,
    renderedAssetId: null,
    layers: null,
  }));
  const hash = await computeContentHash(slides);
  const version: ContentVersion = {
    id: "demo-v1",
    contentId: "demo-post",
    version: 1,
    origin: "generated",
    contentHash: hash,
    slideCount: slides.length,
    note: null,
    jobId: null,
    createdAt: NOW(),
    updatedAt: NOW(),
    slides,
  };
  const content: Content = {
    id: "demo-post",
    brandId: "demo-brand",
    type: format,
    title: format === "story" ? "Kış kiti hikâyesi" : "Hasat sonrası toprak bakımı",
    brief: "Hasattan sonra toprak bakımı",
    status: "draft",
    targetPlatforms: ["instagram", "facebook"],
    caption:
      "Hasat bitti ama iş bitmedi. Toprağını kışa hazırlamanın tam zamanı.\n\nOrganik madde ile toprak yapısını güçlendir, ilkbaharda verimi artır. Kaydırarak adımları gör →\n\n#hasat #toprakbakımı #organikgübre",
    currentVersion: { id: version.id, version: 1, contentHash: hash },
    approval: null,
    createdAt: NOW(),
    updatedAt: NOW(),
  };
  return { content, version };
}

/** The editor's API in memory: renders apply the patches with design-kit, as the worker does. */
export class DemoApi {
  private versions: ContentVersion[];
  private jobs = new Map<string, Job>();
  private next = 1;
  readonly log: { type: string; payload: unknown }[] = [];

  constructor(
    private content: Content,
    first: ContentVersion,
  ) {
    this.versions = [first];
  }

  readonly assets = new Map<string, { asset: Asset; blob: Blob; url?: string }>();

  private async newVersion(
    slides: Slide[],
    origin: ContentVersion["origin"],
    note: string | null,
    editorDocument: EditorDocument | null = null,
  ) {
    const n = Math.max(...this.versions.map((v) => v.version)) + 1;
    const hash = await computeContentHash(slides);
    const v: ContentVersion = {
      editorDocument,
      id: `demo-v${n}`,
      contentId: this.content.id,
      version: n,
      origin,
      contentHash: hash,
      slideCount: slides.length,
      note,
      jobId: null,
      createdAt: NOW(),
      updatedAt: NOW(),
      slides,
    };
    this.versions.push(v);
    this.content = {
      ...this.content,
      status: "draft",
      approval: null,
      currentVersion: { id: v.id, version: n, contentHash: hash },
      updatedAt: NOW(),
    };
    return v;
  }

  client = {
    contents: {
      get: async () => this.content,
      update: async (_id: string, input: { caption?: string }) => {
        this.content = { ...this.content, ...input, status: "draft", approval: null };
        return this.content;
      },
      approve: async (_id: string, hash: string) => {
        if (this.content.currentVersion?.contentHash !== hash) throw new Error("Sürüm değişti.");
        this.content = {
          ...this.content,
          status: "approved",
          approval: {
            versionId: this.content.currentVersion.id,
            contentHash: hash,
            approvedAt: NOW(),
          },
        };
        return this.content;
      },
      versions: {
        get: async (_id: string, n: number) => {
          const v = this.versions.find((x) => x.version === n);
          if (!v) throw new Error("Sürüm yok.");
          return v;
        },
        list: async () => ({
          items: this.versions.map(({ slides: _s, ...summary }) => summary),
          nextCursor: null,
        }),
        restore: async (_id: string, n: number) => {
          const v = this.versions.find((x) => x.version === n) as ContentVersion;
          return this.newVersion(
            v.slides,
            v.origin,
            `v${n} geri yüklendi.`,
            v.editorDocument ?? null,
          );
        },
        create: async (_id: string, input: ContentVersionCreate) => {
          this.log.push({ type: "versions.create", payload: input });
          const slides: Slide[] = input.slides.map((s, i) => ({
            ...s,
            renderedAssetId: input.renderedAssetIds?.[i] ?? null,
            layers: null,
          }));
          return this.newVersion(
            slides,
            input.origin,
            input.note ?? null,
            input.editorDocument ?? null,
          );
        },
      },
    },
    jobs: {
      create: async (input: { type: string; payload?: Record<string, unknown> }) => {
        const payload = input.payload ?? {};
        this.log.push({ type: input.type, payload });
        const id = `demo-job-${this.next++}`;
        let output: Record<string, unknown> = {};
        let status: Job["status"] = "succeeded";
        let error: string | null = null;
        await new Promise((r) => setTimeout(r, 450));
        try {
          if (input.type === "content.render" && Array.isArray(payload.patches)) {
            const base = this.versions.find((v) => v.version === payload.version) as ContentVersion;
            const slides = base.slides.map((s) => ({ ...s }));
            for (const raw of payload.patches as (PatchOpInput & { slide: number })[]) {
              const { slide, ...op } = raw;
              const target = slides[slide] as Slide;
              target.html = applyPatch(target.html, op as PatchOpInput).html;
            }
            const note =
              typeof payload.note === "string"
                ? payload.note
                : `${(payload.patches as unknown[]).length} katman yaması.`;
            output = { version: (await this.newVersion(slides, "manual_edit", note)).version };
          } else if (input.type === "content.check") {
            output = { checked: payload.version };
          } else if (input.type === "content.generate") {
            status = "failed";
            error = "Demo: AI düzenlemesi için Mac'teki işçi gerekir.";
          }
        } catch (e) {
          status = "failed";
          error = e instanceof Error ? e.message : String(e);
        }
        const job = {
          id,
          type: input.type,
          status,
          output,
          error,
          progressMessage: null,
        } as unknown as Job;
        this.jobs.set(id, job);
        return job;
      },
      get: async (id: string) => this.jobs.get(id) as Job,
      cancel: async (id: string) => this.jobs.get(id) as Job,
    },
    assets: {
      upload: async (input: AssetUploadInput) => {
        const id = `demo-asset-${this.next++}`;
        const asset = {
          id,
          brandId: input.brandId,
          kind: input.kind ?? "image",
          source: input.source ?? "upload",
          objectKey: `demo/${id}`,
          mimeType: input.file.type,
          bytes: input.file.size,
          sha256: "",
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: null,
          originalFilename: input.filename ?? null,
          createdAt: NOW(),
        } as Asset;
        this.assets.set(id, { asset, blob: input.file });
        return asset;
      },
      contentUrl: (id: string) => {
        const entry = this.assets.get(id);
        if (!entry) return `/api/assets/${encodeURIComponent(id)}/content`;
        entry.url ??= URL.createObjectURL(entry.blob);
        return entry.url;
      },
    },
    brandProfiles: {
      current: async () => DEMO_PROFILE,
    },
  };
}
