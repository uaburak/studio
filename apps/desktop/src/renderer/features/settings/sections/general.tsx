// Ayarlar → Görünüm (theme, name), Bildirimler and Hakkında (version, data folder, onboarding,
// keyboard shortcuts).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Appearance } from "../../../../shared/ipc.ts";
import { Button, SegmentedControl, Switch, TextField } from "../../../components/ui/controls.tsx";
import { useJobs, useSettings } from "../../../state/studio.tsx";
import { systemBridge } from "../../accounts/use-accounts.ts";
import { openOnboarding } from "../../onboarding/store.ts";
import { ITEMS } from "../catalog.ts";
import { Pane, Row } from "../parts.tsx";
import { closeSettings } from "../store.ts";

export function AppearanceSection() {
  const { settings, update } = useSettings();
  const { presence } = useJobs();
  const [name, setName] = useState(settings.ownerName);
  useEffect(() => setName(settings.ownerName), [settings.ownerName]);
  const save = () => {
    const trimmed = name.trim();
    setName(trimmed);
    if (trimmed !== settings.ownerName) update({ ownerName: trimmed });
  };
  return (
    <Pane title="Görünüm">
      <Row item={ITEMS.theme}>
        <SegmentedControl<Appearance>
          label={ITEMS.theme.title}
          value={settings.appearance}
          onChange={(appearance) => update({ appearance })}
          options={[
            { value: "system", label: "Sistem" },
            { value: "light", label: "Açık" },
            { value: "dark", label: "Koyu" },
          ]}
        />
      </Row>
      <Row item={ITEMS.ownerName}>
        <TextField
          className="w-[220px]"
          aria-label={ITEMS.ownerName.title}
          placeholder={presence?.claude?.displayName ?? "Adın"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      </Row>
    </Pane>
  );
}

export function NotificationsSection() {
  const { settings, update } = useSettings();
  return (
    <Pane title="Bildirimler">
      <Row item={ITEMS.notifications} tag="Bu Mac">
        <Switch
          label={ITEMS.notifications.title}
          checked={settings.notificationsEnabled}
          onChange={(on) => update({ notificationsEnabled: on })}
        />
      </Row>
    </Pane>
  );
}

export const SHORTCUTS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Genel",
    rows: [
      ["⌘N", "Yeni sohbet"],
      ["⌘K", "Ara: sohbetler"],
      ["⌘,", "Ayarlar"],
    ],
  },
  {
    title: "Gezinme",
    rows: [
      ["⌘[  ·  ⌘]", "Geri  ·  İleri"],
      ["⌘\\", "Kenar çubuğu"],
      ["⌥⌘I", "Sağ panel: Ayrıntılar, işler, takvim, medya, marka, iPhone"],
    ],
  },
  {
    title: "Sohbet",
    rows: [
      ["↩  ·  ⇧↩", "Gönder  ·  Yeni satır"],
      ["@", "Görsel takma adı öner"],
      ["⌘V", "Görseli yapıştır (eklenir)"],
    ],
  },
  {
    title: "Ayarlar",
    rows: [
      ["⌘F", "Ayarlarda ara"],
      ["esc", "Aramayı temizle, sonra kapat"],
    ],
  },
];

export function AboutSection() {
  const system = systemBridge();
  const info = useQuery({
    queryKey: ["system-info"],
    queryFn: () => system?.info() ?? Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [shortcuts, setShortcuts] = useState(false);
  const version = info.data
    ? `${info.data.version} · Electron ${info.data.electron.split(".")[0]}`
    : system
      ? "—"
      : "Tarayıcı önizlemesi";
  return (
    <Pane title="Hakkında">
      <Row item={ITEMS.version}>
        <span className="selectable text-body text-fg-2 tabular-nums">{version}</span>
      </Row>
      <Row
        item={ITEMS.dataFolder}
        detail={`${ITEMS.dataFolder.detail}${info.data ? ` ${info.data.stateDir}` : ""}`}
      >
        <Button disabled={!system} onClick={() => void system?.reveal("data")}>
          Göster
        </Button>
      </Row>
      <Row item={ITEMS.onboarding}>
        <Button
          onClick={() => {
            closeSettings();
            openOnboarding();
          }}
        >
          Aç
        </Button>
      </Row>
      <Row
        item={ITEMS.shortcuts}
        footer={
          shortcuts ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              {SHORTCUTS.map((group) => (
                <div key={group.title}>
                  <div className="mb-1.5 text-footnote font-medium text-fg-3">{group.title}</div>
                  {group.rows.map(([keys, what]) => (
                    <div key={keys} className="flex gap-3 py-0.5 text-body">
                      <span className="w-[92px] shrink-0 text-fg-2 tabular-nums">{keys}</span>
                      <span className="min-w-0 text-fg">{what}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : undefined
        }
      >
        <Button onClick={() => setShortcuts((s) => !s)}>{shortcuts ? "Gizle" : "Göster"}</Button>
      </Row>
    </Pane>
  );
}
