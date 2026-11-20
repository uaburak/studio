// "+ Yeni post" on the posts screen: a blank canvas ("Boş tuvalden yeni post", no AI) or a brand
// template ("Şablondan yeni post"); both need the brand the board shows.
import { useState } from "react";
import { Button } from "../../components/ui/controls.tsx";
import { IconPlus } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { TemplatePicker } from "../brand/template-use.tsx";
import { BlankCanvasDialog } from "./blank-canvas-dialog.tsx";

export function NewPostMenu({ brandId }: { brandId: string | null }) {
  const [blank, setBlank] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const noBrand = brandId ? {} : { disabled: true, detail: "Önce bir marka seç" };
  const entries = (): MenuEntry[] => [
    {
      id: "blank-canvas",
      label: "Boş tuvalden yeni post…",
      ...noBrand,
      onSelect: () => setBlank(brandId),
    },
    {
      id: "from-template",
      label: "Şablondan yeni post…",
      ...noBrand,
      onSelect: () => setPicking(brandId),
    },
  ];
  return (
    <>
      <MenuButton entries={entries} placement="bottom-start" label="Yeni post" width={240}>
        {({ ref, onClick, onKeyDown, open: _open, ...aria }) => (
          <Button
            ref={ref as (el: HTMLButtonElement | null) => void}
            variant="secondary"
            icon={<IconPlus size={14} strokeWidth={1.75} />}
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...aria}
          >
            Yeni post
          </Button>
        )}
      </MenuButton>
      {blank && <BlankCanvasDialog brandId={blank} onClose={() => setBlank(null)} />}
      {picking && <TemplatePicker brandId={picking} onClose={() => setPicking(null)} />}
    </>
  );
}
