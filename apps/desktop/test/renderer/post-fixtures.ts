// Posts fixtures: contents, versions with real slide HTML (layers, a slot), schedules, plans,
// accounts, and a small in-memory API for the editor and the schedule sheet.
import { webcrypto } from "node:crypto";
import {
  type Content,
  type ContentVersion,
  type ContentVersionSummary,
  computeContentHash,
  type Job,
  type Plan,
  type Schedule,
  type SchedulePreflight,
  type Slide,
  type SocialAccount,
} from "@studio/contract";

// jsdom has no SubtleCrypto; the approval hash needs it.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

export const T = "2026-11-17T10:00:00.000Z";
export const HASH0 = "0".repeat(64);

export const SLIDE_HTML = `<!doctype html><html><body><main data-artboard>
<div data-layer="bg" data-type="shape" data-role="background"></div>
<h1 data-layer="headline" data-type="text" style="color: #ffffff">Hasat bitti,<br>toprak hazır mı?</h1>
<p data-layer="sub" data-type="text" style="translate: 12px -8px; scale: 1.1">Organik madde &amp; kış</p>
<figure data-layer="photo" data-type="slot" data-slot-state="empty" data-slot-ratio="4:5" data-slot-label="Ürün fotoğrafı"></figure>
<img data-layer="logo" data-type="logo" src="/media/logo.png">
<span data-layer="old" data-type="text" data-hidden>Gizli</span>
</main></body></html>`;

export const FILLED_HTML = SLIDE_HTML.replace(
  '<figure data-layer="photo" data-type="slot" data-slot-state="empty" data-slot-ratio="4:5" data-slot-label="Ürün fotoğrafı"></figure>',
  '<figure data-layer="photo" data-type="slot" data-slot-state="filled"><img data-slot-image src="/media/a1.jpg"></figure>',
);

export function slide(over: Partial<Slide> = {}): Slide {
  return {
    html: FILLED_HTML,
    width: 1080,
    height: 1350,
    renderedAssetId: "r1",
    layers: [
      {
        id: "bg",
        type: "shape",
        role: "background",
        parent: null,
        x: 0,
        y: 0,
        w: 1080,
        h: 1350,
        visible: true,
      },
      {
        id: "headline",
        type: "text",
        role: null,
        parent: null,
        x: 80,
        y: 900,
        w: 800,
        h: 200,
        visible: true,
      },
      {
        id: "sub",
        type: "text",
        role: null,
        parent: null,
        x: 80,
        y: 1150,
        w: 600,
        h: 60,
        visible: true,
      },
      {
        id: "photo",
        type: "slot",
        role: null,
        parent: null,
        x: 0,
        y: 0,
        w: 1080,
        h: 800,
        visible: true,
      },
    ],
    ...over,
  };
}

export function version(
  contentId: string,
  n: number,
  slides: Slide[] = [slide()],
  over: Partial<ContentVersion> = {},
): ContentVersion {
  return {
    id: `${contentId}-v${n}`,
    contentId,
    version: n,
    origin: n === 1 ? "generated" : "manual_edit",
    contentHash: HASH0,
    slideCount: slides.length,
    note: null,
    jobId: null,
    createdAt: T,
    updatedAt: T,
    slides,
    ...over,
  };
}

/** A version whose `contentHash` is the real hash of its slides. */
export async function hashedVersion(
  contentId: string,
  n: number,
  slides: Slide[] = [slide()],
): Promise<ContentVersion> {
  const v = version(contentId, n, slides);
  return { ...v, contentHash: await computeContentHash(slides) };
}

export function content(over: Partial<Content> = {}): Content {
  return {
    id: "p1",
    brandId: "b1",
    type: "post",
    title: "Hasat sonrası toprak bakımı",
    brief: "Hasattan sonra toprak",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "Hasat bitti ama iş bitmedi.\n\n#hasat #toprak",
    currentVersion: null,
    approval: null,
    createdAt: "2026-11-02T09:00:00.000Z",
    updatedAt: T,
    ...over,
  };
}

/** Content whose current version ref points at `v` (same hash). */
export function contentFor(v: ContentVersion, over: Partial<Content> = {}): Content {
  return content({
    id: v.contentId,
    currentVersion: { id: v.id, version: v.version, contentHash: v.contentHash },
    ...over,
  });
}

