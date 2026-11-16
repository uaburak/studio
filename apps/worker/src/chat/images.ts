/**
 * Which images the chat agent sees in a turn: only those the latest user message
 * attached or @mentioned (never the whole history), capped in number and size.
 */
import type { Message, TurnAlias, TurnContext } from "@studio/contract";
import type { StudioApi } from "../api.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import type { Logger } from "../log.ts";
import { imageBlock, prepareModelImage } from "../media.ts";
import type { ChatImageNote } from "./prompt.ts";

export interface SelectedImage {
  alias: string;
  aliasId: string | null;
  assetId: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  filename: string | null;
  reason: "mentioned" | "attached";
}

/** The user message this turn answers: the trigger when it is a user message, else the latest one. */
export function latestUserMessage(context: TurnContext): Message | undefined {
  const trigger = context.messages.find((m) => m.id === context.run.triggerMessageId);
  if (trigger?.role === "user") return trigger;
  return [...context.messages].reverse().find((m) => m.role === "user");
}

const isImage = (mime: string) => /^image\//i.test(mime) && !/svg/i.test(mime);

export function selectTurnImages(context: TurnContext, max: number): SelectedImage[] {
  const message = latestUserMessage(context);
  if (!message) return [];
  const aliases: readonly TurnAlias[] = context.aliases ?? [];
  const byId = new Map(aliases.map((a) => [a.id, a]));
  const byAsset = new Map(aliases.map((a) => [a.assetId, a]));
  const out: SelectedImage[] = [];
  const add = (img: SelectedImage) => {
    if (!isImage(img.mimeType) || out.some((o) => o.assetId === img.assetId)) return;
    out.push(img);
  };
  for (const mention of message.mentions ?? []) {
    const alias = byId.get(mention.aliasId);
    if (!alias) continue;
    add({
      alias: alias.alias,
      aliasId: alias.id,
      assetId: alias.assetId,
      mimeType: alias.mimeType,
      width: alias.width,
      height: alias.height,
      filename: alias.filename,
      reason: "mentioned",
    });
  }
  for (const part of message.parts) {
    if (part.type !== "attachment") continue;
    const alias = (part.aliasId ? byId.get(part.aliasId) : undefined) ?? byAsset.get(part.assetId);
    add({
      alias: alias?.alias ?? part.alias ?? part.assetId,
      aliasId: alias?.id ?? part.aliasId ?? null,
      assetId: part.assetId,
      mimeType: part.mimeType,
      width: part.width,
      height: part.height,
      filename: part.filename,
      reason: "attached",
    });
  }
  return out.slice(0, Math.max(0, max));
}

export interface LoadedImages {
  blocks: ClaudeContentBlock[];
  notes: ChatImageNote[];
}

/** Download, downscale and label the selected images for the model. Failures become notes. */
export async function loadTurnImages(
  api: StudioApi,
  selected: readonly SelectedImage[],
  options: { maxEdge: number; maxBytes: number; signal?: AbortSignal; logger?: Logger },
): Promise<LoadedImages> {
  const blocks: ClaudeContentBlock[] = [];
  const notes: ChatImageNote[] = [];
  for (const img of selected) {
    const base = {
      alias: img.alias,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      filename: img.filename,
    };
    try {
      const { bytes } = await api.downloadAsset(img.assetId, {
        maxBytes: options.maxBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const prepared = await prepareModelImage(bytes, { maxEdge: options.maxEdge });
      if (!prepared) {
        notes.push({ ...base, attached: false, note: "görüntü açılamadı (raster değil)" });
        continue;
      }
      blocks.push({
        type: "text",
        text: `Görsel @${img.alias} (${img.reason === "mentioned" ? "son mesajda anıldı" : "son mesaja eklendi"}; ${img.filename ?? img.mimeType}, özgün boyut ${prepared.original.width}x${prepared.original.height}):`,
      });
      blocks.push(imageBlock(prepared));
      notes.push({
        ...base,
        width: prepared.original.width,
        height: prepared.original.height,
        attached: true,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      options.logger?.warn(
        `could not load @${img.alias} (${img.assetId}): ${(error as Error).message}`,
      );
      notes.push({ ...base, attached: false, note: "indirilemedi" });
    }
  }
  return { blocks, notes };
}
