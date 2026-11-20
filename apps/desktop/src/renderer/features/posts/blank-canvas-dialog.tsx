// The "Boş tuvalden yeni post" sheet: type and size (and a carousel's slide count), a title;
// "Oluştur" makes the draft post with a blank canvas (blank-canvas.ts) and opens it. No AI runs.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, SegmentedControl, TextField } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  BLANK_FORM,
  BLANK_KINDS,
  BLANK_SIZES,
  type BlankForm,
  blankFormat,
  blankSlides,
  createBlankCanvasPost,
} from "./blank-canvas.ts";
import { invalidatePosts, postKeys } from "./data.ts";
import { usePostsStore } from "./store.ts";

export function BlankCanvasDialog({ brandId, onClose }: { brandId: string; onClose(): void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const [form, setForm] = useState<BlankForm>(BLANK_FORM);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<BlankForm>) => setForm((f) => ({ ...f, ...change }));
  const size = blankFormat(form);

  const submit = async () => {
    setBusy(true);
    try {
      const { content } = await createBlankCanvasPost(api, brandId, form);
      queryClient.setQueryData(postKeys.content(content.id), content);
      await invalidatePosts(queryClient);
      onClose();
      usePostsStore.getState().open(content.id);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Boş tuvalden yeni post"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Hazırlanıyor…" : "Oluştur"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          aria-label="Başlık"
          placeholder="Başlık (isteğe bağlı)"
          value={form.title}
          maxLength={200}
          onChange={(e) => set({ title: e.target.value })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">Tür</span>
          <SegmentedControl
            label="Tür"
            options={BLANK_KINDS}
            value={form.kind}
            onChange={(kind) => set({ kind })}
          />
        </div>
        {form.kind !== "story" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Boyut</span>
            <SegmentedControl
              label="Boyut"
              options={BLANK_SIZES}
              value={form.size}
              onChange={(s) => set({ size: s })}
            />
          </div>
        )}
        {form.kind === "carousel" && (
          <div className="flex items-center gap-3 text-body text-fg">
            <span>Kare sayısı</span>
            <TextField
              aria-label="Kare sayısı"
              type="number"
              min={2}
              max={20}
              className="w-[88px]"
              value={String(form.slides)}
              onChange={(e) => set({ slides: Number(e.target.value) })}
            />
          </div>
        )}
        <p className="text-footnote text-fg-3">
          {blankSlides(form)} boş kare, {size.width}×{size.height} px. Post tuvalde açılır; yapay
          zekâ çalışmaz. Tasarlayınca açıklamayı “Bilgileri üret” ile yazdırabilirsin.
        </p>
      </div>
    </Dialog>
  );
}