export function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    contentId: "p1",
    brandId: "b1",
    platform: "instagram",
    socialAccountId: "a1",
    versionId: "p1-v1",
    contentHash: HASH0,
    scheduledAt: "2026-11-18T07:00:00.000Z",
    status: "pending",
    permalink: null,
    delivery: null,
    cloudSyncedAt: null,
    lastError: null,
    cancelledAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function account(over: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "a1",
    brandId: "b1",
    platform: "instagram",
    handle: "@mtmagro",
    externalId: null,
    status: "connected",
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function plan(items: { contentId: string; date: string; pillar?: string }[]): Plan {
  return {
    id: "pl1",
    brandId: "b1",
    conversationId: null,
    status: "accepted",
    revision: 1,
    title: "Kasım planı",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    notes: null,
    items: items.map((item, position) => ({
      id: `it${position}`,
      planId: "pl1",
      position,
      date: item.date,
      platforms: ["instagram"],
      contentType: "post",
      title: "x",
      brief: "",
      pillar: item.pillar ?? null,
      imageSlot: "none",
      imageBrief: null,
      status: "accepted",
      contentId: item.contentId,
      generation: null,
      createdAt: T,
      updatedAt: T,
    })),
    createdAt: T,
    updatedAt: T,
  } as unknown as Plan;
}

export function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    type: "content.render",
    status: "succeeded",
    payload: {},
    brandId: "b1",
    contentId: "p1",
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function summary(v: ContentVersion): ContentVersionSummary {
  const { slides: _slides, ...rest } = v;
  return rest;
}

export function preflight(over: Partial<SchedulePreflight> = {}): SchedulePreflight {
  return { mode: "local", ok: true, errors: [], targets: [], ...over };
}

/**
 * In-memory contents / versions / jobs for the editor: `content.render` with patches makes a
 * new version (its slides marked with the ops), `content.generate` an AI version, restore
 * copies a version.
 */
export class FakeContentApi {
  contents = new Map<string, Content>();
  versions = new Map<string, ContentVersion[]>();
  jobs = new Map<string, Job>();
  createdJobs: { type: string; payload: Record<string, unknown> }[] = [];
  approveCalls: { id: string; hash: string; acknowledgeChecks?: true }[] = [];
  updateCalls: { id: string; input: unknown }[] = [];
  failNextJob: string | null = null;
  private nextJob = 1;

  add(c: Content, versions: ContentVersion[]): void {
    this.contents.set(c.id, c);
    this.versions.set(c.id, versions);
  }

  private newVersion(contentId: string, slides: Slide[], origin: ContentVersion["origin"]) {
    const list = this.versions.get(contentId) ?? [];
    const n = Math.max(0, ...list.map((v) => v.version)) + 1;
    const v = version(contentId, n, slides, {
      origin,
      contentHash: `${n}`.repeat(64).slice(0, 64),
    });
    this.versions.set(contentId, [...list, v]);
    const c = this.contents.get(contentId);
    if (c) {
      this.contents.set(contentId, {
        ...c,
        status: "draft",
        approval: null,
        currentVersion: { id: v.id, version: n, contentHash: v.contentHash },
      });
    }
    return v;
  }

  api = {
    contents: {
      get: async (id: string) => {
        const c = this.contents.get(id);
        if (!c) throw new Error("/api/contents: not found");
        return c;
      },
      update: async (id: string, input: { caption?: string }) => {
        this.updateCalls.push({ id, input });
        const c = this.contents.get(id) as Content;
        const next = { ...c, ...input, status: "draft" as const, approval: null };
        this.contents.set(id, next);
        return next;
      },
      approve: async (
        id: string,
        input: string | { hash: string; acknowledgeChecks?: boolean },
      ) => {
        const hash = typeof input === "string" ? input : input.hash;
        this.approveCalls.push(
          typeof input === "object" && input.acknowledgeChecks
            ? { id, hash, acknowledgeChecks: true }
            : { id, hash },
        );
        const c = this.contents.get(id) as Content;
        if (c.currentVersion?.contentHash !== hash) throw new Error("/api/contents: hash mismatch");
        const next: Content = {
          ...c,
          status: "approved",
          approval: { versionId: c.currentVersion.id, contentHash: hash, approvedAt: T },
        };
        this.contents.set(id, next);
        return next;
      },
      versions: {
        get: async (contentId: string, n: number) => {
          const v = this.versions.get(contentId)?.find((x) => x.version === n);
          if (!v) throw new Error("/api/versions: not found");
          return v;
        },
        list: async (contentId: string) => ({
          items: (this.versions.get(contentId) ?? []).map(summary),
          nextCursor: null,
        }),
        restore: async (contentId: string, n: number) => {
          const v = this.versions.get(contentId)?.find((x) => x.version === n) as ContentVersion;
          return this.newVersion(contentId, v.slides, v.origin);
        },
      },
    },
    jobs: {
      create: async (input: {
        type: string;
        contentId?: string;
        payload?: Record<string, unknown>;
      }) => {
        const payload = input.payload ?? {};
        this.createdJobs.push({ type: input.type, payload });
        const id = `job${this.nextJob++}`;
        const contentId = input.contentId as string;
        let output: Record<string, unknown> = {};
        let status: Job["status"] = "succeeded";
        let error: string | undefined;
        if (this.failNextJob) {
          status = "failed";
          error = this.failNextJob;
          this.failNextJob = null;
        } else if (input.type === "content.render" && Array.isArray(payload.patches)) {
          const base = this.versions
            .get(contentId)
            ?.find((v) => v.version === payload.version) as ContentVersion;
          const ops = (payload.patches as { op: string }[]).map((p) => p.op).join(",");
          const slides = base.slides.map((s) => ({ ...s, html: `${s.html}<!--${ops}-->` }));
          output = { version: this.newVersion(contentId, slides, "manual_edit").version };
        } else if (input.type === "content.render" && payload.reel) {
          // Reels: the worker re-renders from the patched spec (here: the slides, marked).
          const base = this.versions
            .get(contentId)
            ?.find((v) => v.version === payload.version) as ContentVersion;
          const slides = base.slides.map((s) => ({ ...s, html: `${s.html}<!--reel-->` }));
          output = { version: this.newVersion(contentId, slides, "manual_edit").version };
        } else if (input.type === "content.generate") {
          const base = this.versions
            .get(contentId)
            ?.find((v) => v.version === payload.baseVersion) as ContentVersion;
          const slides = base.slides.map((s) => ({ ...s, html: `${s.html}<!--ai-->` }));
          output = { version: this.newVersion(contentId, slides, "ai_edit").version };
        }
        const j = job({
          id,
          type: input.type as Job["type"],
          status,
          contentId,
          output,
          ...(error ? { error } : {}),
        });
        this.jobs.set(id, j);
        return { ...j, status: "queued" as const };
      },
      get: async (id: string) => this.jobs.get(id) as Job,
      cancel: async (id: string) => this.jobs.get(id) as Job,
    },
    assets: {
      upload: async () => ({ id: "up1", mimeType: "image/png" }),
    },
  };
}
