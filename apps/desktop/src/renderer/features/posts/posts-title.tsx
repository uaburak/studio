// The top bar's title on the posts screen ("Kasım postları ⌄", or the opened post's title)
// with the brand scope menu.
import { useState } from "react";
import { cn } from "../../components/ui/controls.tsx";
import { IconChevronDown } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { useAppStore } from "../../state/app-store.ts";
import { useBrands } from "../../state/studio.tsx";
import { TemplatePicker } from "../brand/template-use.tsx";
import { useContent } from "./data.ts";
import { monthKeyOf, monthName } from "./dates.ts";
import { usePostsStore } from "./store.ts";

export function PostsTitleButton() {
  const opened = usePostsStore((s) => s.opened);
  const month = usePostsStore((s) => s.month);
  const allBrands = usePostsStore((s) => s.allBrands);
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const brands = useBrands();
  const content = useContent(opened?.contentId ?? null);
  const [picking, setPicking] = useState<string | null>(null);
  const active = (brands.data ?? []).filter((b) => b.status === "active");
  const brandName = allBrands ? "Tüm markalar" : active.find((b) => b.id === currentBrandId)?.name;
  const title = opened
    ? (content.data?.title ?? "Post")
    : `${monthName(month ?? monthKeyOf(new Date()))} postları`;
  const entries = (): MenuEntry[] => [
    { type: "label", label: "Marka" },
    ...active.map((b, i) => ({
      id: b.id,
      label: b.name,
      checked: !allBrands && b.id === currentBrandId,
      shortcut: i < 9 ? String(i + 1) : undefined,
      onSelect: () => {
        setCurrentBrand(b.id);
        usePostsStore.getState().setAllBrands(false);
      },
    })),
    { type: "separator" },
    {
      id: "all",
      label: "Tüm markalar",
      checked: allBrands,
      onSelect: () => usePostsStore.getState().setAllBrands(true),
    },
    { type: "separator" },
    {
      id: "from-template",
      label: "Şablondan yeni post…",
      disabled: allBrands || !currentBrandId,
      ...(allBrands || !currentBrandId ? { detail: "Önce bir marka seç" } : {}),
      onSelect: () => setPicking(currentBrandId),
    },
  ];
  return (
    <>
      <MenuButton entries={entries} placement="bottom-start" label="Postlar menüsü" width={240}>
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            {...aria}
            onClick={onClick}
            onKeyDown={onKeyDown}
            className={cn(
              "no-drag flex h-7 max-w-[420px] min-w-0 items-center gap-1.5 rounded-full px-2.5 text-body-lg text-fg transition-colors hover:bg-control",
              open && "bg-control",
            )}
          >
            <span className="truncate">{title}</span>
            {brandName && <span className="truncate text-fg-2">· {brandName}</span>}
            <IconChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-fg-2" />
          </button>
        )}
      </MenuButton>
      {picking && <TemplatePicker brandId={picking} onClose={() => setPicking(null)} />}
    </>
  );
}
