// Top bar pieces of the posts screen: the Sohbet | Postlar switch's behaviour and the title
// ("Kasım postları ⌄", or the opened post's title) with the brand scope menu.
import { cn } from "../../components/ui/controls.tsx";
import { IconChevronDown } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { type Route, useAppStore } from "../../state/app-store.ts";
import { useBrands } from "../../state/studio.tsx";
import { useContent } from "./data.ts";
import { monthKeyOf, monthName } from "./dates.ts";
import { usePostsStore } from "./store.ts";

export type Mode = "chat" | "posts";

export function modeOf(route: Route): Mode | null {
  if (route.kind === "posts") return "posts";
  // Only chats light up "Sohbet"; Takvim, Medya, Marka and the gallery select neither.
  return route.kind === "new" || route.kind === "conversation" ? "chat" : null;
}

/** Postlar opens the board; Sohbet goes back to the last chat (else a new one). */
export function switchMode(mode: Mode): void {
  const app = useAppStore.getState();
  if (mode === "posts") {
    app.navigate({ kind: "posts" });
    return;
  }
  if (app.route.kind !== "posts") return;
  const lastChat = [...app.back]
    .reverse()
    .find((r) => r.kind === "conversation" || r.kind === "new");
  usePostsStore.getState().close();
  app.navigate(lastChat ?? { kind: "new" });
}

export function PostsTitleButton() {
  const opened = usePostsStore((s) => s.opened);
  const month = usePostsStore((s) => s.month);
  const allBrands = usePostsStore((s) => s.allBrands);
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const brands = useBrands();
  const content = useContent(opened?.contentId ?? null);
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
  ];
  return (
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
  );
}
