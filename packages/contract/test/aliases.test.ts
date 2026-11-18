import { describe, expect, it } from "vitest";
import {
  AttachmentAlias,
  aliasBaseFor,
  applyConversationStreamMessage,
  autoAlias,
  type ConversationAlias,
  type ConversationState,
  type ConversationStreamMessage,
  resolveAliasMentions,
  scanAliasTokens,
  UserMessageCreate,
} from "../src/index.ts";

const T = "2026-11-16T10:00:00.000Z";

const target = (id: string, alias: string, previousAliases: string[] = []) => ({
  id,
  alias,
  previousAliases,
  assetId: `asset-${id}`,
});

const names = (text: string) => scanAliasTokens(text).map((t) => t.alias);

describe("alias names", () => {
  it("accepts lower-case names and lower-cases input", () => {
    expect(AttachmentAlias.parse("image-1")).toBe("image-1");
    expect(AttachmentAlias.parse(" Kapak ")).toBe("kapak");
    for (const bad of ["", "1image", "-a", "a-", "a_b", "görsel", "a".repeat(41), "a b"]) {
      expect(AttachmentAlias.safeParse(bad).success, bad).toBe(false);
    }
    expect(AttachmentAlias.safeParse("a".repeat(40)).success).toBe(true);
  });

  it("derives auto names from the mime type", () => {
    expect(aliasBaseFor("image/png")).toBe("image");
    expect(aliasBaseFor("image/svg+xml")).toBe("image");
    expect(aliasBaseFor("video/mp4")).toBe("video");
    expect(aliasBaseFor("application/pdf")).toBe("file");
    expect([0, 1, 2].map((n) => autoAlias("image", n))).toEqual(["image", "image-1", "image-2"]);
  });

  it("takes attachments with requested aliases, one way of attaching at a time", () => {
    expect(
      UserMessageCreate.safeParse({ attachments: [{ assetId: "a", alias: "Kapak" }] }).data
        ?.attachments,
    ).toEqual([{ assetId: "a", alias: "kapak" }]);
    expect(UserMessageCreate.safeParse({ attachments: [{ assetId: "a" }] }).success).toBe(true);
    expect(
      UserMessageCreate.safeParse({
        attachments: [
          { assetId: "a", alias: "x" },
          { assetId: "b", alias: "X" },
        ],
      }).success,
    ).toBe(false);
    expect(
      UserMessageCreate.safeParse({ attachments: [{ assetId: "a" }, { assetId: "a" }] }).success,
    ).toBe(false);
    expect(
      UserMessageCreate.safeParse({ attachmentAssetIds: ["a"], attachments: [{ assetId: "b" }] })
        .success,
    ).toBe(false);
    expect(UserMessageCreate.safeParse({ attachments: [] }).success).toBe(false);
  });
});

describe("mention scanning", () => {
  it("finds tokens with offsets covering @ and the name", () => {
    const text = "@image-1 görselini ürün postunda kullan, @image kapak olsun";
    expect(scanAliasTokens(text)).toEqual([
      { alias: "image-1", start: 0, end: 8 },
      { alias: "image", start: 41, end: 47 },
    ]);
    expect(text.slice(41, 47)).toBe("@image");
  });

  it("allows punctuation after the token and Turkish text around it", () => {
    expect(names("bak: @image, @image-1. (@image-2) @image-3! @image-4? @image-5;")).toEqual([
      "image",
      "image-1",
      "image-2",
      "image-3",
      "image-4",
      "image-5",
    ]);
    expect(names("@image-1'i öne çıkar, @kapak’ı da ekle")).toEqual(["image-1", "kapak"]);
    expect(names("şu görsel→@image ve “@image-1”")).toEqual(["image", "image-1"]);
    expect(names("trailing dash @image-1- ok")).toEqual(["image-1"]);
    expect(names("ÇİĞ@image")).toEqual([]);
  });

  it("does not match e-mail-like strings, handles or words that go on", () => {
    expect(names("a@image")).toEqual([]);
    expect(names("deniz@image-1.com")).toEqual([]);
    expect(names("x.y@image")).toEqual([]);
    expect(names("https://x.com/@image")).toEqual([]);
    expect(names("@@image")).toEqual([]);
    expect(names("@imageım")).toEqual([]);
    expect(names("@image_1")).toEqual([]);
    expect(names("@1image @ image @-image")).toEqual([]);
  });

  it("is case-insensitive and keeps every occurrence", () => {
    expect(names("@Image ve @IMAGE ve @image")).toEqual(["image", "image", "image"]);
  });

  it("measures offsets in UTF-16 code units", () => {
    const text = "🌾 @image";
    const [token] = scanAliasTokens(text);
    expect(token).toEqual({ alias: "image", start: 3, end: 9 });
  });
});

