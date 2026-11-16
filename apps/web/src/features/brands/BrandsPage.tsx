import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { IconBrands, IconPlus } from "../../components/icons.tsx";
import { BrandMark, PageHeader } from "../../components/page.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../../components/states.tsx";
import { Badge, Button, Segmented, Tag } from "../../components/ui.tsx";
import { useBrands } from "../../lib/brand-context.tsx";
import { formatDate } from "../../lib/datetime.ts";
import { languageLabel } from "../../lib/labels.ts";
import { BrandFormDialog } from "./BrandFormDialog.tsx";

type Filter = "active" | "archived" | "all";

export function BrandsPage() {
  const { brands, isLoading, error, brandId, setBrandId } = useBrands();
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const visible = brands.filter((b) => filter === "all" || b.status === filter);
  const archivedCount = brands.filter((b) => b.status === "archived").length;

  return (
    <>
      <PageHeader
        title="Markalar"
        description="Her markanın tasarım dili, ses tonu ve sosyal hesapları."
        actions={
          <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setCreating(true)}>
            Yeni marka
          </Button>
        }
      />

      <div className="mb-5">
        <Segmented
          name="brand-filter"
          label="Marka durumu"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "active", label: "Aktif" },
            { value: "archived", label: `Arşiv${archivedCount ? ` · ${archivedCount}` : ""}` },
            { value: "all", label: "Tümü" },
          ]}
        />
      </div>

      {isLoading ? (
        <SkeletonGrid count={6} aspect="aspect-[5/3]" />
      ) : error ? (
        <ErrorState error={error} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === "archived" ? "Arşivde marka yok" : "Henüz marka yok"}
          glyph={<IconBrands size={24} />}
          action={
            filter !== "archived" && (
              <Button
                variant="primary"
                icon={<IconPlus size={18} />}
                onClick={() => setCreating(true)}
              >
                İlk markayı oluştur
              </Button>
            )
          }
        >
          {filter !== "archived" &&
            "Bir marka oluşturun; profilini, hesaplarını ve içeriklerini buradan yönetin."}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((brand) => (
            <li key={brand.id}>
              <Link
                to={`/markalar/${brand.id}`}
                className="group flex h-full flex-col gap-5 rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line/70 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:ring-line-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <BrandMark id={brand.id} name={brand.name} size={48} />
                  <div className="flex items-center gap-1.5">
                    {brand.id === brandId && <Badge tone="accent">Seçili</Badge>}
                    {brand.status === "archived" && <Badge tone="neutral">Arşivde</Badge>}
                  </div>
                </div>
                <div className="min-w-0">
                  <h2 className="font-display text-[30px] leading-none text-ink group-hover:text-accent">
                    {brand.name}
                  </h2>
                  <p className="mt-1.5 font-mono text-[12px] text-ink-3">/{brand.slug}</p>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                  <Tag>{languageLabel(brand.defaultLanguage)}</Tag>
                  <span>{formatDate(brand.createdAt)} tarihinde eklendi</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <BrandFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(brand) => {
          setBrandId(brand.id);
          navigate(`/markalar/${brand.id}`);
        }}
      />
    </>
  );
}
