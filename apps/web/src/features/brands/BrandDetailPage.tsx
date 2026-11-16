import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { useApi } from "../../api.ts";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { IconArchive, IconEdit } from "../../components/icons.tsx";
import { BrandMark, PageHeader } from "../../components/page.tsx";
import { ErrorState, SkeletonRows } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import { Badge, Button, Tag } from "../../components/ui.tsx";
import { useBrands } from "../../lib/brand-context.tsx";
import { languageLabel } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { AccountsPanel } from "./AccountsPanel.tsx";
import { BrandFormDialog } from "./BrandFormDialog.tsx";
import { ProfilesPanel } from "./ProfilesPanel.tsx";

export function BrandDetailPage() {
  const { brandId = "" } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { brandId: selectedId, setBrandId } = useBrands();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.brands.one(brandId),
    queryFn: ({ signal }) => api.brands.get(brandId, { signal }),
  });

  const archive = useMutation({
    mutationFn: (status: "active" | "archived") => api.brands.update(brandId, { status }),
    onSuccess: (brand) => {
      qc.setQueryData(queryKeys.brands.one(brandId), brand);
      void qc.invalidateQueries({ queryKey: queryKeys.brands.all });
      toast.success(brand.status === "archived" ? "Marka arşivlendi" : "Marka arşivden çıkarıldı");
      setConfirmArchive(false);
    },
    onError: (e) => toast.error(e),
  });

  if (query.isPending) return <SkeletonRows rows={5} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const brand = query.data;
  const archived = brand.status === "archived";

  return (
    <>
      <PageHeader
        back={{ to: "/markalar", label: "Markalar" }}
        eyebrow={
          <>
            <span className="font-mono">/{brand.slug}</span>
            <Tag>{languageLabel(brand.defaultLanguage)}</Tag>
            {archived && <Badge tone="neutral">Arşivde</Badge>}
            {selectedId === brand.id && <Badge tone="accent">Seçili marka</Badge>}
          </>
        }
        title={
          <span className="flex items-center gap-4">
            <BrandMark
              id={brand.id}
              name={brand.name}
              size={52}
              className="hidden sm:inline-flex"
            />
            {brand.name}
          </span>
        }
        actions={
          <>
            {selectedId !== brand.id && !archived && (
              <Button variant="secondary" onClick={() => setBrandId(brand.id)}>
                Bu markada çalış
              </Button>
            )}
            <Button
              variant="secondary"
              icon={<IconEdit size={18} />}
              onClick={() => setEditing(true)}
            >
              Düzenle
            </Button>
            <Button
              variant={archived ? "secondary" : "ghost"}
              icon={<IconArchive size={18} />}
              onClick={() => (archived ? archive.mutate("active") : setConfirmArchive(true))}
              loading={archive.isPending && archived}
            >
              {archived ? "Arşivden çıkar" : "Arşivle"}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <ProfilesPanel brandId={brand.id} />
        <AccountsPanel brandId={brand.id} readOnly={archived} />
      </div>

      <BrandFormDialog
        open={editing}
        onClose={() => setEditing(false)}
        brand={brand}
        onSaved={(saved) => qc.setQueryData(queryKeys.brands.one(brandId), saved)}
      />
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => archive.mutate("archived")}
        loading={archive.isPending}
        title="Marka arşivlensin mi?"
        message="Marka silinmez; listelerden ve marka seçiciden kalkar. Arşivdeki markaya yeni içerik eklenemez. İstediğiniz zaman geri alabilirsiniz."
        confirmLabel="Arşivle"
        danger
      />
    </>
  );
}
