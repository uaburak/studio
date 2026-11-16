import { type Brand, slugify } from "@studio/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { InlineError } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import { Button, Field, Input, Select } from "../../components/ui.tsx";
import { LANGUAGE_OPTIONS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";

/** Create (no `brand`) or edit a brand. */
export function BrandFormDialog({
  open,
  onClose,
  brand,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  brand?: Brand;
  onSaved?: (brand: Brand) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [language, setLanguage] = useState("tr");

  useEffect(() => {
    if (!open) return;
    setName(brand?.name ?? "");
    setSlug(brand?.slug ?? "");
    setLanguage(brand?.defaultLanguage ?? "tr");
  }, [open, brand]);

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedSlug = slug.trim();
      if (brand) {
        return api.brands.update(brand.id, {
          name: name.trim(),
          slug: trimmedSlug || brand.slug,
          defaultLanguage: language,
        });
      }
      return api.brands.create({
        name: name.trim(),
        ...(trimmedSlug ? { slug: trimmedSlug } : {}),
        defaultLanguage: language,
      });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: queryKeys.brands.all });
      toast.success(brand ? "Marka güncellendi" : "Marka oluşturuldu", saved.name);
      onSaved?.(saved);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate();
  };

  const derived = slugify(name);
  const formId = brand ? "brand-edit-form" : "brand-create-form";

  return (
    <Dialog
      open={open}
      onClose={() => {
        mutation.reset();
        onClose();
      }}
      title={brand ? "Markayı düzenle" : "Yeni marka"}
      description={brand ? undefined : "Profil, hesaplar ve içerikler bu markaya bağlanır."}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={mutation.isPending}
            disabled={!name.trim()}
          >
            {brand ? "Kaydet" : "Oluştur"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Marka adı">
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ör. MTM Agro"
              maxLength={120}
              required
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Kısa ad (slug)"
          optional={!brand}
          hint={
            brand
              ? "Adreslerde ve klasör adlarında kullanılır."
              : derived
                ? `Boş bırakılırsa: ${derived}`
                : "Küçük harf, rakam ve tire."
          }
        >
          {(p) => (
            <Input
              {...p}
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder={derived || "mtm-agro"}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              className="font-mono"
              maxLength={64}
            />
          )}
        </Field>
        <Field label="Varsayılan dil">
          {(p) => (
            <Select {...p} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {!LANGUAGE_OPTIONS.some((o) => o.value === language) && (
                <option value={language}>{language}</option>
              )}
            </Select>
          )}
        </Field>
        <InlineError error={mutation.error} />
      </form>
    </Dialog>
  );
}
