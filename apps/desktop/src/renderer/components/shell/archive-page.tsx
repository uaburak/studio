// Arşiv: the archived conversations (newest activity first, 50 at a time), searchable by
// title. A row opens the conversation (read-only until it is taken back); "Arşivden çıkar"
// puts it back in the sidebar.
import type { Brand, Conversation } from "@studio/contract";
import { useMemo, useState } from "react";
import { describeError } from "../../lib/api.ts";
import { formatAgo } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import { isHostUp, useArchivedConversations, useBrands, useHost } from "../../state/studio.tsx";
import { Button, SearchField } from "../ui/controls.tsx";
import { IconArchive } from "../ui/icons.tsx";
import { useConversationActions } from "./conversation-actions.ts";
import { fold } from "./overlays.tsx";

export function filterArchived(list: Conversation[], query: string): Conversation[] {
  const q = fold(query.trim());
  return q ? list.filter((c) => fold(c.title || "Adsız sohbet").includes(q)) : list;
}

export function ArchivePage() {
  const host = useHost();
  const archived = useArchivedConversations();
  const brands = useBrands();
  const actions = useConversationActions();
  const navigate = useAppStore((s) => s.navigate);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const all = useMemo(() => archived.data?.pages.flatMap((p) => p.items) ?? [], [archived.data]);
  const shown = filterArchived(all, query);

  const restore = async (conversation: Conversation) => {
    setBusy(conversation.id);
    try {
      if (await actions.unarchive(conversation)) {
        useAppStore.getState().showToast({
          message: `“${conversation.title || "Adsız sohbet"}” arşivden çıkarıldı`,
          action: {
            label: "Aç",
            run: () => navigate({ kind: "conversation", id: conversation.id }),
          },
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="scroll-area min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[758px] flex-col gap-3 px-6 pt-6 pb-10">
        <SearchField
          className="w-full"
          placeholder="Arşivde ara"
          aria-label="Arşivde ara"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!isHostUp(host) ? (
          <p className="text-body text-fg-2">Studio sunucusu hazırlanıyor…</p>
        ) : archived.isLoading ? (
          <p className="text-body text-fg-2">Arşiv yükleniyor…</p>
        ) : archived.isError ? (
          <p className="text-body text-danger" role="alert">
            Arşiv yüklenemedi: {describeError(archived.error)}
          </p>
        ) : all.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-body text-fg-2">
            <IconArchive size={22} strokeWidth={1.5} className="text-fg-3" />
            Arşivde sohbet yok. Kenar çubuğunda bir sohbetin “…” menüsünden “Arşivle” ile buraya
            taşıyabilirsin.
          </div>
        ) : (
          <ul aria-label="Arşivlenen sohbetler" className="flex flex-col">
            {shown.map((c) => (
              <ArchiveRow
                key={c.id}
                conversation={c}
                brandName={brandName(brands.data, c.brandId)}
                busy={busy === c.id}
                onOpen={() => navigate({ kind: "conversation", id: c.id })}
                onRestore={() => void restore(c)}
              />
            ))}
            {shown.length === 0 && (
              <li className="py-6 text-center text-body text-fg-3">Sonuç yok.</li>
            )}
          </ul>
        )}
        {archived.hasNextPage && (
          <Button
            className="self-center"
            disabled={archived.isFetchingNextPage}
            onClick={() => void archived.fetchNextPage()}
          >
            {archived.isFetchingNextPage ? "Yükleniyor…" : "Daha fazla göster"}
          </Button>
        )}
      </div>
    </div>
  );
}

function brandName(brands: Brand[] | undefined, id: string | null): string {
  if (!id) return "Genel";
  return brands?.find((b) => b.id === id)?.name ?? "Arşivlenmiş marka";
}

function ArchiveRow({
  conversation,
  brandName,
  busy,
  onOpen,
  onRestore,
}: {
  conversation: Conversation;
  brandName: string;
  busy: boolean;
  onOpen(): void;
  onRestore(): void;
}) {
  return (
    <li className="flex h-11 items-center gap-3 border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left hover:bg-control"
      >
        <span className="min-w-0 flex-1 truncate text-body text-fg">
          {conversation.title || "Adsız sohbet"}
        </span>
        <span className="shrink-0 text-caption text-fg-3">
          {brandName} · {formatAgo(conversation.lastActivityAt)}
        </span>
      </button>
      <Button size="sm" disabled={busy} onClick={onRestore}>
        {busy ? "Çıkarılıyor…" : "Arşivden çıkar"}
      </Button>
    </li>
  );
}
