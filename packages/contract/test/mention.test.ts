import { describe, expect, it } from "vitest";
import {
  allocateMentionSlugs,
  engineNotReadyError,
  mentionBase,
  productPhotoAngle,
  resolveEntityMentions,
} from "../src/index.ts";

describe("@product / @post mention names", () => {
  it("folds Turkish letters and keeps names apart from file aliases", () => {
    expect(mentionBase("Venta Boro", "product")).toBe("venta-boro");
    expect(mentionBase("Hasat Bayramı Kutlu Olsun!", "content")).toBe("hasat-bayrami-kutlu-olsun");
    expect(mentionBase("ÇİĞDEM Şişe", "product")).toBe("cigdem-sise");
    expect(mentionBase("20-20-20", "product")).toBe("urun-20-20-20");
    expect(mentionBase("Image 2", "content")).toBe("image-2-post");
    expect(mentionBase("!!!", "content")).toBe("post");
    expect(mentionBase("a".repeat(60), "product")).toHaveLength(40);
  });

  it("allocates unique names in order, products first", () => {
    const taken = new Set<string>();
    const products = allocateMentionSlugs(
      [
        { id: "p1", name: "Boro" },
        { id: "p2", name: "BORO" },
      ],
      "product",
      taken,
    );
    const posts = allocateMentionSlugs([{ id: "c1", name: "Boro" }], "content", taken);
    expect([...products.values(), ...posts.values()]).toEqual(["boro", "boro-2", "boro-3"]);
    const long = allocateMentionSlugs(
      [
        { id: "x", name: "b".repeat(50) },
        { id: "y", name: "b".repeat(50) },
      ],
      "product",
      new Set(),
    );
    expect(long.get("y")).toBe(`${"b".repeat(38)}-2`);
  });

  it("resolves mentions in text, skipping the conversation's file aliases", () => {
    const targets = [
      { kind: "product" as const, id: "p1", slug: "boro" },
      { kind: "content" as const, id: "c1", slug: "image-post" },
    ];
    expect(
      resolveEntityMentions("@boro ile (@image-post), e@boro değil, @boro'yu", targets, new Set()),
    ).toEqual([
      { kind: "product", id: "p1", name: "boro", start: 0, end: 5 },
      { kind: "content", id: "c1", name: "image-post", start: 11, end: 22 },
      { kind: "product", id: "p1", name: "boro", start: 39, end: 44 },
    ]);
    expect(resolveEntityMentions("@boro", targets, new Set(["boro"]))).toEqual([]);
  });

  it("reads a photo's angle from its file name, tags and caption", () => {
    expect(productPhotoAngle("boro_on.jpg")).toBe("ön");
    expect(productPhotoAngle("IMG_1234.jpg", "şişe", null)).toBeNull();
    expect(productPhotoAngle("arka-etiket.png")).toBe("arka, etiket");
    expect(productPhotoAngle(null, "", "Şişenin sağdan görünüşü")).toBe("sağ");
    expect(productPhotoAngle("tonlar.png")).toBeNull();
  });
});

describe("generation engines", () => {
  it("only HTML is ready", () => {
    expect(engineNotReadyError("html")).toBeNull();
    expect(engineNotReadyError("svg")).toBe("Bu motor henüz hazır değil (SVG)");
    expect(engineNotReadyError("code")).toBe("Bu motor henüz hazır değil (Kod)");
  });
});
