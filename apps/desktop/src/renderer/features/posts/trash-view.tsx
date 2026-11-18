// "Silinenler" (7): posts in the trash, newest deletion first, each with the day it is purged,
// "Geri al" and "Kalıcı olarak sil…". The posts keep their pictures until the purge.
import { purgeDate, TRASH_RETENTION_DAYS } from "@studio/contract";
import { Button, Spinner } from "../../components/ui/controls.tsx";
import { describeError } from "../../lib/api.ts";
import { usePostActions } from "./actions.ts";
import { platformText } from "./board.ts";
import { useCurrentVersions, useTrash } from "./data.ts";
import { shortDay } from "./dates.ts";
import { PostMedia } from "./post-media.tsx";

export function TrashView({
  brandId,
  brandName,
}: {
  brandId: string | null;
  brandName(id: string): string | undefined;
}) {
  const trash = useTrash(brandId);
  const actions = usePostActions();
  const versions = useCurrentVersions(trash.data ?? []);
  if (trash.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-24 text-body text-fg-2">
        <Spinner /> Silinenler yükleniyor…
      </div>
    );
  }
  if (trash.error) return <p className="text-body text-danger">{describeError(trash.error)}</p>;
  const list = trash.data ?? [];
  if (list.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-24 text-center">
        <p className="text-heading font-semibold text-fg">Silinenler boş</p>
        <p className="max-w-[420px] text-body text-fg-2">
          Silinen postlar {TRASH_RETENTION_DAYS} gün burada kalır; o sürede geri alabilirsin.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-footnote text-fg-2">
        Silinen postlar {TRASH_RETENTION_DAYS} gün sonra dosyalarıyla birlikte kalıcı olarak
        silinir.
      </p>
      <ul
        aria-label="Silinen postlar"
        className="grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-x-7 gap-y-6"
      >
        {list.map((content) => (
          <li
            key={content.id}
            data-card-id={content.id}
            className="flex flex-col overflow-hidden rounded-[12px] bg-field shadow-[inset_0_0_0_1px_var(--border-hairline)] [content-visibility:auto] [contain-intrinsic-size:auto_360px]"
          >
            <span className="relative block aspect-[4/5] w-full opacity-60">
              <PostMedia
                contentId={content.id}
                title={content.title}
                brandName={brandName(content.brandId)}
                version={versions.get(content.id) ?? null}
                isReel={content.type === "reel"}
                className="absolute inset-0"
              />
            </span>
            <span className="flex flex-col gap-1 p-3">
              <span className="truncate text-body font-medium text-fg">{content.title}</span>
              <span className="truncate text-footnote text-fg-2">
                {platformText(content)}
                {content.deletedAt
                  ? ` · ${shortDay(purgeDate(content.deletedAt))} tarihinde kalıcı silinir`
                  : ""}
              </span>
              <span className="mt-1.5 flex items-center gap-1.5">
                <Button variant="secondary" onClick={() => void actions.restore(content)}>
                  Geri al
                </Button>
                <Button
                  variant="ghost"
                  className="text-danger"
                  onClick={() => actions.askPurge(content)}
                >
                  Kalıcı olarak sil…
                </Button>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