describe("mention resolution", () => {
  const aliases = [
    target("a0", "image"),
    target("a1", "image-1"),
    target("a10", "image-10"),
    target("k", "kapak", ["image-2"]),
  ];

  it("takes the longest name when aliases share a prefix", () => {
    const m = resolveAliasMentions("@image-10 ve @image-1 ve @image", aliases);
    expect(m.map((x) => [x.alias, x.aliasId])).toEqual([
      ["image-10", "a10"],
      ["image-1", "a1"],
      ["image", "a0"],
    ]);
    // `image-100` is not an alias and is not read as `image-10` + "0".
    expect(resolveAliasMentions("@image-100", aliases)).toEqual([]);
  });

  it("leaves unknown names out and resolves earlier names to their alias", () => {
    const m = resolveAliasMentions("@logo yok, @image-2 eski adı", aliases);
    expect(m).toEqual([{ alias: "image-2", aliasId: "k", assetId: "asset-k", start: 11, end: 19 }]);
  });

  it("lists repeated mentions with their own ranges", () => {
    const text = "@kapak sonra yine @kapak";
    const m = resolveAliasMentions(text, aliases);
    expect(m.map((x) => text.slice(x.start, x.end))).toEqual(["@kapak", "@kapak"]);
  });
});

describe("reducer", () => {
  const conversation = {
    id: "c1",
    brandId: "b1",
    title: "",
    status: "active" as const,
    activeRunId: null,
    lastSeq: 1,
    lastActivityAt: T,
    createdAt: T,
    updatedAt: T,
  };
  const alias = (id: string, name: string): ConversationAlias => ({
    id,
    conversationId: "c1",
    alias: name,
    previousAliases: [],
    assetId: `asset-${id}`,
    kind: "image",
    mimeType: "image/png",
    width: null,
    height: null,
    filename: null,
    contentPath: `/api/assets/asset-${id}/content`,
    messageId: "m1",
    createdAt: T,
    updatedAt: T,
  });

  it("takes aliases from the snapshot and upserts them from conversation.updated", () => {
    const snapshot: ConversationStreamMessage = {
      type: "conversation.snapshot",
      seq: 1,
      conversation,
      messages: [],
      hasMoreMessages: false,
      activeRun: null,
      plans: [],
      aliases: [alias("a", "image")],
      presence: { online: false, workers: [], currentJobs: [], queueLength: 0, lastSeenAt: null },
    };
    let state: ConversationState | null = applyConversationStreamMessage(null, snapshot);
    expect(state?.aliases.map((a) => a.alias)).toEqual(["image"]);
    state = applyConversationStreamMessage(state, {
      type: "conversation.updated",
      seq: 2,
      conversation,
      aliases: [{ ...alias("a", "kapak"), previousAliases: ["image"] }, alias("b", "image-1")],
    });
    expect(state?.aliases.map((a) => [a.id, a.alias])).toEqual([
      ["a", "kapak"],
      ["b", "image-1"],
    ]);
    // Without `aliases` the list stays as it is.
    state = applyConversationStreamMessage(state, {
      type: "conversation.updated",
      seq: 3,
      conversation,
    });
    expect(state?.aliases).toHaveLength(2);
    // An older snapshot shape without aliases gives an empty list.
    const { aliases: _drop, ...old } = snapshot;
    expect(applyConversationStreamMessage(null, old)?.aliases).toEqual([]);
  });
});
