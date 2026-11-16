/**
 * Crash-safety: for every content type and every step, simulate a crash and
 * resume from the last persisted state. Nothing may be published twice and
 * every run must still finish.
 */

import { describe, expect, it } from "vitest";
import type { PublishState } from "../src/index.ts";
import { drive, IG, PAGE, publishedCount, type RequestName, requests, setup } from "./helpers.ts";

const ALL = Object.keys(requests) as RequestName[];

async function countSteps(name: RequestName) {
  const env = setup();
  const req = requests[name]();
  const { outcomes } = await drive(env, env.publisher.start(req), env.ctxFor(req));
  return outcomes.length;
}

function publishedIds(env: ReturnType<typeof setup>, kind: string): string[] {
  if (kind.startsWith("instagram.")) return env.fake.igPublishedMedia(IG).map((m) => m.id);
  if (kind === "facebook.story") return env.fake.stories.map((s) => s.postId);
  return env.fake.pagePosts(PAGE).map((p) => p.id);
}

describe("resume after a crash at each step (state of the crashed step is lost)", () => {
  it.each(ALL)("%s", async (name) => {
    const total = await countSteps(name);
    expect(total).toBeGreaterThan(2);
    for (let crashAt = 0; crashAt < total; crashAt++) {
      const env = setup();
      const req = requests[name]();
      const ctx = env.ctxFor(req);
      let state: PublishState = env.publisher.start(req);
      let done = false;
      for (let i = 0; i < 300 && !done; i++) {
        const out = await env.publisher.step(state, ctx);
        if (i === crashAt) {
          // The step ran (its Graph calls happened) but the worker died before
          // persisting. The workflow restarts later from the previous state.
          env.clock.advance(10_000);
          continue;
        }
        state = JSON.parse(JSON.stringify(out.state));
        if (out.status === "wait") env.clock.advance(Math.max(0, out.resumeAt - env.clock.now()));
        if (out.status === "failed")
          throw new Error(`${name} crash@${crashAt}: ${out.error.code} ${out.error.message}`);
        if (out.status === "done") {
          done = true;
          expect(publishedCount(env, req.kind), `${name} crash@${crashAt}`).toBe(1);
          expect(env.fake.stats.duplicatePublishAttempts, `${name} crash@${crashAt}`).toBe(0);
          if (out.result.reconciled && req.kind.startsWith("instagram.")) {
            expect(out.result.externalId).toBe(publishedIds(env, req.kind)[0]);
          }
        }
      }
      expect(done, `${name} crash@${crashAt} finished`).toBe(true);
    }
  });
});

const PUBLISH_ROUTE: Record<RequestName, string> = {
  igImage: "ig.media_publish",
  igCarousel: "ig.media_publish",
  igReelUrl: "ig.media_publish",
  igReelUpload: "ig.media_publish",
  igStoryImage: "ig.media_publish",
  igStoryVideo: "ig.media_publish",
  fbPhoto: "fb.photos.create",
  fbMultiPhoto: "fb.feed.create",
  fbVideoUrl: "fb.videos.create",
  fbVideoUpload: "fb.videos.finish",
  fbReelUrl: "fb.reel_or_story.finish",
  fbReelUpload: "fb.reel_or_story.finish",
  fbStoryPhoto: "fb.photo_stories",
  fbStoryVideo: "fb.reel_or_story.finish",
};

describe("lost response on the publish call itself", () => {
  it.each(ALL)("%s reconciles instead of publishing again", async (name) => {
    const env = setup();
    const req = requests[name]();
    env.fake.dropResponse(PUBLISH_ROUTE[name]);
    const { out } = await drive(env, env.publisher.start(req), env.ctxFor(req));
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.result.reconciled).toBe(true);
    expect(publishedCount(env, req.kind)).toBe(1);
    expect(env.fake.stats.duplicatePublishAttempts).toBe(0);
    expect(env.fake.routeCalls(PUBLISH_ROUTE[name])).toHaveLength(1);
    expect(out.result.externalId).toBeTruthy();
  });
});

describe("states are plain JSON", () => {
  it.each(ALL)("%s state survives a JSON round trip at every step", async (name) => {
    const env = setup();
    const req = requests[name]();
    const { outcomes } = await drive(env, env.publisher.start(req), env.ctxFor(req));
    for (const o of outcomes) {
      expect(JSON.parse(JSON.stringify(o.state))).toEqual(o.state);
      expect(JSON.stringify(o.state)).not.toContain("EAA");
    }
  });

  it("the input state is never mutated", async () => {
    const env = setup();
    const state = env.publisher.start(requests.igImage());
    const snapshot = JSON.stringify(state);
    await env.publisher.step(state, env.igCtx);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("rejects a state from an unknown version", async () => {
    const env = setup();
    const state = { ...env.publisher.start(requests.igImage()), v: 99 } as unknown as PublishState;
    const out = await env.publisher.step(state, env.igCtx);
    expect(out.status === "failed" && out.error.code).toBe("INVALID_STATE");
  });

  it("a finished state stays finished and makes no calls", async () => {
    const env = setup();
    const { state } = await drive(env, env.publisher.start(requests.fbPhoto()), env.fbCtx);
    const before = env.fake.calls.length;
    const again = await env.publisher.step(state, env.fbCtx);
    expect(again.status).toBe("done");
    expect(env.fake.calls.length).toBe(before);
  });
});

describe("ambiguity is never resolved by publishing again", () => {
  it("caption-less photo after a lost response stops with PUBLISH_UNCERTAIN", async () => {
    const env = setup();
    const req = requests.fbPhoto();
    if (req.kind === "facebook.photo") req.caption = undefined;
    env.fake.dropResponse("fb.photos.create");
    const { out } = await drive(env, env.publisher.start(req), env.fbCtx);
    expect(out.status === "failed" && out.error).toMatchObject({
      code: "PUBLISH_UNCERTAIN",
      action: "manual_check",
    });
    expect(env.fake.pagePosts(PAGE)).toHaveLength(1);
  });
});
