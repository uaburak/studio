// A plan item's template (N9): "Şablonsuz" (designed anew) or one of the brand's templates of
// the item's type; the post is then made from it (its layout, fields filled from the brief).
import type { ContentType } from "@studio/contract";
import { cn } from "../../components/ui/controls.tsx";
import { useTemplateList } from "./templates-data.ts";

export function TemplateSelect({
  brandId,
  contentType,
  value,
  onChange,
  className,
}: {
  brandId: string;
  contentType: ContentType;
  value: string | null;
  onChange(templateId: string | null): void;
  className?: string;
}) {
  const templates = useTemplateList(brandId);
  const fitting = (templates.data ?? []).filter((t) => t.contentType === contentType);
  if (fitting.length === 0 && !value) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-footnote text-fg-2">Şablon</span>
      <select
        aria-label="Şablon"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={cn(
          "no-drag h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none hover:bg-control",
          className,
        )}
      >
        <option value="">Şablonsuz (yeni tasarım)</option>
        {fitting.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {value && !fitting.some((t) => t.id === value) && (
          <option value={value}>Bu türde olmayan şablon</option>
        )}
      </select>
    </div>
  );
}
