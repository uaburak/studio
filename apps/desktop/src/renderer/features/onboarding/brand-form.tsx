// "Yeni marka" form (onboarding's first brand, Ayarlar → Markalar): name, short name (follows
// the name until edited), content language, optional Instagram handle.
import { type ApiClient, type Brand, slugify } from "@studio/contract";
import { useState } from "react";
import { TextField } from "../../components/ui/controls.tsx";
import { describeError } from "../../lib/api.ts";
import { Select } from "../settings/parts.tsx";
import { brandProblem, LANGUAGES, normalizedHandle } from "./model.ts";

export interface BrandDraft {
  name: string;
  slug: string;
  slugEdited: boolean;
  language: string;
  instagram: string;
}

export const EMPTY_DRAFT: BrandDraft = {
  name: "",
  slug: "",
  slugEdited: false,
  language: "tr",
  instagram: "",
};

/** The draft after typing a name: the short name follows until edited by hand. */
export function withName(draft: BrandDraft, name: string): BrandDraft {
  return { ...draft, name, slug: draft.slugEdited ? draft.slug : slugify(name) };
}

export function withSlug(draft: BrandDraft, slug: string): BrandDraft {
  return { ...draft, slug, slugEdited: slug.length > 0 };
}

export function useBrandDraft() {
  const [draft, setDraft] = useState<BrandDraft>(EMPTY_DRAFT);
  return {
    draft,
    setDraft,
    problem: brandProblem(draft.name, draft.slug),
    reset: () => setDraft(EMPTY_DRAFT),
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the TextField inside
    <label className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-footnote text-fg-2">{label}</span>
      {children}
    </label>
  );
}

export function BrandForm({
  draft,
  onChange,
  onSubmit,
  instagram = true,
  autoFocus,
}: {
  draft: BrandDraft;
  onChange(next: BrandDraft): void;
  onSubmit?(): void;
  instagram?: boolean;
  autoFocus?: boolean;
}) {
  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="Marka adı">
        <TextField
          autoFocus={autoFocus}
          aria-label="Marka adı"
          placeholder="Örn. MTM Agro"
          value={draft.name}
          onChange={(e) => onChange(withName(draft, e.target.value))}
          onKeyDown={submitOnEnter}
        />
      </Field>
      <Field label="Kısa ad">
        <TextField
          aria-label="Kısa ad"
          placeholder="mtm-agro"
          value={draft.slug}
          onChange={(e) => onChange(withSlug(draft, e.target.value))}
          onKeyDown={submitOnEnter}
        />
      </Field>
      <div className="flex items-start gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">İçerik dili</span>
          <Select
            label="İçerik dili"
            value={draft.language}
            width={180}
            onChange={(language) => onChange({ ...draft, language })}
            options={LANGUAGES.map((l) => ({ value: l.tag, label: l.label }))}
          />
        </div>
        {instagram && (
          <Field label="Instagram">
            <TextField
              aria-label="Instagram"
              placeholder="@kullaniciadi (isteğe bağlı)"
              value={draft.instagram}
              onChange={(e) => onChange({ ...draft, instagram: e.target.value })}
              onKeyDown={submitOnEnter}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/** Creates the brand (and registers the Instagram handle when given). */
export async function createBrandFromDraft(
  api: ApiClient,
  draft: BrandDraft,
): Promise<{ brand: Brand; warning: string | null }> {
  const brand = await api.brands.create({
    name: draft.name.trim(),
    slug: draft.slug,
    defaultLanguage: draft.language,
  });
  const handle = normalizedHandle(draft.instagram);
  if (!handle) return { brand, warning: null };
  try {
    await api.socialAccounts.create({ brandId: brand.id, platform: "instagram", handle });
    return { brand, warning: null };
  } catch (error) {
    return {
      brand,
      warning: `Marka oluşturuldu ama Instagram hesabı eklenemedi: ${describeError(error)}`,
    };
  }
}
