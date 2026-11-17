// Ayarlar → Markalar in Claude's tabs + table layout: "Etkin | Arşiv" tabs, a search field and
// "+ Yeni marka" on top; a table of brands (language, connected platforms, "Ayarlar" /
// "Geri yükle").
import type { Brand, SocialAccount } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { platformName } from "../../../../shared/token-health.ts";
import { Button, IconButton, SegmentedControl, Spinner } from "../../../components/ui/controls.tsx";
import { IconEllipsis, IconPlus, PlatformIcon } from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { useAppStore } from "../../../state/app-store.ts";
import { queryKeys, useAccounts, useBrands } from "../../../state/studio.tsx";
import { PLATFORMS } from "../../accounts/model.ts";
import { BrandForm, createBrandFromDraft, useBrandDraft } from "../../onboarding/brand-form.tsx";
import { languageLabel } from "../../onboarding/model.ts";
import { ITEMS } from "../catalog.ts";
import { Pane, Table, type TableRow, TitleCell, Toolbar, useSettingsFilter } from "../parts.tsx";
import { closeSettings } from "../store.ts";

type Tab = "active" | "archived";

export function brandSearchText(brand: Brand): string {
  return `${brand.name} ${brand.slug} ${languageLabel(brand.defaultLanguage)} marka ${brand.status === "archived" ? "arşiv" : ""}`;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toLocaleUpperCase("tr-TR"))
      .join("") || "?"
  );
}

/** Open the brand's own page (profile, kit, accounts). */
export function openBrand(brandId: string) {
  const store = useAppStore.getState();
  store.setCurrentBrand(brandId);
  store.navigate({ kind: "brand", id: brandId });
  closeSettings();
}

export function BrandsSection() {
  const filter = useSettingsFilter();
  const api = useApi();
  const queryClient = useQueryClient();
  const brands = useBrands();
  const accounts = useAccounts();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = [...(brands.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  // While searching, both tabs' brands are found.
  const shown = filter.searching ? all : all.filter((b) => b.status === tab);

  const restore = async (brand: Brand) => {
    setRestoring(brand.id);
    setError(null);
    try {
      await api.brands.update(brand.id, { status: "active" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.brands });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRestoring(null);
    }
  };

  const rows: TableRow[] = shown.map((brand) =>
    brandRow(brand, {
      current: brand.id === currentBrandId,
      accounts: accounts.data ?? [],
      restoring: restoring === brand.id,
      onRestore: () => void restore(brand),
    }),
  );
  const toolbarHit = !filter.searching || filter.visible(ITEMS.newBrand.id);

  return (
    <Pane title="Markalar" showTitle={false}>
      {toolbarHit && (
        <div data-settings-row={filter.searching ? ITEMS.newBrand.id : undefined}>
          <Toolbar
            search={query}
            onSearch={filter.searching ? undefined : setQuery}
            placeholder="Markalarda ara"
            trailing={
              <Button
                variant="primary"
                icon={<IconPlus size={14} strokeWidth={2} />}
                title={ITEMS.newBrand.detail}
                onClick={() => setCreating((c) => !c)}
              >
                Yeni marka
              </Button>
            }
          >
            {!filter.searching && (
              <SegmentedControl<Tab>
                label="Marka sekmeleri"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "active", label: "Etkin" },
                  { value: "archived", label: "Arşiv" },
                ]}
              />
            )}
          </Toolbar>
        </div>
      )}
      {creating && <NewBrandCard onDone={() => setCreating(false)} />}
      {error && <p className="pb-2 text-body text-danger">{error}</p>}
      <Table
        label="Markalar"
        columns={[
          { title: "Marka" },
          { title: "Dil", width: 110 },
          { title: "Hesaplar", width: 110 },
          { title: "", width: 150 },
        ]}
        rows={rows}
        localQuery={filter.searching ? "" : query}
        empty={
          brands.isLoading
            ? "Yükleniyor…"
            : tab === "active"
              ? "Henüz marka yok."
              : "Arşivde marka yok."
        }
      />
    </Pane>
  );
}

