/**
 * N13 on the cloud publisher: an order's publish details reach the publishers (first comment,
 * location, collaborators, picture and Reels tags, cover / frame, share-to-feed), the Reels cover
 * picture is a medium that is not part of the post, and a failed first comment is a warning on a
 * published target.
 */
import type { CloudOrder } from "@studio/contract";
import { CloudOrder as CloudOrderSchema } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/build-request.ts";
import {
  api,
  fakeJpeg,
  HOUR,
  IG,
  mediaDecl,
  orderBody,
  runUntilIdle,
  setup,
  sha256Hex,
  T0,
  target,
  upload,
} from "./helpers.ts";

const img = (n: number) => ({ id: `slide-${n}.jpg`, bytes: fakeJpeg(n) });
const url = (id: string) => `https://publisher.test/m/${id}`;

describe("publish details in requests (N13)", () => {
  const media = [
    {
      id: "slide-1.jpg",
      kind: "image" as const,
      mimeType: "image/jpeg" as const,
      bytes: 10,
      sha256: "a".repeat(64),
      altText: "Birinci",
      userTags: [{ username: "ali", x: 0.2, y: 0.3 }],
    },
    {
      id: "slide-2.jpg",
      kind: "image" as const,
      mimeType: "image/jpeg" as const,
      bytes: 10,
      sha256: "b".repeat(64),
    },
  ];
  const details = {
    firstComment: "#tarım",
    locationId: "110011",
    collaborators: ["ortak"],
    reelUserTags: ["veli"],
    thumbOffsetMs: 1200,
    shareToFeed: false,
  };
  const order = { caption: "x", title: null, isAiGenerated: false, media, details };

  it("instagram image and carousel", () => {
    const one = buildRequest(order, { kind: "instagram.image", accountExternalId: IG }, url);
    expect(one).toMatchObject({
      firstComment: "#tarım",
      locationId: "110011",
      collaborators: ["ortak"],
      userTags: [{ username: "ali", x: 0.2, y: 0.3 }],
    });
    const carousel = buildRequest(
      order,
      { kind: "instagram.carousel", accountExternalId: IG },
      url,
    );
    expect(carousel.kind === "instagram.carousel" && carousel.items[0]).toMatchObject({
      altText: "Birinci",
      userTags: [{ username: "ali", x: 0.2, y: 0.3 }],
    });
    expect(carousel).toMatchObject({ firstComment: "#tarım", locationId: "110011" });
  });

  it("reels: tags without positions, frame or cover picture, share to feed", () => {
    const video = {
      id: "reel.mp4",
      kind: "video" as const,
      mimeType: "video/mp4" as const,
      bytes: 100,
      sha256: "c".repeat(64),
      durationMs: 10_000,
    };
    const frame = buildRequest(
      { ...order, media: [video] },
      { kind: "instagram.reel", accountExternalId: IG },
      url,
    );
    expect(frame).toMatchObject({
      userTags: [{ username: "veli" }],
      thumbOffsetMs: 1200,
      shareToFeed: false,
      firstComment: "#tarım",
    });
    const cover = {
      id: "cover.jpg",
      kind: "image" as const,
      mimeType: "image/jpeg" as const,
      bytes: 10,
      sha256: "d".repeat(64),
      role: "cover" as const,
    };
    const withCover = buildRequest(
      { ...order, media: [video, cover] },
      { kind: "instagram.reel", accountExternalId: IG },
      url,
    );
    expect(withCover).toMatchObject({ coverUrl: url("cover.jpg") });
    expect(withCover).not.toHaveProperty("thumbOffsetMs");
    expect(withCover.kind === "instagram.reel" && withCover.video.kind).toBe("video");
  });

  it("facebook gets only the first comment; linkedin none", () => {
    const fb = buildRequest(order, { kind: "facebook.multi_photo", accountExternalId: "1" }, url);
    expect(fb).toMatchObject({ firstComment: "#tarım" });
    expect(fb).not.toHaveProperty("locationId");
    const li = buildRequest(
      order,
      { kind: "linkedin.multi_image", accountExternalId: "urn:li:person:x" },
      url,
    );
    expect(li).not.toHaveProperty("firstComment");
  });
});

describe("cloud orders with details (N13)", () => {
  it("publishes the first comment and keeps details on the order", async () => {
    const h = await setup();
    const body = await orderBody([img(1)], [target("instagram.image")], T0 + HOUR, {
      details: { firstComment: "Detaylar yorumda 👇", locationId: "110011" },
    });
    body.media = [await mediaDecl(img(1), { userTags: [{ username: "ali", x: 0.5, y: 0.5 }] })];
    const created = await api<CloudOrder>("PUT", "/v1/orders/d-1", body);
    expect(created.status, created.text).toBe(201);
    expect(CloudOrderSchema.parse(created.body).details).toEqual({
      firstComment: "Detaylar yorumda 👇",
      locationId: "110011",
    });
    await upload("d-1", img(1));
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/d-1")).body;
    expect(order.targets[0]?.status).toBe("published");
    expect(order.targets[0]?.warnings).toBeUndefined();
    const mediaId = order.targets[0]?.externalId as string;
    expect(h.fake.commentsOf(mediaId).map((c) => c.text)).toEqual(["Detaylar yorumda 👇"]);
    const create = h.fake.routeCalls("ig.media.create")[0];
    expect(create?.form).toMatchObject({
      location_id: "110011",
      user_tags: '[{"username":"ali","x":0.5,"y":0.5}]',
    });
  });

  it("a failed first comment leaves the target published with a warning", async () => {
    const h = await setup();
    h.fake.failNext("comments.create", { code: 10, message: "(#10) permission" });
    const body = await orderBody([img(2)], [target("instagram.image")], T0 + HOUR, {
      details: { firstComment: "İlk yorum" },
    });
    await api("PUT", "/v1/orders/d-2", body);
    await upload("d-2", img(2));
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = CloudOrderSchema.parse((await api("GET", "/v1/orders/d-2")).body);
    expect(order.status).toBe("published");
    expect(order.targets[0]?.warnings).toEqual([
      expect.objectContaining({ code: "FIRST_COMMENT_FAILED" }),
    ]);
  });

  it("a Reels cover picture is uploaded like media but is not a post medium", async () => {
    await setup();
    const video = { id: "reel.mp4", bytes: fakeJpeg(9, 4096) };
    const cover = { id: "cover.jpg", bytes: fakeJpeg(10) };
    const body = await orderBody([], [target("instagram.reel")], T0 + HOUR);
    body.media = [
      {
        id: video.id,
        kind: "video",
        mimeType: "video/mp4",
        bytes: video.bytes.byteLength,
        sha256: await sha256Hex(video.bytes),
        width: 1080,
        height: 1920,
        durationMs: 10_000,
        frameRate: 30,
      },
      { ...(await mediaDecl(cover)), role: "cover" },
    ];
    const created = await api<CloudOrder>("PUT", "/v1/orders/d-3", body);
    expect(created.status, created.text).toBe(201);
    expect((await upload("d-3", video, "video/mp4")).status).toBe(200);
    const ready = await upload("d-3", cover);
    expect(ready.status).toBe(200);
    expect((ready.body as CloudOrder).status).toBe("scheduled");
  });
});
