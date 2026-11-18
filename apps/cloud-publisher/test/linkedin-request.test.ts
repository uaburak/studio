import { validateRequest } from "@studio/publishers";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/build-request.ts";

const URN = "urn:li:person:deniz123";
const urlOf = (id: string) => `https://publisher.test/media/o-1/999/sig/${id}`;

describe("cloud-publisher buildRequest: LinkedIn orders", () => {
  it("builds linkedin.text requests with empty media", () => {
    const req = buildRequest(
      { caption: "Metin paylaşımı", title: null, isAiGenerated: false, media: [] },
      { kind: "linkedin.text", accountExternalId: URN },
      urlOf,
    );
    expect(req).toEqual({
      kind: "linkedin.text",
      authorUrn: URN,
      commentary: "Metin paylaşımı",
    });
    expect(validateRequest(req).ok).toBe(true);
  });

  it("builds linkedin.image, linkedin.multi_image, linkedin.document and linkedin.video requests", () => {
    const jpg1 = {
      id: "1.jpg",
      kind: "image" as const,
      mimeType: "image/jpeg" as const,
      bytes: 2048,
      sha256: "a".repeat(64),
      altText: "Bir",
    };
    const jpg2 = { ...jpg1, id: "2.jpg", sha256: "b".repeat(64), altText: "İki" };

    const single = buildRequest(
      { caption: "Tek görsel", title: null, isAiGenerated: false, media: [jpg1] },
      { kind: "linkedin.image", accountExternalId: URN },
      urlOf,
    );
    expect(validateRequest(single).ok).toBe(true);

    const multi = buildRequest(
      { caption: "Çoklu görsel", title: null, isAiGenerated: false, media: [jpg1, jpg2] },
      { kind: "linkedin.multi_image", accountExternalId: URN },
      urlOf,
    );
    expect(validateRequest(multi).ok).toBe(true);

    const pdf = buildRequest(
      {
        caption: "PDF sunum",
        title: "2026 Katalog",
        isAiGenerated: false,
        media: [
          {
            id: "katalog.pdf",
            kind: "document",
            mimeType: "application/pdf",
            bytes: 100_000,
            sha256: "c".repeat(64),
          },
        ],
      },
      { kind: "linkedin.document", accountExternalId: URN },
      urlOf,
    );
    expect(pdf).toMatchObject({
      kind: "linkedin.document",
      authorUrn: URN,
      title: "2026 Katalog",
    });
    expect(validateRequest(pdf).ok).toBe(true);

    const vid = buildRequest(
      {
        caption: "Video paylaşımı",
        title: "Tanıtım",
        isAiGenerated: false,
        media: [
          {
            id: "clip.mp4",
            kind: "video",
            mimeType: "video/mp4",
            bytes: 500_000,
            sha256: "d".repeat(64),
            durationMs: 12_000,
          },
        ],
      },
      { kind: "linkedin.video", accountExternalId: URN },
      urlOf,
    );
    expect(validateRequest(vid).ok).toBe(true);
  });
});
