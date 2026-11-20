import { describe, expect, it } from "vitest";
import {
  ContentGeneratePayload,
  MAX_PLAN_ITEM_PRODUCTS,
  PlanItem,
  PlanItemInput,
  PlanItemPatch,
  SlotImageRequest,
  TemplateUse,
} from "../src/index.ts";

/*
 * Picture production gaps (docs/URETIM-RESIM.md, "Kapanan boşluklar"): plan items keep their
 * products; a template post carries the consented slot picture explicitly.
 */

const ID = "01J0000000000000000000000A";
const ID2 = "01J0000000000000000000000B";

const storedItem = {
  id: ID,
  planId: ID,
  position: 0,
  date: null,
  platforms: ["instagram"],
  contentType: "post",
  title: "Boro",
  brief: "",
  pillar: null,
  imageSlot: "ai_generate",
  imageBrief: null,
  status: "planned",
  contentId: null,
  generation: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

describe("plan items: products", () => {
  it("reads an item from an older server without products", () => {
    const item = PlanItem.parse(storedItem);
    expect(item.productIds).toEqual([]);
    expect(item.imageView).toBeNull();
    expect(PlanItem.parse({ ...storedItem, productIds: [ID2], imageView: "sol" })).toMatchObject({
      productIds: [ID2],
      imageView: "sol",
    });
  });

  it("leaves the products out of an edit that does not name them", () => {
    const input = PlanItemInput.parse({
      platforms: ["instagram"],
      contentType: "post",
      title: "x",
    });
    expect(input.productIds).toBeUndefined();
    expect(input.imageView).toBeUndefined();
    expect(PlanItemPatch.safeParse({ productIds: [] }).success).toBe(true);
    expect(PlanItemPatch.safeParse({ imageView: null }).success).toBe(true);
  });

  it("refuses more than the picture line takes, and repeats", () => {
    const many = Array.from({ length: MAX_PLAN_ITEM_PRODUCTS + 1 }, (_, i) => `prod_${i}`);
    expect(PlanItemPatch.safeParse({ productIds: many }).success).toBe(false);
    expect(PlanItemPatch.safeParse({ productIds: [ID, ID] }).success).toBe(false);
  });
});

describe("template use: the consented slot picture", () => {
  it("takes an explicit slotImage (literal consent) and an image brief", () => {
    const ok = TemplateUse.parse({
      brief: "Kış",
      imageBrief: "Tarlada şişe",
      slotImage: { consented: true, productIds: [ID], view: "sol" },
    });
    expect(ok.slotImage).toEqual({ consented: true, productIds: [ID], view: "sol" });
    expect(TemplateUse.safeParse({ slotImage: { consented: false } }).success).toBe(false);
    expect(TemplateUse.parse({}).slotImage).toBeUndefined();
  });

  it("is the same request the engines' payload carries", () => {
    const request = SlotImageRequest.parse({ consented: true });
    const payload = ContentGeneratePayload.parse({
      brief: "x",
      imageSlot: "ai_generate",
      template: { templateId: ID },
      slotImage: request,
    });
    expect(payload.slotImage).toEqual({ consented: true });
  });
});