function brandRow(
  brand: Brand,
  ctx: {
    current: boolean;
    accounts: SocialAccount[];
    restoring: boolean;
    onRestore(): void;
  },
): TableRow {
  const archived = brand.status === "archived";
  const connected = PLATFORMS.filter((p) =>
    ctx.accounts.some(
      (a) => a.brandId === brand.id && a.platform === p && a.status === "connected",
    ),
  );
  const menu: MenuEntry[] = archived
    ? [{ id: "restore", label: "Geri yükle", onSelect: ctx.onRestore }]
    : [
        {
          id: "switch",
          label: "Bu markaya geç",
          disabled: ctx.current,
          onSelect: () => useAppStore.getState().setCurrentBrand(brand.id),
        },
        { id: "settings", label: "Marka ayarları…", onSelect: () => openBrand(brand.id) },
      ];
  return {
    id: `brand:${brand.id}`,
    searchText: brandSearchText(brand),
    dimmed: archived,
    cells: [
      <TitleCell
        key="t"
        icon={
          <span className="flex size-6 items-center justify-center rounded-full bg-control text-caption font-medium text-fg-2">
            {initials(brand.name)}
          </span>
        }
        title={brand.name}
        subtitle={brand.slug}
        tag={ctx.current ? "Seçili" : archived ? "Arşiv" : undefined}
        muted={archived}
      />,
      <span key="l" className="truncate text-fg-2">
        {languageLabel(brand.defaultLanguage)}
      </span>,
      <span
        key="a"
        className="flex items-center gap-1.5 text-icon"
        title={connected.map(platformName).join(", ") || "Bağlı hesap yok"}
      >
        {connected.length === 0 ? (
          <span className="text-fg-3">—</span>
        ) : (
          connected.map((p) => <PlatformIcon key={p} platform={p} size={15} />)
        )}
      </span>,
      <div key="x" className="flex items-center justify-end gap-1.5">
        {archived ? (
          <Button
            size="sm"
            disabled={ctx.restoring}
            icon={ctx.restoring ? <Spinner size={12} /> : undefined}
            aria-label={`${brand.name}: geri yükle`}
            onClick={ctx.onRestore}
          >
            Geri yükle
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={`${brand.name}: ayarlar`}
            onClick={() => openBrand(brand.id)}
          >
            Ayarlar
          </Button>
        )}
        <MenuButton entries={menu} width={190} label={`${brand.name}: seçenekler`}>
          {({ open, ref, ...props }) => (
            <IconButton
              ref={ref}
              {...props}
              size={24}
              selected={open}
              tooltip={false}
              label={`${brand.name}: seçenekler`}
              icon={<IconEllipsis size={14} />}
            />
          )}
        </MenuButton>
      </div>,
    ],
  };
}

function NewBrandCard({ onDone }: { onDone(): void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { draft, setDraft, problem } = useBrandDraft();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const touched = draft.name.length > 0;
  const submit = async () => {
    if (problem || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const { brand, warning } = await createBrandFromDraft(api, draft);
      await queryClient.invalidateQueries({ queryKey: queryKeys.brands });
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      useAppStore.getState().setCurrentBrand(brand.id);
      if (warning) setMessage(warning);
      else onDone();
    } catch (e) {
      setMessage(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-3 rounded-[12px] border border-border p-4 animate-fade-in">
      <h4 className="mb-3 text-heading font-semibold text-fg">Yeni marka</h4>
      <BrandForm draft={draft} onChange={setDraft} onSubmit={() => void submit()} autoFocus />
      <div className="mt-4 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-footnote text-danger">
          {message ?? (touched ? (problem ?? "") : "")}
        </p>
        <Button onClick={onDone}>Vazgeç</Button>
        <Button
          variant="primary"
          disabled={problem !== null || saving}
          icon={saving ? <Spinner size={12} /> : undefined}
          onClick={() => void submit()}
        >
          Oluştur
        </Button>
      </div>
    </div>
  );
}
