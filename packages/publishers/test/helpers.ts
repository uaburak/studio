import type { PublishRequest, PublishState, StepContext, StepOutcome } from "../src/index.ts";
import { createFakeEnv, type FakeEnvOptions, memoryMediaReader } from "../src/testing/index.ts";

// Fake tokens shaped like Meta tokens so the pattern-based redaction is exercised too.
export const USER_TOKEN = `EAAuser${"A".repeat(40)}`;
export const PAGE_TOKEN = `EAApage${"B".repeat(40)}`;
export const IG = "17841400000000001";
export const PAGE = "100200300400500";

export const VIDEO_BYTES = new Uint8Array(10_000).map((_, i) => i % 251);

export function setup(options: FakeEnvOptions = {}) {
  const env = createFakeEnv(options);
  env.fake.addUserToken(USER_TOKEN);
  env.fake.addPage(PAGE, PAGE_TOKEN, { igUserId: IG, name: "MTM Agro" });
  const media = memoryMediaReader({ "videos/reel.mp4": VIDEO_BYTES });
  const igCtx: StepContext = { accessToken: USER_TOKEN, media };
  const fbCtx: StepContext = { accessToken: PAGE_TOKEN, media };
  const ctxFor = (r: { kind: string }) => (r.kind.startsWith("instagram.") ? igCtx : fbCtx);
  return { ...env, media, igCtx, fbCtx, ctxFor };
}

export type Env = ReturnType<typeof setup>;

/** Drive a state to completion, recording every outcome. Sleeping advances the fake clock. */
export async function drive(env: Env, state: PublishState, ctx: StepContext, maxSteps = 200) {
  const outcomes: StepOutcome<PublishState>[] = [];
  let s = state;
  for (let i = 0; i < maxSteps; i++) {
    const out = await env.publisher.step(s, ctx);
    outcomes.push(out);
    // Persist = JSON round trip, exactly what a durable workflow would do.
    s = JSON.parse(JSON.stringify(out.state)) as PublishState;
    if (out.status === "done" || out.status === "failed") return { out, outcomes, state: s };
    if (out.status === "wait") env.clock.advance(Math.max(0, out.resumeAt - env.clock.now()));
  }
  throw new Error("drive: too many steps");
}

const jpg = (n: number, w = 1080, h = 1350) => ({
  kind: "image" as const,
  url: `https://media.example.com/post-${n}.jpg`,
  mimeType: "image/jpeg",
  width: w,
  height: h,
  bytes: 400_000,
});

const urlVideo = (seconds: number, w = 1080, h = 1920) => ({
  kind: "video" as const,
  source: { type: "url" as const, url: "https://media.example.com/reel.mp4" },
  mimeType: "video/mp4",
  width: w,
  height: h,
  bytes: 20_000_000,
  durationMs: seconds * 1000,
  frameRate: 30,
});

const pushedVideo = (seconds: number) => ({
  kind: "video" as const,
  source: { type: "upload" as const, key: "videos/reel.mp4" },
  mimeType: "video/mp4",
  width: 1080,
  height: 1920,
  bytes: VIDEO_BYTES.length,
  durationMs: seconds * 1000,
  frameRate: 30,
});

export const requests = {
  igImage: (): PublishRequest => ({
    kind: "instagram.image",
    igUserId: IG,
    image: { ...jpg(1), altText: "Tarlada buğday başakları" },
    caption: "Hasat zamanı #tarım #buğday @mtmagro",
    collaborators: ["partner.brand"],
    isAiGenerated: true,
  }),
  igCarousel: (): PublishRequest => ({
    kind: "instagram.carousel",
    igUserId: IG,
    items: [jpg(1), jpg(2), { ...urlVideo(20, 1080, 1350) }],
    caption: "Üç adımda ekim",
    isAiGenerated: true,
  }),
  igReelUrl: (): PublishRequest => ({
    kind: "instagram.reel",
    igUserId: IG,
    video: urlVideo(30),
    caption: "Reels deneme",
    shareToFeed: true,
    thumbOffsetMs: 2000,
    trial: { graduationStrategy: "SS_PERFORMANCE" },
  }),
  igReelUpload: (): PublishRequest => ({
    kind: "instagram.reel",
    igUserId: IG,
    video: pushedVideo(30),
    caption: "Yüklenen Reels",
  }),
  igStoryImage: (): PublishRequest => ({
    kind: "instagram.story",
    igUserId: IG,
    media: jpg(9, 1080, 1920),
  }),
  igStoryVideo: (): PublishRequest => ({
    kind: "instagram.story",
    igUserId: IG,
    media: urlVideo(15),
  }),
  fbPhoto: (): PublishRequest => ({
    kind: "facebook.photo",
    pageId: PAGE,
    image: { ...jpg(1), altText: "Ürün fotoğrafı" },
    caption: "Yeni ürün",
  }),
  fbMultiPhoto: (): PublishRequest => ({
    kind: "facebook.multi_photo",
    pageId: PAGE,
    images: [jpg(1), jpg(2), jpg(3)],
    message: "Fuardan kareler",
  }),
  fbVideoUrl: (): PublishRequest => ({
    kind: "facebook.video",
    pageId: PAGE,
    video: urlVideo(120, 1920, 1080),
    title: "Tanıtım",
    description: "Tanıtım filmi",
  }),
  fbVideoUpload: (): PublishRequest => ({
    kind: "facebook.video",
    pageId: PAGE,
    video: pushedVideo(120),
    title: "Yüklenen video",
    description: "Parça parça yüklendi",
  }),
  fbReelUrl: (): PublishRequest => ({
    kind: "facebook.reel",
    pageId: PAGE,
    video: urlVideo(45),
    description: "Facebook Reels #tarım",
    isAiGenerated: true,
  }),
  fbReelUpload: (): PublishRequest => ({
    kind: "facebook.reel",
    pageId: PAGE,
    video: pushedVideo(45),
    description: "Yüklenen Facebook Reels",
  }),
  fbStoryPhoto: (): PublishRequest => ({
    kind: "facebook.story",
    pageId: PAGE,
    media: { ...jpg(5, 1080, 1920) },
  }),
  fbStoryVideo: (): PublishRequest => ({
    kind: "facebook.story",
    pageId: PAGE,
    media: pushedVideo(20),
  }),
};

export type RequestName = keyof typeof requests;

/** Count what actually got published on the fake, by request kind. */
export function publishedCount(env: Env, kind: string): number {
  if (kind.startsWith("instagram.")) return env.fake.igPublishedMedia(IG).length;
  if (kind === "facebook.story") return env.fake.stories.length;
  if (kind === "facebook.reel")
    return [...env.fake.videos.values()].filter((v) => v.finished).length;
  return env.fake.pagePosts(PAGE).length;
}
