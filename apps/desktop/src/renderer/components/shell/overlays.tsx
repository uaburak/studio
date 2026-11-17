// Window overlays: ⌘K search palette, the compact settings sheet (the full one comes with
// wave 2) and the host status banner.
import type { Conversation } from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Appearance } from "../../../shared/ipc.ts";
import { formatAgo } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useBrands, useConversations, useHost, useSettings } from "../../state/studio.tsx";
import {
  Button,
  cn,
  IconButton,
  SearchField,
  SegmentedControl,
  Switch,
  TextField,
} from "../ui/controls.tsx";
import { IconChat, IconClose, IconPlus, IconWarning } from "../ui/icons.tsx";

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

export function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const { settings, update } = useSettings();
  const host = useHost();
  const [name, setName] = useState(settings.ownerName);
  useEffect(() => {
    if (open) setName(settings.ownerName);
  }, [open, settings.ownerName]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open) return null;
  const status = host?.status;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes (Esc does too)
    <div
      className="fixed inset-0 z-[96] flex items-center justify-center bg-black/30 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Ayarlar"
        className="w-[560px] animate-pop-in rounded-[14px] bg-popover shadow-popover"
      >
        <div className="flex h-12 items-center border-b border-hairline pr-2 pl-5">
          <h2 className="flex-1 text-heading font-semibold text-fg">Ayarlar</h2>
          <IconButton
            icon={<IconClose size={16} />}
            label="Kapat"
            shortcut="Esc"
            onClick={() => setOpen(false)}
          />
        </div>
        <div className="px-5">
          <SettingRow title="Görünüm" description="Sistem, açık ya da koyu tema.">
            <SegmentedControl<Appearance>
              label="Görünüm"
              value={settings.appearance}
              onChange={(appearance) => update({ appearance })}
              options={[
                { value: "system", label: "Sistem" },
                { value: "light", label: "Açık" },
                { value: "dark", label: "Koyu" },
              ]}
            />
          </SettingRow>
          <SettingRow title="Adın" description="Kenar çubuğunda ve karşılamada görünür.">
            <TextField
              className="w-[220px]"
              placeholder="Claude hesabındaki ad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => update({ ownerName: name.trim() })}
            />
          </SettingRow>
          <SettingRow
            title="Bildirimler"
            description="Uzun işler bitince ve yanıt hazır olunca macOS bildirimi."
          >
            <Switch
              label="Bildirimler"
              checked={settings.notificationsEnabled}
              onChange={(on) => update({ notificationsEnabled: on })}
            />
          </SettingRow>
          <SettingRow
            title="Yerel ağdan erişim"
            description="iPhone'un bu Mac'e Wi‑Fi üzerinden bağlanması (yeniden başlatınca)."
          >
            <Switch
              label="Yerel ağdan erişim"
              checked={settings.lanEnabled}
              onChange={(on) => update({ lanEnabled: on })}
            />
          </SettingRow>
          <SettingRow
            title="Mac sunucusu"
            description={
              status?.kind === "running"
                ? "Bu uygulama çalıştırıyor."
                : status?.kind === "attached"
                  ? "Çalışan Studio sunucusuna bağlı."
                  : status?.kind === "error"
                    ? status.message
                    : status?.kind === "starting"
                      ? status.message
                      : "Kapalı"
            }
            last
          >
            <Button
              variant="secondary"
              disabled={status?.kind === "attached"}
              onClick={() => void window.studio?.host.restart()}
            >
              Yeniden başlat
            </Button>
          </SettingRow>
        </div>
        <p className="border-t border-hairline px-5 py-3 text-footnote text-fg-3">
          Markalar, hesaplar ve yayın ayarları bir sonraki sürümde bu pencereye gelecek.
        </p>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
  last,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[68px] items-center gap-6 py-3",
        !last && "border-b border-hairline",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-body-lg text-fg">{title}</div>
        <div className="selectable text-body text-fg-2">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
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
