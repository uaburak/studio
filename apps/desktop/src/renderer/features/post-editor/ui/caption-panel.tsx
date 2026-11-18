// The edit panel's Açıklama tab: the caption per platform (one text, each platform's limit and its feed
// preview cut), hashtags as chips with the platform's limit, first comment and alt text.
import type { Platform } from "@studio/contract";
import { useEffect, useMemo, useState } from "react";
import { Button, cn } from "../../../components/ui/controls.tsx";
import { IconClose } from "../../../components/ui/icons.tsx";
import {
  CAPTION_LIMIT,
  characterCount,
  HASHTAG_LIMIT,
  joinCaption,
  parseHashtags,
  splitCaption,
} from "../../post-detail/caption.ts";
import { type EditorSnapshot, isLocked, type PostEditor } from "../../post-detail/editor.ts";
import { Body, Section } from "./fields.tsx";

const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/** What the feed shows before "…devamı" (Instagram ~125 characters, LinkedIn ~210, Facebook ~480). */
export const FEED_PREVIEW: Record<Platform, number> = {
  instagram: 125,
  facebook: 480,
  linkedin: 210,
};

export function CaptionPanel({
  snapshot,
  editor,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const { content } = snapshot;
  const platforms: Platform[] = content.targetPlatforms.length
    ? content.targetPlatforms
    : ["instagram"];
  const [platform, setPlatform] = useState<Platform>(platforms[0] ?? "instagram");
  const initial = splitCaption(content.caption);
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState<string[]>(initial.hashtags);
  const [tagInput, setTagInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const locked = isLocked(content);

  useEffect(() => {
    if (dirty) return;
    const fresh = splitCaption(content.caption);
    setBody(fresh.body);
    setTags(fresh.hashtags);
  }, [content.caption, dirty]);

  const caption = joinCaption({ body: body.trim(), hashtags: tags });
  const count = characterCount(caption);
  const limit = CAPTION_LIMIT[platform];
  const tagLimit = HASHTAG_LIMIT[platform] ?? null;
  const preview = FEED_PREVIEW[platform];
  const bodyCount = characterCount(body);
  const over = count > limit || (tagLimit !== null && tags.length > tagLimit);
  // The feed cut inside the body: where "…devamı" falls.
  const cutAt = useMemo(
    () => (bodyCount > preview ? Array.from(body).slice(0, preview).join("").length : null),
    [body, bodyCount, preview],
  );

  const save = async () => {
    const ok = await editor.saveCaption(caption);
    if (ok) setDirty(false);
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3">
        <div role="tablist" aria-label="Platform" className="flex rounded-full bg-field p-0.5">
          {platforms.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
              className={cn(
                "h-7 flex-1 rounded-full text-body",
                platform === p ? "bg-popover text-fg shadow-sm" : "text-fg-2 hover:text-fg",
              )}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <Section
        title="Açıklama"
        action={
          <span className={cn("text-footnote tabular-nums", over ? "text-danger" : "text-fg-3")}>
            {count.toLocaleString("tr-TR")} / {limit.toLocaleString("tr-TR")}
          </span>
        }
      >
        <Body>
          <div className="rounded-[14px] bg-field px-3 py-2 focus-within:ring-2 focus-within:ring-accent/70">
            <textarea
              aria-label="Açıklama"
              value={body}
              disabled={locked}
              rows={9}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
              className="w-full resize-none bg-transparent text-body text-fg outline-none"
            />
            {cutAt !== null && (
              <div className="mt-1 flex items-center gap-2 text-caption text-fg-3">
                <span className="h-px flex-1 bg-hairline" />
                ilk {preview} karakter akışta görünür
              </div>
            )}
          </div>
        </Body>
      </Section>
      <Section
        title="Hashtag'ler"
        action={
          <span
            className={cn(
              "text-footnote tabular-nums",
              tagLimit !== null && tags.length > tagLimit ? "text-danger" : "text-fg-3",
            )}
          >
            {tags.length}
            {tagLimit !== null ? ` / ${tagLimit}` : ""}
          </span>
        }
      >
        <Body className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-control pr-1 pl-2 text-footnote text-fg"
            >
              {t}
              {!locked && (
                <button
                  type="button"
                  aria-label={`${t} kaldır`}
                  onClick={() => {
                    setTags(tags.filter((x) => x !== t));
                    setDirty(true);
                  }}
                  className="flex size-4 items-center justify-center rounded-full text-fg-3 hover:bg-control-hover hover:text-fg"
                >
                  <IconClose size={10} />
                </button>
              )}
            </span>
          ))}
          {!locked && (
            <input
              aria-label="Hashtag ekle"
              placeholder="+ etiket"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "," || e.key === " ") {
                  e.preventDefault();
                  const add = parseHashtags(tagInput).filter((t) => !tags.includes(t));
                  if (add.length) {
                    setTags([...tags, ...add]);
                    setDirty(true);
                  }
                  setTagInput("");
                }
              }}
              className="h-6 w-24 rounded-full bg-transparent px-2 text-footnote text-fg outline-none placeholder:text-fg-3 focus:bg-field"
            />
          )}
        </Body>
      </Section>
      <Section title="İlk yorum">
        <Body>
          <input
            aria-label="İlk yorum"
            disabled
            placeholder="Yayın hattı ilk yorumu henüz göndermiyor"
            className="h-7 w-full rounded-full bg-field px-3 text-body text-fg-3 outline-none"
          />
        </Body>
      </Section>
      <Section title="Alternatif metin">
        <Body>
          <textarea
            aria-label="Alternatif metin"
            disabled
            rows={2}
            placeholder="Kare başına alternatif metin: yayıncılar destekliyor, içerik modeli henüz saklamıyor"
            className="w-full resize-none rounded-[14px] bg-field px-3 py-1.5 text-body text-fg-3 outline-none"
          />
        </Body>
      </Section>
      {dirty && !locked && (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-hairline bg-page px-4 py-2.5">
          <Button
            variant="ghost"
            onClick={() => {
              const fresh = splitCaption(content.caption);
              setBody(fresh.body);
              setTags(fresh.hashtags);
              setDirty(false);
            }}
          >
            Vazgeç
          </Button>
          <Button
            variant="primary"
            disabled={over || snapshot.savingCaption}
            onClick={() => void save()}
          >
            {snapshot.savingCaption ? "Kaydediliyor…" : "Açıklamayı kaydet"}
          </Button>
        </div>
      )}
    </div>
  );
}
