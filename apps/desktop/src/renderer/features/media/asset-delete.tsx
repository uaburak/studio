// Deleting a library file (7): it goes to the trash at once with "Geri al" (10 s) and is purged
// after TRASH_RETENTION_DAYS. A file that a post, a product or the brand kit uses is not deleted:
// the API refuses (409) and the dialog lists where it is used, so the owner can change those first.
import { ApiError, type Asset, type AssetUsage } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { openPostDetail } from "../posts/store.ts";
import { UNDO_TOAST_MS } from "../posts/trash.ts";
import { mediaKeys } from "./media-data.ts";

const USAGE_GROUP: Record<AssetUsage["kind"], string> = {
  version: "Postlarda",
  editor_document: "Postlarda",
  slide: "Postlarda",
  product: "Ürünlerde",
  brand_kit: "Marka kitinde",
  conversation: "Sohbetlerde",
};

/** The blocking usages first, grouped as the dialog shows them. */
export function usageGroups(
  usages: readonly AssetUsage[],
): { title: string; items: AssetUsage[] }[] {
  const groups = new Map<string, AssetUsage[]>();
  for (const u of [...usages].sort((a, b) => Number(b.blocking) - Number(a.blocking))) {
    const title = USAGE_GROUP[u.kind];
    groups.set(title, [...(groups.get(title) ?? []), u]);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

export function useAssetDelete(brandId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [blocked, setBlocked] = useState<{ asset: Asset; usages: AssetUsage[] } | null>(null);
  const key = mediaKeys.assets(brandId);
  const toast = useAppStore.getState().showToast;

  const remove = async (asset: Asset) => {
    const name = asset.originalFilename ?? "Dosya";
    try {
      await api.assets.delete(asset.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const usage = await api.assets.usage(asset.id).catch(() => null);
        setBlocked({ asset, usages: usage?.usages ?? [] });
        if (!usage) toast({ message: describeError(e), tone: "danger" });
        return;
      }
      toast({ message: `${name}: ${describeError(e)}`, tone: "danger" });
      return;
    }
    queryClient.setQueryData<Asset[]>(key, (list) => list?.filter((a) => a.id !== asset.id));
    toast({
      message: `“${name}” Silinenler'e taşındı.`,
      durationMs: UNDO_TOAST_MS,
      action: {
        label: "Geri al",
        run: () =>
          void api.assets
            .restore(asset.id)
            .then(() => queryClient.invalidateQueries({ queryKey: key }))
            .catch((e: unknown) => toast({ message: describeError(e), tone: "danger" })),
      },
    });
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const dialog = (
    <Dialog
      open={blocked !== null}
      title="Bu dosya kullanılıyor"
      onClose={() => setBlocked(null)}
      width={480}
      footer={
        <Button variant="primary" data-autofocus="" onClick={() => setBlocked(null)}>
          Tamam
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-body">
        <p className="text-fg-2">
          “{blocked?.asset.originalFilename ?? "Dosya"}” silinemez; önce aşağıdaki yerlerden kaldır
          ya da değiştir.
        </p>
        {usageGroups(blocked?.usages ?? []).map((group) => (
          <section key={group.title}>
            <h3 className="mb-1 text-footnote font-medium text-fg-3">{group.title}</h3>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((u) => (
                <li
                  key={`${u.kind}-${u.label}`}
                  className="flex min-h-7 items-center gap-2 text-fg"
                >
                  <span className="min-w-0 flex-1 truncate">{u.label}</span>
                  {u.contentId && (
                    <button
                      type="button"
                      className="shrink-0 text-footnote text-accent-text hover:underline"
                      onClick={() => {
                        setBlocked(null);
                        openPostDetail(u.contentId as string);
                      }}
                    >
                      Postu aç
                    </button>
                  )}
                  {!u.blocking && (
                    <span className="shrink-0 text-footnote text-fg-3">engellemiyor</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );

  return { remove, dialog };
}
