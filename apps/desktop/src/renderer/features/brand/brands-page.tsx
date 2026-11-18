// "Markalar" (sidebar): the list of brands first — logo or initials, name and short name,
// language, connected platforms, profile and status — with "Etkin | Arşiv", search and
// "+ Yeni marka". A row opens the brand's profile; back comes here again.
import type { Brand, SocialAccount } from "@studio/contract";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  cn,
  SearchField,
  SegmentedControl,
  TagPill,
} from "../../components/ui/controls.tsx";
import { IconChevronRight, IconPlus, IconTag } from "../../components/ui/icons.tsx";
import { useAppStore } from "../../state/app-store.ts";
import { useAccounts, useBrands } from "../../state/studio.tsx";
import { PageHeader } from "../pane-ui.tsx";
import { cardProfile, useBrandKit, useBrandProfiles } from "./brand-data.ts";
import { brandCard, languageLabel, platformsSummary } from "./brand-model.ts";
import { BrandMark, NewBrandSheet, PlatformIcons } from "./brand-views.tsx";
import { useNewBrandRequest } from "./new-brand-request.ts";

type Filter = "active" | "archived";

const fold = (text: string) => text.toLocaleLowerCase("tr-TR");

/** Brands of the tab (search looks at both tabs), by name. */
export function brandsShown(brands: readonly Brand[], filter: Filter, query: string): Brand[] {
  const q = fold(query.trim());
  return [...brands]
    .filter((b) =>
      q
        ? [b.name, b.slug, languageLabel(b.defaultLanguage)].some((f) => fold(f).includes(q))
        : b.status === filter,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

export default function BrandsPage() {
  const brands = useBrands();
  const accounts = useAccounts();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  // Git → Yeni marka… (⇧⌘N).
  const newBrandRequested = useNewBrandRequest((s) => s.pending);
  useEffect(() => {
    if (!newBrandRequested) return;
    setCreating(true);
    useNewBrandRequest.setState({ pending: false });
  }, [newBrandRequested]);
  const all = brands.data ?? [];
  const shown = useMemo(() => brandsShown(all, filter, query), [all, filter, query]);
  const count = (status: Filter) => all.filter((b) => b.status === status).length;
  const searching = query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Markalar"
        subtitle={
          brands.isPending
            ? "Yükleniyor…"
            : `${count("active")} etkin marka${count("archived") ? ` · ${count("archived")} arşivde` : ""}`
        }
        actions={
          <Button
            variant="primary"
            icon={<IconPlus size={14} strokeWidth={2} />}
            onClick={() => setCreating(true)}
          >
            Yeni marka
          </Button>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SegmentedControl<Filter>
            label="Marka durumu"
            value={searching ? null : filter}
            onChange={(next) => {
              setFilter(next);
              setQuery("");
            }}
            options={[
              { value: "active", label: "Etkin", count: count("active") },
              { value: "archived", label: "Arşiv", count: count("archived") },
            ]}
          />
          <div className="flex-1" />
          <SearchField
            aria-label="Markalarda ara"
            placeholder="Markalarda ara"
            className="w-[260px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </PageHeader>
      <div className="scroll-area min-h-0 flex-1 px-8 pb-12">
        {brands.isPending ? null : all.length === 0 ? (
          <div className="flex flex-col items-start gap-2 pt-2 text-body text-fg-2">
            <span className="text-icon">
              <IconTag size={18} />
            </span>
            <p>Henüz marka yok.</p>
            <Button
              size="sm"
              icon={<IconPlus size={12} strokeWidth={2} />}
              onClick={() => setCreating(true)}
            >
              Yeni marka
            </Button>
          </div>
        ) : (
          <table aria-label="Markalar" className="w-full table-fixed border-collapse text-body">
            <colgroup>
              <col />
              <col style={{ width: "12%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <thead>
              <tr className="h-8 border-b border-hairline text-footnote text-fg-3">
                <th className="px-3 text-left font-normal">Marka</th>
                <th className="px-3 text-left font-normal">Dil</th>
                <th className="px-3 text-left font-normal">Hesaplar</th>
                <th className="px-3 text-left font-normal">Profil</th>
                <th className="px-3 text-left font-normal">Durum</th>
                <th className="px-3">
                  <span className="sr-only">Aç</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-body text-fg-3">
                    {searching
                      ? `“${query.trim()}” için marka yok.`
                      : filter === "archived"
                        ? "Arşivde marka yok."
                        : "Etkin marka yok."}
                  </td>
                </tr>
              ) : (
                shown.map((brand) => (
                  <BrandRow
                    key={brand.id}
                    brand={brand}
                    accounts={accounts.data ?? []}
                    current={brand.id === currentBrandId}
                  />
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
      <NewBrandSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function BrandRow({
  brand,
  accounts,
  current,
}: {
  brand: Brand;
  accounts: SocialAccount[];
  current: boolean;
}) {
  const navigate = useAppStore((s) => s.navigate);
  const kit = useBrandKit(brand.id);
  const profiles = useBrandProfiles(brand.id);
  const card = brandCard({ brand, kit: kit.data, profile: cardProfile(profiles.data), accounts });
  const summary = platformsSummary(card.platforms);
  const archived = brand.status === "archived";
  const open = () => navigate({ kind: "brand", id: brand.id });
  const cell = "px-3 py-2.5 align-middle";
  return (
    // The name's button is the keyboard path; the whole row is the mouse target.
    <tr
      onClick={open}
      className="group h-[60px] border-b border-hairline transition-colors duration-150 hover:bg-control"
    >
      <td className={cell}>
        <span className="flex min-w-0 items-center gap-3">
          <BrandMark
            name={card.name}
            initials={card.initials}
            logoAssetId={card.logoAssetId}
            color={card.swatches[0]?.hex ?? null}
            size={34}
          />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-label={`${brand.name}: marka profilini aç`}
                onClick={(event) => {
                  event.stopPropagation();
                  open();
                }}
                className={cn(
                  "truncate rounded-full text-left text-body-lg font-medium",
                  archived ? "text-fg-2" : "text-fg",
                )}
              >
                {brand.name}
              </button>
              {current && <TagPill tone="accent">Seçili</TagPill>}
            </span>
            <span className="truncate text-footnote text-fg-3">{brand.slug}</span>
          </span>
        </span>
      </td>
      <td className={cn(cell, "truncate text-fg-2")}>{languageLabel(brand.defaultLanguage)}</td>
      <td className={cell} title={summary.text}>
        <span className="flex min-w-0 items-center gap-2">
          <PlatformIcons lines={card.platforms} />
          <span
            className={cn(
              "truncate text-footnote",
              summary.attention ? "text-accent-text" : "text-fg-3",
            )}
          >
            {summary.text}
          </span>
        </span>
      </td>
      <td className={cn(cell, "truncate text-fg-2")}>{card.profileLine}</td>
      <td className={cell}>
        {archived ? <TagPill>Arşivde</TagPill> : <TagPill tone="success">Etkin</TagPill>}
      </td>
      <td className={cn(cell, "text-right text-fg-3 group-hover:text-fg-2")}>
        <IconChevronRight size={14} strokeWidth={1.75} className="inline" />
      </td>
    </tr>
  );
}
