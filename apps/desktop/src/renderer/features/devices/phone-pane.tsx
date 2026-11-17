// iPhone pane of the right panel (Wecra "Panel – iPhone"; port of StudioMac's
// PhonePairingViews): the pairing QR card (`studio://pair?...`, renewed before it expires, the
// 6-digit code with its countdown for typing by hand, "iPhone bağlandı" once a phone used it)
// and the paired devices with "Kaldır".
import type { ApiClient, Device } from "@studio/contract";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button, cn, Spinner } from "../../components/ui/controls.tsx";
import { IconCircleCheck, IconPhone, IconTablet } from "../../components/ui/icons.tsx";
import { QrCode } from "../../components/ui/qr-code.tsx";
import { useApi } from "../../lib/api.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";
import {
  activeDevices,
  codeSecondsLeft,
  countdown,
  deviceStatus,
  formatPairingCode,
  PairingController,
  type PairingSnapshot,
} from "./pairing-controller.ts";

export function pairingApi(api: ApiClient) {
  return {
    createCode: () => api.pairing.createCode(),
    routes: () => api.pairing.routes(),
    devices: async () => (await api.devices.list()).items,
    revoke: (id: string) => api.devices.revoke(id),
  };
}

// One controller for the window (like the Mac's shared PhonePairingModel): reopening the pane
// keeps the offer on screen instead of making a new one each time.
let shared: { controller: PairingController; api: { current: ApiClient | null } } | null = null;

export function usePairingController(): PairingController {
  const api = useApi();
  const up = isHostUp(useHost());
  if (!shared) {
    const ref: { current: ApiClient | null } = { current: null };
    shared = {
      api: ref,
      controller: new PairingController({
        api: () => (ref.current ? pairingApi(ref.current) : null),
      }),
    };
  }
  shared.api.current = up ? api : null;
  return shared.controller;
}

export function PhonePane() {
  const controller = usePairingController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.show();
    return () => controller.hide();
  }, [controller]);
  return (
    <div className="flex flex-col gap-3">
      <PairingCard controller={controller} snapshot={snapshot} />
      <DevicesList controller={controller} snapshot={snapshot} />
    </div>
  );
}

const STEPS_SHORT =
  "Aynı Wi‑Fi ağında doğrudan bağlanır; dışarıdayken Cloudflare tüneli kullanılır.";

export function PairingCard({
  controller,
  snapshot,
}: {
  controller: PairingController;
  snapshot: PairingSnapshot;
}) {
  const { phase } = snapshot;
  const seconds = codeSecondsLeft(snapshot.offer, Date.now());
  const qrBox = (content: React.ReactNode) => (
    <div className="flex size-[184px] items-center justify-center rounded-[12px] bg-white">
      {content}
    </div>
  );
  let visual: React.ReactNode = null;
  let title = "iPhone'u bağla";
  let body: string = STEPS_SHORT;
  let action: { label: string; run: () => void } | null = null;
  switch (phase.kind) {
    case "unavailable":
      body = phase.message || "Studio hazırlanıyor…";
      break;
    case "preparing":
      visual = qrBox(
        <span className="text-[#6d6b67]">
          <Spinner size={18} />
        </span>,
      );
      title = "iPhone'unda Studio'yu aç ve bu kodu okut";
      break;
    case "ready":
      visual = qrBox(
        snapshot.url ? (
          <QrCode text={snapshot.url} size={168} label="iPhone'u bağlamak için QR kod" />
        ) : null,
      );
      title = "iPhone'unda Studio'yu aç ve bu kodu okut";
      action = { label: "Yeni kod", run: () => void controller.renewOffer() };
      break;
    case "paired":
      visual = (
        <div className="flex size-[184px] items-center justify-center rounded-[12px] bg-accent-subtle text-accent">
          <IconCircleCheck size={56} strokeWidth={1.5} />
        </div>
      );
      title = "iPhone bağlandı";
      body = `${phase.name} artık bu Mac'e bağlı. Bundan sonra bağlantı kendiliğinden kurulur.`;
      action = { label: "Başka bir iPhone bağla", run: () => void controller.renewOffer() };
      break;
    case "failed":
      body = phase.message;
      action = { label: "Tekrar dene", run: () => void controller.renewOffer() };
      break;
  }
  return (
    <section
      aria-label="iPhone'u bağla"
      className="flex flex-col items-center gap-3 rounded-[12px] bg-field p-5 text-center"
    >
      {visual}
      <h3 className="text-body font-medium text-fg">{title}</h3>
      <p
        className={cn(
          "max-w-[270px] text-footnote",
          phase.kind === "failed" ? "text-danger" : "text-fg-2",
        )}
      >
        {body}
      </p>
      {phase.kind === "ready" && snapshot.offer && (
        <p className="selectable text-footnote text-fg-3" data-testid="pairing-code">
          {seconds > 0
            ? `Kodu elle girmek için: ${formatPairingCode(snapshot.offer.code)} · ${countdown(seconds)}`
            : "Elle girilecek kodun süresi doldu; QR kod hâlâ geçerli."}
        </p>
      )}
      {action && (
        <Button size="sm" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </section>
  );
}

function DeviceRow({ device, onRemove }: { device: Device; onRemove(): void }) {
  const status = deviceStatus(device, Date.now());
  return (
    <div className="group flex h-8 items-center gap-2.5">
      <span className="flex size-4 shrink-0 items-center justify-center text-icon">
        {device.platform === "ipados" ? (
          <IconTablet size={16} strokeWidth={1.4} />
        ) : (
          <IconPhone size={16} strokeWidth={1.4} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-body text-fg">{device.name}</span>
      <span
        className={cn(
          "shrink-0 text-footnote group-focus-within:hidden group-hover:hidden",
          status.online ? "text-success" : "text-fg-3",
        )}
      >
        {status.text}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${device.name} cihazını kaldır`}
        className="hidden h-6 shrink-0 items-center rounded-full px-2.5 text-footnote text-fg shadow-[inset_0_0_0_1px_var(--border-default)] group-focus-within:flex group-hover:flex hover:bg-control"
      >
        Kaldır
      </button>
    </div>
  );
}

export function DevicesList({
  controller,
  snapshot,
}: {
  controller: PairingController;
  snapshot: PairingSnapshot;
}) {
  const devices = activeDevices(snapshot.devices);
  const removing = useRef(new Set<string>());
  return (
    <section aria-label="Eşleşmiş cihazlar" className="flex flex-col">
      <h3 className="mb-1.5 text-body font-medium text-fg-2">Eşleşmiş cihazlar</h3>
      {devices.length === 0 ? (
        <p className="text-footnote text-fg-3">
          {snapshot.hasLoadedDevices ? "Henüz bağlı iPhone yok." : "Yükleniyor…"}
        </p>
      ) : (
        devices.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            onRemove={() => {
              if (removing.current.has(device.id)) return;
              removing.current.add(device.id);
              void controller.remove(device).finally(() => removing.current.delete(device.id));
            }}
          />
        ))
      )}
      {snapshot.message && (
        <p
          className={cn("mt-2 text-footnote", snapshot.message.error ? "text-danger" : "text-fg-2")}
        >
          {snapshot.message.text}
        </p>
      )}
    </section>
  );
}
