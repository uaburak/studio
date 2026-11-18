// The layers card: Wecra's own Layers panel (its tree, its rows: select, ⇧ / ⌘ ranges, rename,
// eye, lock, drag to reorder and regroup, collapse) on a Studio glass card floating at the
// canvas's left edge. It is on the canvas, not in the right panel, because the right panel
// switches between Düzenle (Wecra's Design panel) and Sohbet, while the layers are needed in
// both (picking what to talk about is picking layers); it keeps Wecra's / Figma's arrangement
// (layers left of the canvas, properties right) without changing the app's layout, and the Design
// panel keeps the right panel's full height. It folds into a "Katmanlar" pill (remembered).
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import { IconLayers, IconSidebar } from "../../../components/ui/icons.tsx";
import { WecraLayers } from "../wecra/host.tsx";

/** Wecra's left panel width (its rows are laid out for it). */
export const LAYERS_CARD_WIDTH = 240;
/** The card's distance from the canvas's edges. */
export const LAYERS_CARD_INSET = 12;

export function LayersCard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  if (!open)
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="glass absolute top-3 left-3 z-20 flex h-8 items-center gap-1.5 rounded-full px-3 text-body text-fg transition-colors hover:text-fg"
        aria-label="Katmanları göster"
        data-layers-pill=""
      >
        <IconLayers size={14} strokeWidth={1.6} />
        Katmanlar
      </button>
    );
  return (
    <aside
      aria-label="Katmanlar"
      data-layers-card=""
      className={cn(
        "glass absolute top-3 bottom-3 left-3 z-20 flex flex-col overflow-hidden rounded-[16px]",
        "animate-fade-in",
      )}
      style={{ width: LAYERS_CARD_WIDTH }}
    >
      <WecraLayers width={LAYERS_CARD_WIDTH} className="min-h-0 flex-1" />
      <span className="absolute top-1 right-1">
        <IconButton
          size={28}
          icon={<IconSidebar size={14} strokeWidth={1.5} />}
          label="Katmanları gizle"
          onClick={() => onOpenChange(false)}
        />
      </span>
    </aside>
  );
}
