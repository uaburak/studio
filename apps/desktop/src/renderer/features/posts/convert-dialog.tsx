// "Dönüştür" on the Postlar bulk bar (N10): the picked posts into stories or Reels — one new post
// per source, linked to it ("Kaynak: … postu"), each made by its own job. Posts that cannot be
// converted (a Reels, a story to a story, no design yet) are said before and after.
import type { RepurposeTarget } from "@studio/contract";
import { useMemo, useState } from "react";
import { Button, SegmentedControl } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { describeError } from "../../lib/api.ts";
import { useTemplateActions } from "../brand/templates-data.ts";
import { conversionBlocker } from "../brand/templates-model.ts";
import type { PostCard } from "./board.ts";
import { toast } from "./trash.ts";

const TARGETS: { value: RepurposeTarget; label: string }[] = [
  { value: "story", label: "Story" },
  { value: "reel", label: "Reels" },
];

/** The picked posts a conversion takes and the ones it leaves (with the reason). */
export function convertible(cards: readonly PostCard[], target: RepurposeTarget) {
  const take: PostCard[] = [];
  const skip: { card: PostCard; reason: string }[] = [];
  for (const card of cards) {
    const reason = conversionBlocker(card.content, target);
    if (reason) skip.push({ card, reason });
    else take.push(card);
  }
  return { take, skip };
}

export function ConvertDialog({
  open,
  cards,
  onClose,
  onDone,
}: {
  open: boolean;
  cards: PostCard[];
  onClose(): void;
  onDone(): void;
}) {
  const actions = useTemplateActions();
  const [target, setTarget] = useState<RepurposeTarget>("story");
  const [busy, setBusy] = useState(false);
  const { take, skip } = useMemo(() => convertible(cards, target), [cards, target]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await actions.convertMany(
        take.map((c) => c.id),
        target,
      );
      const label = target === "story" ? "story" : "Reels";
      toast({
        message:
          res.created.length === 1
            ? `1 ${label} hazırlanıyor.`
            : `${res.created.length} ${label} hazırlanıyor.`,
      });
      if (res.skipped.length)
        toast({
          message: `${res.skipped.length} post dönüştürülmedi: ${res.skipped[0]?.message ?? ""}`,
        });
      onDone();
    } catch (error) {
      toast({ message: describeError(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Postları dönüştür"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            data-autofocus=""
            disabled={busy || take.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Başlatılıyor…" : `Dönüştür (${take.length})`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-body">
        <SegmentedControl<RepurposeTarget>
          label="Neye dönüşsün"
          value={target}
          onChange={setTarget}
          options={TARGETS}
        />
        <p className="text-fg-2">
          {target === "story"
            ? "Her post için 1080×1920 bir story: aynı marka tasarımı, postun metinleri story'ye uyarlanır, üst ve alt güvenli alanlar boş kalır."
            : "Her post için hareketli grafik bir Reels: postun kareleri sahne, görselleri sahne görseli, çağrısı kapanış olur."}
        </p>
        <p className="text-footnote text-fg-3">
          Yeni postlar kaynaklarına bağlı taslak olarak gelir; kaynak postlar değişmez.
        </p>
        {skip.length > 0 && (
          <ul className="flex flex-col gap-1">
            {skip.map(({ card, reason }) => (
              <li key={card.id} className="truncate text-footnote text-fg-3">
                {card.content.title}: {reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
