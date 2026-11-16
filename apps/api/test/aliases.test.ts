import { env, exports } from "cloudflare:workers";
import {
  Asset,
  applyConversationStreamMessage,
  Conversation,
  ConversationAlias,
  ConversationAliasList,
  type ConversationState,
  type ConversationStreamMessage,
  decodeConversationStreamMessage,
  MessageList,
  TurnContext,
  TurnWriteResult,
  UserMessageResult,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, BASE, createBrand, expectError } from "./helpers.ts";

/*
 * Attachment aliases and @mentions (task A2b). Runs need no connected worker
 * here: the turn API's `start` moves a queued run to running by itself.
 */

const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });

async function worker<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: res.status, body: parsed as T };
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
]);

let uploads = 0;
async function upload(brandId: string, name = "foto.png", dims?: [number, number]) {
  const form = new FormData();
  form.set("brandId", brandId);
  // Different bytes per upload, so each upload is its own asset.
  const bytes = new Uint8Array([...PNG, ++uploads & 0xff, (uploads >> 8) & 0xff]);
  form.set("file", new File([bytes], name, { type: "image/png" }));
  if (dims) {
    form.set("width", String(dims[0]));
    form.set("height", String(dims[1]));
  }
  const res = await exports.default.fetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

async function newConversation(brandId?: string) {
  const res = await api("POST", "/api/conversations", brandId ? { brandId } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Conversation.parse(res.body);
}

const send = (conversationId: string, body: Record<string, unknown>) =>
  api("POST", `/api/conversations/${conversationId}/messages`, body);

/** Send, expect 201, then cancel the run so the next message can follow. */
async function sendOk(conversationId: string, body: Record<string, unknown>) {
  const res = await send(conversationId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const result = UserMessageResult.parse(res.body);
  expect((await api("POST", `/api/agent-runs/${result.run.id}/cancel`)).status).toBe(200);
  return result;
}

async function aliasesOf(conversationId: string) {
  const res = await api("GET", `/api/conversations/${conversationId}/aliases`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ConversationAliasList.parse(res.body).items;
}

const rename = (conversationId: string, aliasId: string, alias: string) =>
  api("PATCH", `/api/conversations/${conversationId}/aliases/${aliasId}`, { alias });

const attachmentAliases = (result: UserMessageResult) =>
  result.message.parts.flatMap((p) => (p.type === "attachment" ? [p.alias] : []));

describe("attachment aliases", () => {
  it("allocates image, image-1, image-2 ... across messages and reuses an asset's alias", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const [a, b, c, d] = await Promise.all([
      upload(brand.id, "a.png", [1080, 1350]),
      upload(brand.id, "b.png"),
      upload(brand.id, "c.png"),
      upload(brand.id, "d.png"),
    ]);

    const first = await sendOk(conv.id, { text: "ilk", attachmentAssetIds: [a.id, b.id] });
    expect(attachmentAliases(first)).toEqual(["image", "image-1"]);
    const second = await sendOk(conv.id, { attachmentAssetIds: [c.id, a.id] });
    expect(attachmentAliases(second)).toEqual(["image-2", "image"]);
    const aPart = second.message.parts[1];
    expect(aPart?.type === "attachment" && aPart.aliasId).toBe(
      first.message.parts[1]?.type === "attachment" && first.message.parts[1].aliasId,
    );
    const third = await sendOk(conv.id, { attachments: [{ assetId: d.id }] });
    expect(attachmentAliases(third)).toEqual(["image-3"]);

    const list = await aliasesOf(conv.id);
    expect(list.map((x) => [x.alias, x.assetId, x.messageId])).toEqual([
      ["image", a.id, first.message.id],
      ["image-1", b.id, first.message.id],
      ["image-2", c.id, second.message.id],
      ["image-3", d.id, third.message.id],
    ]);
    expect(list[0]).toMatchObject({
      conversationId: conv.id,
      previousAliases: [],
      kind: "image",
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      filename: "a.png",
      contentPath: `/api/assets/${a.id}/content`,
    });
    // The content path really streams the file.
    const file = await exports.default.fetch(`${BASE}${list[0]?.contentPath}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("image/png");
    await file.arrayBuffer();

    // Another conversation numbers its own aliases from the start.
    const other = await newConversation(brand.id);
    expect(attachmentAliases(await sendOk(other.id, { attachmentAssetIds: [c.id] }))).toEqual([
      "image",
    ]);
    expectError(await api("GET", "/api/conversations/nope/aliases"), 404, "not_found");
  });

  it("never reuses a name after a rename and keeps old names resolving", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const [a, b, c] = await Promise.all([upload(brand.id), upload(brand.id), upload(brand.id)]);
    const first = await sendOk(conv.id, { attachmentAssetIds: [a.id, b.id] });
    const [image, image1] = await aliasesOf(conv.id);
    if (!image || !image1) throw new Error("aliases missing");

    const renamed = await rename(conv.id, image1.id, "Kapak");
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(ConversationAlias.parse(renamed.body)).toMatchObject({
      id: image1.id,
      alias: "kapak",
      previousAliases: ["image-1"],
      assetId: b.id,
    });
    // The freed-looking `image-1` is not handed out again.
    const next = await sendOk(conv.id, {
      text: "@image-1 ile @kapak aynı, @image ayrı",
      attachmentAssetIds: [c.id],
    });
    expect(attachmentAliases(next)).toEqual(["image-2"]);
    expect(next.message.mentions?.map((m) => [m.alias, m.aliasId, m.assetId])).toEqual([
      ["image-1", image1.id, b.id],
      ["kapak", image1.id, b.id],
      ["image", image.id, a.id],
    ]);

    // Same name again: no-op. Taken (current or earlier) by another alias: 409. Bad name: 400.
    expect((await rename(conv.id, image1.id, "kapak")).status).toBe(200);
    expectError(await rename(conv.id, image.id, "kapak"), 409, "conflict");
    expectError(await rename(conv.id, image.id, "image-1"), 409, "conflict");
    expectError(await rename(conv.id, image.id, "1-bad"), 400, "validation_error");
    expectError(await rename(conv.id, "missing", "x"), 404, "not_found");
    // An alias may go back to its own earlier name.
    const back = await rename(conv.id, image1.id, "image-1");
    expect(ConversationAlias.parse(back.body)).toMatchObject({
      alias: "image-1",
      previousAliases: ["kapak"],
    });

    // Stored messages keep their text and parts; ids tell the current name.
    const res = await api("GET", `/api/conversations/${conv.id}/messages?limit=10`);
    const stored = MessageList.parse(res.body).items.find((m) => m.id === first.message.id);
    expect(stored?.parts.map((p) => p.type === "attachment" && p.alias)).toEqual([
      "image",
      "image-1",
    ]);
  });

  it("checks requested aliases", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const [a, b, c] = await Promise.all([upload(brand.id), upload(brand.id), upload(brand.id)]);

    // A requested name is reserved before auto names are given out in the same message.
    const first = await sendOk(conv.id, {
      text: "@image kapak, @urun ürün",
      attachments: [{ assetId: a.id }, { assetId: b.id, alias: "IMAGE" }],
    });
    expect(attachmentAliases(first)).toEqual(["image-1", "image"]);
    expect(first.message.mentions?.map((m) => [m.alias, m.assetId])).toEqual([["image", b.id]]);

    // Taken by another asset, or another name for an asset that has one: 409, nothing stored.
    expectError(
      await send(conv.id, { attachments: [{ assetId: c.id, alias: "image-1" }] }),
      409,
      "conflict",
    );
    expectError(
      await send(conv.id, { attachments: [{ assetId: a.id, alias: "baska" }] }),
      409,
      "conflict",
    );
    expectError(
      await send(conv.id, { attachments: [{ assetId: c.id, alias: "a_b" }] }),
      400,
      "validation_error",
    );
    expectError(
      await send(conv.id, {
        attachmentAssetIds: [a.id],
        attachments: [{ assetId: c.id }],
      }),
      400,
      "validation_error",
    );
    expect((await aliasesOf(conv.id)).map((x) => x.alias)).toEqual(["image", "image-1"]);

    // Its own current name is fine; a fresh name for a new asset too.
    const ok = await sendOk(conv.id, {
      attachments: [
        { assetId: a.id, alias: "image-1" },
        { assetId: c.id, alias: "urun" },
      ],
    });
    expect(attachmentAliases(ok)).toEqual(["image-1", "urun"]);

    // The existing attachment rule stands: other brands' assets and brand-less conversations.
    const foreign = await upload((await createBrand()).id);
    const wrong = expectError(
      await send(conv.id, { attachments: [{ assetId: foreign.id, alias: "yabanci" }] }),
      400,
      "validation_error",
    );
    expect(wrong.issues?.[0]?.path).toBe("attachments.0.assetId");
    const loose = await newConversation();
    expectError(await send(loose.id, { attachmentAssetIds: [a.id] }), 400, "validation_error");
    expect(await aliasesOf(loose.id)).toEqual([]);
  });

  it("allocates race-free under concurrent sends and renames", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const assets = await Promise.all([1, 2, 3, 4].map(() => upload(brand.id)));

    // One active run per conversation: one send wins, the other stores nothing.
    const [x, y] = await Promise.all([
      send(conv.id, { attachmentAssetIds: [assets[0]?.id, assets[1]?.id] }),
      send(conv.id, { attachmentAssetIds: [assets[2]?.id, assets[3]?.id] }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const winner = UserMessageResult.parse((x.status === 201 ? x : y).body);
    expect(attachmentAliases(winner)).toEqual(["image", "image-1"]);
    expect((await aliasesOf(conv.id)).map((a) => a.alias)).toEqual(["image", "image-1"]);
    await api("POST", `/api/agent-runs/${winner.run.id}/cancel`);

    // Many conversations at once, same assets: each numbers independently.
    const convs = await Promise.all([1, 2, 3, 4, 5].map(() => newConversation(brand.id)));
    const results = await Promise.all(
      convs.map((cv) => sendOk(cv.id, { attachmentAssetIds: assets.map((a) => a.id) })),
    );
    for (const r of results) {
      expect(attachmentAliases(r)).toEqual(["image", "image-1", "image-2", "image-3"]);
    }

    // Two aliases renamed to the same name at once: exactly one wins.
    const [p, q] = await aliasesOf(conv.id);
    const renames = await Promise.all([
      rename(conv.id, p?.id ?? "", "ortak"),
      rename(conv.id, q?.id ?? "", "ortak"),
    ]);
    expect(renames.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await aliasesOf(conv.id)).filter((a) => a.alias === "ortak")).toHaveLength(1);
  });

  it("parses mentions in the stored text", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const assets = await Promise.all(Array.from({ length: 10 }, () => upload(brand.id)));
    await sendOk(conv.id, { attachmentAssetIds: assets.map((a) => a.id) }); // image .. image-9
    const eleventh = await upload(brand.id);
    await sendOk(conv.id, { attachmentAssetIds: [eleventh.id] }); // image-10
    const byName = new Map((await aliasesOf(conv.id)).map((a) => [a.alias, a]));

    const text =
      "@image-10 kapak, @image-1'i ürün postunda kullan; @image. mail: a@image, " +
      "@image-1 tekrar ve @bilinmeyen kalsın, @IMAGE-10!";
    const sent = await sendOk(conv.id, { text: `  ${text}  ` });
    expect(sent.message.parts).toEqual([{ type: "text", text }]);
    const mentions = sent.message.mentions ?? [];
    expect(mentions.map((m) => [m.alias, text.slice(m.start, m.end)])).toEqual([
      ["image-10", "@image-10"],
      ["image-1", "@image-1"],
      ["image", "@image"],
      ["image-1", "@image-1"],
      ["image-10", "@IMAGE-10"],
    ]);
    for (const m of mentions) {
      expect(m.aliasId).toBe(byName.get(m.alias)?.id);
      expect(m.assetId).toBe(byName.get(m.alias)?.assetId);
    }
    // Messages without mentions carry an empty list.
    const plain = await sendOk(conv.id, { text: "selam" });
    expect(plain.message.mentions).toEqual([]);
  });
});

describe("worker context and stream", () => {
  it("gives the agent the alias map and mentions, and streams alias changes", async () => {
    const brand = await createBrand();
    const conv = await newConversation(brand.id);
    const [a, b, gen] = await Promise.all([
      upload(brand.id, "tarla.png", [1080, 1080]),
      upload(brand.id, "urun.png"),
      upload(brand.id, "uretilen.png"),
    ]);

    const frames: ConversationStreamMessage[] = [];
    let state: ConversationState | null = null;
    const res = await exports.default.fetch(`${BASE}/api/conversations/${conv.id}/stream`, {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    ws.addEventListener("message", (event) => {
      const decoded = decodeConversationStreamMessage(event.data);
      if (!decoded.ok) throw new Error(decoded.error);
      frames.push(decoded.message);
      state = applyConversationStreamMessage(state, decoded.message);
    });
    const settle = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(pred()).toBe(true);
    };
    await settle(() => frames.some((f) => f.type === "conversation.snapshot"));

    const sendRes = await send(conv.id, {
      text: "@image-1 görselini ürün postunda kullan, @image kapak olsun",
      attachmentAssetIds: [a.id, b.id],
    });
    expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(201);
    const sent = UserMessageResult.parse(sendRes.body);
    expect(sent.message.mentions?.map((m) => [m.alias, m.assetId, m.start, m.end])).toEqual([
      ["image-1", b.id, 0, 8],
      ["image", a.id, 41, 47],
    ]);

    const started = await worker("POST", `/api/worker/runs/${sent.run.id}/start`, { attempt: 1 });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const context = TurnContext.parse(started.body);
    expect(context.aliases?.map((x) => [x.alias, x.assetId, x.objectKey])).toEqual([
      ["image", a.id, a.objectKey],
      ["image-1", b.id, b.objectKey],
    ]);
    expect(context.aliases?.[0]).toMatchObject({
      mimeType: "image/png",
      width: 1080,
      height: 1080,
      contentPath: `/api/assets/${a.id}/content`,
    });
    const userMessage = context.messages.find((m) => m.id === sent.message.id);
    expect(userMessage?.mentions).toEqual(sent.message.mentions);
    const again = await worker("GET", `/api/worker/runs/${sent.run.id}/context`);
    expect(TurnContext.parse(again.body).aliases).toEqual(context.aliases);

    // The agent attaches a generated image: it gets the next alias, or the one it asks for.
    const opsRes = await worker("POST", `/api/worker/runs/${sent.run.id}/ops`, {
      ops: [
        { op: "text.delta", index: 0, seq: 1, text: "Hazırladım:" },
        { op: "part.set", index: 1, part: { type: "attachment", assetId: gen.id } },
        { op: "part.set", index: 2, part: { type: "attachment", assetId: a.id } },
      ],
    });
    expect(opsRes.status, JSON.stringify(opsRes.body)).toBe(200);
    const written = TurnWriteResult.parse(opsRes.body).message;
    expect(written.parts.map((p) => p.type === "attachment" && p.alias)).toEqual([
      false,
      "image-2",
      "image",
    ]);
    expect(written.mentions).toEqual([]);
    // Retrying the same op changes nothing.
    const retry = await worker("POST", `/api/worker/runs/${sent.run.id}/ops`, {
      ops: [{ op: "part.set", index: 1, part: { type: "attachment", assetId: gen.id } }],
    });
    expect(TurnWriteResult.parse(retry.body).message).toEqual(written);

    const list = await aliasesOf(conv.id);
    expect(list.map((x) => x.alias)).toEqual(["image", "image-1", "image-2"]);
    const renamed = await rename(conv.id, list[2]?.id ?? "", "uretilen");
    expect(renamed.status).toBe(200);
    const ctx = TurnContext.parse(
      (await worker("GET", `/api/worker/runs/${sent.run.id}/context`)).body,
    );
    expect(ctx.aliases?.map((x) => [x.alias, x.previousAliases])).toEqual([
      ["image", []],
      ["image-1", []],
      ["uretilen", ["image-2"]],
    ]);

    // The stream carried every alias change on conversation.updated; the reducer agrees.
    const expected = await aliasesOf(conv.id);
    await settle(() => {
      const s = state as ConversationState | null;
      return JSON.stringify(s?.aliases) === JSON.stringify(expected);
    });
    const withAliases = frames.filter((f) => f.type === "conversation.updated" && f.aliases);
    expect(withAliases.length).toBe(3);
    // No new frame types.
    expect(new Set(frames.map((f) => f.type).filter((t) => t !== "presence"))).toEqual(
      new Set([
        "conversation.snapshot",
        "message.created",
        "run.updated",
        "conversation.updated",
        "text.delta",
        "part.added",
      ]),
    );

    // A fresh snapshot carries the full list.
    const snap = await exports.default.fetch(`${BASE}/api/conversations/${conv.id}/stream`, {
      headers: { Upgrade: "websocket" },
    });
    const ws2 = snap.webSocket;
    if (!ws2) throw new Error("no socket");
    ws2.accept();
    const first = await new Promise<ConversationStreamMessage>((resolve, reject) => {
      ws2.addEventListener("message", (event) => {
        const decoded = decodeConversationStreamMessage(event.data);
        if (decoded.ok) resolve(decoded.message);
        else reject(new Error(decoded.error));
      });
    });
    expect(first.type === "conversation.snapshot" && first.aliases).toEqual(expected);
    ws.close(1000);
    ws2.close(1000);
    await api("POST", `/api/agent-runs/${sent.run.id}/cancel`);
  });

  it("documents the alias routes in OpenAPI", async () => {
    const res = await exports.default.fetch(`${BASE}/api/openapi.json`);
    const doc = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths).toHaveProperty(["/api/conversations/{id}/aliases"]);
    expect(doc.paths).toHaveProperty(["/api/conversations/{id}/aliases/{aliasId}"]);
    for (const schema of ["ConversationAlias", "MessageMention", "UserMessageAttachment"]) {
      expect(doc.components.schemas, schema).toHaveProperty([schema]);
    }
  });
});
