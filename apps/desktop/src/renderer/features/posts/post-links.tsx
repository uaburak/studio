// What an open post is linked to (N9, N10): the post it was converted from ("Kaynak: … postu"),
// the template it was made from, and the stories / Reels made from it — each opens with a click.
// `usePostConversions` adds "Şablon olarak kaydet…", "Story'ye dönüştür" and "Reels'e dönüştür"
// to the post's "…" menu.
import type { Content, RepurposeTarget } from "@studio/contract";
import { type ReactNode, useState } from "react";
import { Button, TextField } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useDerivedPosts, useTemplateActions, useTemplateList } from "../brand/templates-data.ts";
import {
  conversionBlocker,
  conversionLabel,
  conversionMade,
  templateBlocker,
} from "../brand/templates-model.ts";
import { useContent } from "./data.ts";
import { usePostsStore } from "./store.ts";

const KIND: Record<"story" | "reel", string> = { story: "Story", reel: "Reels" };

function LinkButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="truncate text-left text-accent-text underline-offset-2 hover:underline"
    >
      {children}
    </button>
  );
}

/** "Kaynak", "Şablon" and "Dönüştürülenler" lines; nothing when the post has no links. */
export function PostLinks({ content, className }: { content: Content; className?: string }) {
  const source = content.source ?? null;
  const sourcePost = useContent(source?.contentId ?? null);
  const templates = useTemplateList(content.templateId ? content.brandId : null);
  const derived = useDerivedPosts(content.type === "reel" ? null : content.id);
  const template = templates.data?.find((t) => t.id === content.templateId) ?? null;
  const made = derived.data ?? [];
  const open = (id: string) => usePostsStore.getState().open(id);
  if (!source && !content.templateId && made.length === 0) return null;
  return (
    <section
      aria-label="Bağlantılar"
      className={className ?? "flex flex-col gap-1.5 text-footnote text-fg-2"}
    >
      {source && (
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-fg-3">Kaynak:</span>
          {sourcePost.data ? (
            <LinkButton onClick={() => open(source.contentId)}>
              “{sourcePost.data.title}” postu (v{source.version})
            </LinkButton>
          ) : (
            <span className="text-fg-3">silinmiş bir post</span>
          )}
          <span className="shrink-0 text-fg-3">→ {KIND[source.kind]}</span>
        </div>
      )}
      {content.templateId && (
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-fg-3">Şablon:</span>
          <LinkButton
            onClick={() =>
              useAppStore
                .getState()
                .navigate({ kind: "brand", id: content.brandId, tab: "templates" })
            }
          >
            {template ? `“${template.name}”` : "şablonu aç"}
          </LinkButton>
        </div>
      )}
      {made.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 text-fg-3">Dönüştürülenler:</span>
          {made.map((p) => (
            <LinkButton key={p.id} onClick={() => open(p.id)}>
              {p.title}
            </LinkButton>
          ))}
        </div>
      )}
    </section>
  );
}

/** The post menu's template and conversion entries, and the dialog they open. */
export function usePostConversions(content: Content): {
  entries: MenuEntry[];
  dialog: ReactNode;
} {
  const actions = useTemplateActions();
  const showToast = useAppStore((s) => s.showToast);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(content.title);
  const [busy, setBusy] = useState(false);
  const saveBlocker = templateBlocker(content);

  const convert = async (target: RepurposeTarget) => {
    try {
      const res = await actions.convert(content, target);
      showToast({ message: conversionMade(target, content.title) });
      usePostsStore.getState().open(res.content.id);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const t = await actions.create(content, name);
      showToast({
        message: `“${t.name}” şablonu kaydedildi (${t.fields.filter((f) => !f.locked).length} alan).`,
        action: {
          label: "Şablonlar",
          run: () =>
            useAppStore
              .getState()
              .navigate({ kind: "brand", id: content.brandId, tab: "templates" }),
        },
      });
      setSaving(false);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const entry = (target: RepurposeTarget): MenuEntry => {
    const blocker = conversionBlocker(content, target);
    return {
      id: `repurpose-${target}`,
      label: conversionLabel(target),
      disabled: !!blocker,
      ...(blocker ? { detail: blocker } : {}),
      onSelect: () => void convert(target),
    };
  };

  const entries: MenuEntry[] = [
    {
      id: "save-template",
      label: "Şablon olarak kaydet…",
      disabled: !!saveBlocker,
      ...(saveBlocker ? { detail: saveBlocker } : {}),
      onSelect: () => {
        setName(content.title);
        setSaving(true);
      },
    },
    entry("story"),
    entry("reel"),
  ];

  const dialog = (
    <Dialog
      open={saving}
      title="Şablon olarak kaydet"
      onClose={() => setSaving(false)}
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={() => setSaving(false)} disabled={busy}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            data-autofocus=""
            onClick={() => void save()}
            disabled={busy || !name.trim()}
          >
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-fg-2">
          Postun yerleşimi markanın şablonu olur. Başlık, metin, çağrı ve görsel yuvaları
          doldurulabilir alan olur; logo ve imza sabit kalır.
        </p>
        <TextField
          aria-label="Şablonun adı"
          className="w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
    </Dialog>
  );
  return { entries, dialog };
}
