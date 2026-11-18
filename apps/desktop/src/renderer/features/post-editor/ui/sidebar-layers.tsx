// The open post's layers in the app's sidebar: under the sidebar's navigation, where the
// conversations are otherwise (the `sidebar` slot), Wecra's own Layers panel — its tree, its rows:
// select, ⇧ / ⌘ ranges, rename (double-click), eye, lock, drag to reorder and regroup, collapse —
// in the sidebar's look (wecra.css, `.wecra-sidebar-layers`): a "Katmanlar" header like the brand
// groups' (it folds the list, remembered), the frames ("Kare 1" …) as collapsible group headers,
// their layers as sidebar rows. They are in the sidebar, not in the right panel, because the right
// panel switches between Düzenle (Wecra's Design panel) and Sohbet while the layers are needed in
// both (picking what to talk about is picking layers): Wecra's / Figma's arrangement, layers left
// of the canvas, properties right.
import type { EditorController } from "@/editor/controller";
import { GroupHeader } from "../../../components/shell/sidebar.tsx";
import { WecraLayers, WecraScope } from "../wecra/host.tsx";
import { useWorkspaceStore } from "../workspace-store.ts";

export function SidebarLayers({ ed }: { ed: EditorController | null }) {
  const open = useWorkspaceStore((s) => s.layersOpen);
  return (
    <section
      aria-label="Katmanlar"
      data-sidebar-layers=""
      className="flex min-h-0 flex-1 flex-col pb-3"
    >
      <GroupHeader
        label="Katmanlar"
        expanded={open}
        onToggle={() => useWorkspaceStore.getState().setLayersOpen(!open)}
      />
      {open &&
        (ed ? (
          <WecraScope ed={ed}>
            <WecraLayers sidebar className="min-h-0 flex-1" />
          </WecraScope>
        ) : (
          <p className="px-5 pt-1 text-footnote text-fg-3">Katmanlar hazırlanıyor…</p>
        ))}
    </section>
  );
}
