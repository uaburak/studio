// Marka pane of the right panel (Wecra "Panel – Marka"): the brand card (logo or initials,
// name, colours, fonts, voice, platforms and their state) with "Marka profili" (the full
// profile / kit editor) and "AI ile analiz et" (`brand.analyze`); the name opens the brand
// switcher with "Yeni marka…".
import { useState } from "react";
import { Button, cn, Spinner } from "../../components/ui/controls.tsx";
import { IconChevronDown, IconPlus, IconTag } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { percentText } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useAccounts, useBrands, useConversations } from "../../state/studio.tsx";
import { FieldLabel, PaneMessage } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import {
  cardProfile,
  useAnalysisJob,
  useBrandActions,
  useBrandKit,
  useBrandProfiles,
  useWorkerOnline,
} from "./brand-data.ts";
import { analysisBlocker, brandCard, platformsSummary } from "./brand-model.ts";
import { BrandMark, NewBrandSheet, PlatformIcons, Swatches } from "./brand-views.tsx";

export function BrandPane() {
  const { brandId, brand } = usePanelBrand();
  const brands = useBrands();
  const [creating, setCreating] = useState(false);
  if (!brandId || !brand) {
    const loading = brands.isLoading;
    return (
      <>
        <PaneMessage
          icon={<IconTag size={18} />}
          text={
            loading
              ? "Markalar yükleniyor…"
              : (brands.data ?? []).length === 0
                ? "Henüz marka yok."
                : "Başlıktaki menüden bir marka seç."
          }
          action={
            loading ? undefined : (
              <Button
                size="sm"
                icon={<IconPlus size={12} strokeWidth={2} />}
                onClick={() => setCreating(true)}
              >
                Yeni marka
              </Button>
            )
          }
        />
        <NewBrandSheet open={creating} onClose={() => setCreating(false)} />
      </>
    );
  }
  return <BrandCardView key={brandId} brandId={brandId} />;
}

function BrandCardView({ brandId }: { brandId: string }) {
  const { brand } = usePanelBrand();
  const brands = useBrands();
  const accounts = useAccounts();
  const kit = useBrandKit(brandId);
  const profiles = useBrandProfiles(brandId);
  const actions = useBrandActions();
  const analysis = useAnalysisJob(brandId);
  const workerOnline = useWorkerOnline();
  const navigate = useAppStore((s) => s.navigate);
  const route = useAppStore((s) => s.route);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const showToast = useAppStore((s) => s.showToast);
  const conversations = useConversations();
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  if (!brand) return null;

  const card = brandCard({
    brand,
    kit: kit.data,
    profile: cardProfile(profiles.data),
    accounts: accounts.data ?? [],
  });
  const summary = platformsSummary(card.platforms);
  // Inside a conversation the pane shows that conversation's brand (fixed once set).
  const locked =
    route.kind === "conversation" &&
    Boolean((conversations.data ?? []).find((c) => c.id === route.id)?.brandId);

  const menu = (): MenuEntry[] => [
    ...(locked
      ? [{ type: "label" as const, label: "Bu sohbetin markası" }]
      : [
          { type: "label" as const, label: "Marka" },
          ...(brands.data ?? [])
            .filter((b) => b.status === "active")
            .map((b) => ({
              id: b.id,
              label: b.name,
              checked: b.id === brandId,
              onSelect: () => setCurrentBrand(b.id),
            })),
        ]),
    { type: "separator" },
    {
      id: "new",
      label: "Yeni marka…",
      icon: <IconPlus size={14} strokeWidth={1.5} />,
      onSelect: () => setCreating(true),
    },
  ];

  const analyze = async () => {
    const blocker = analysisBlocker({ brand, kit: kit.data, workerOnline });
    if (blocker) {
      showToast({
        message: blocker,
        action: {
          label: "Marka kitini aç",
          run: () => navigate({ kind: "brand", id: brandId }),
        },
      });
      return;
    }
    setStarting(true);
    try {
      await actions.analyze(brandId);
      showToast({ message: "Marka analizi başladı; bitince taslak profil hazır olur." });
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <section aria-label={card.name} className="flex flex-col gap-3.5 rounded-[12px] bg-field p-4">
        <div className="flex items-center gap-3">
          <BrandMark
            name={card.name}
            initials={card.initials}
            logoAssetId={card.logoAssetId}
            color={card.swatches[0]?.hex ?? null}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <MenuButton entries={menu} placement="bottom-start" label="Marka seç" width={240}>
              {({ ref, onClick, onKeyDown, open, ...aria }) => (
                <button
                  ref={ref}
                  type="button"
                  {...aria}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                  className={cn(
                    "-ml-1.5 flex h-[26px] max-w-full items-center gap-1 self-start rounded-full px-1.5 hover:bg-control",
                    open && "bg-control",
                  )}
                >
                  <span className="truncate text-prose font-semibold text-fg">{card.name}</span>
                  <IconChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-fg-2" />
                </button>
              )}
            </MenuButton>
            <span className="truncate text-footnote text-fg-2">
              {card.subtitle} · {card.profileLine}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>Renkler</FieldLabel>
          {card.swatches.length > 0 ? (
            <Swatches swatches={card.swatches} />
          ) : (
            <span className="text-body text-fg-3">Renk yok — marka kitinden ekle.</span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel>Yazı tipleri</FieldLabel>
          <span className={cn("text-body", card.fonts.length ? "text-fg" : "text-fg-3")}>
            {card.fonts.length ? card.fonts.join(" · ") : "Yazı tipi yok."}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel>Ton</FieldLabel>
          <p className={cn("selectable text-body", card.voice ? "text-fg" : "text-fg-3")}>
            {card.voice ?? "Henüz ton yazılmadı. AI analizi markanın sesini çıkarır."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel>Platformlar</FieldLabel>
          <div className="flex items-center gap-2">
            <PlatformIcons lines={card.platforms} />
            <span
              className={cn(
                "truncate text-footnote",
                summary.attention ? "text-accent-text" : "text-fg-2",
              )}
            >
              {summary.text}
            </span>
          </div>
        </div>

        {analysis && (
          <div className="flex items-center gap-2 text-footnote text-fg-2" role="status">
            <Spinner size={12} />
            <span className="min-w-0 flex-1 truncate">
              {analysis.status === "queued"
                ? "Analiz sırada…"
                : (analysis.progressMessage ?? "Marka analiz ediliyor…")}
            </span>
            {analysis.progress !== undefined && (
              <span className="text-fg-3 tabular-nums">{percentText(analysis.progress * 100)}</span>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate({ kind: "brand", id: brandId })}>Marka profili</Button>
          <Button
            variant="primary"
            disabled={starting || analysis !== null}
            onClick={() => void analyze()}
          >
            {analysis ? "Analiz ediliyor…" : "AI ile analiz et"}
          </Button>
        </div>
      </section>
      <NewBrandSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
