// Window overlays: ⌘K search palette and the host status banner (Ayarlar lives in
// features/settings).
import type { Conversation } from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAgo } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useBrands, useConversations, useHost } from "../../state/studio.tsx";
import { Button, cn, SearchField } from "../ui/controls.tsx";
import { IconChat, IconPlus, IconWarning } from "../ui/icons.tsx";

/** Turkish-insensitive match ("İ" / "i", "ş" / "s" …). */
export function fold(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function searchConversations(list: Conversation[], query: string): Conversation[] {
  const q = fold(query.trim());
  if (!q) return list.slice(0, 12);
  return list.filter((c) => fold(c.title).includes(q)).slice(0, 30);
}

export function SearchPalette() {
  const open = useAppStore((s) => s.searchOpen);
  const setOpen = useAppStore((s) => s.setSearchOpen);
  const navigate = useAppStore((s) => s.navigate);
  const conversations = useConversations();
  const brands = useBrands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const results = useMemo(
    () => searchConversations(conversations.data ?? [], query),
    [conversations.data, query],
  );
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);
  if (!open) return null;
  const choose = (index: number) => {
    setOpen(false);
    if (index === results.length) navigate({ kind: "new" });
    const c = results[index];
    if (c) navigate({ kind: "conversation", id: c.id });
  };
  const brandName = (id: string | null) => brands.data?.find((b) => b.id === id)?.name ?? "Genel";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes (Esc does too)
    <div
      className="fixed inset-0 z-[96] flex justify-center bg-black/20 pt-[14vh] animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Ara"
        className="glass h-fit w-[560px] animate-pop-in overflow-hidden rounded-[14px]"
      >
        <div className="p-2.5">
          <SearchField
            ref={input}
            className="w-full"
            placeholder="Sohbetlerde ara"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(active);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="scroll-area max-h-[360px] border-t border-hairline p-1">
          {results.length === 0 && <p className="px-3 py-3 text-body text-fg-3">Sonuç yok.</p>}
          {results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left",
                i === active && "bg-control",
              )}
            >
              <IconChat size={14} className="shrink-0 text-icon" />
              <span className="min-w-0 flex-1 truncate text-body text-fg">
                {c.title || "Adsız sohbet"}
              </span>
              <span className="shrink-0 text-caption text-fg-3">
                {brandName(c.brandId)} · {formatAgo(c.lastActivityAt)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onMouseEnter={() => setActive(results.length)}
            onClick={() => choose(results.length)}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left",
              active === results.length && "bg-control",
            )}
          >
            <IconPlus size={14} className="shrink-0 text-icon" />
            <span className="text-body text-fg">Yeni sohbet</span>
            <span className="ml-auto text-caption text-fg-3">⌘N</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** A thin line under the top bar while the host starts or after it failed. */
export function HostBanner() {
  const host = useHost();
  const status = host?.status;
  if (!status || status.kind === "running" || status.kind === "attached") return null;
  if (status.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-b border-hairline bg-danger/8 px-4 py-2 text-body text-fg"
      >
        <IconWarning size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="selectable">{status.message}</div>
          {status.log && (
            <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-caption text-fg-2">
              {status.log}
            </pre>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={() => void window.studio?.host.restart()}>
          Yeniden dene
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-4 py-1.5 text-footnote text-fg-2">
      <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      {status.kind === "starting" ? status.message : "Studio sunucusu kapalı"}
    </div>
  );
}
