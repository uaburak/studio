// Ayarlar → Cihazlar: pairing an iPhone (the QR card of features/devices, shown on demand: it
// makes a pairing offer) and the paired iPhones with "Kaldır" (its token stops working at once).
import type { Device } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Spinner } from "../../../components/ui/controls.tsx";
import { IconPhone } from "../../../components/ui/icons.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { formatAgo } from "../../../lib/format.ts";
import { isHostUp, useHost } from "../../../state/studio.tsx";
import { PairingCard, usePairingController } from "../../devices/phone-pane.tsx";
import { ITEMS } from "../catalog.ts";
import { Note, Pane, Row, useConfirm } from "../parts.tsx";

/** The pairing QR card while it is on screen (the shared controller keeps the offer fresh). */
export function LivePairingCard({ onPaired }: { onPaired?: () => void }) {
  const controller = usePairingController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.show();
    return () => controller.hide();
  }, [controller]);
  const paired = snapshot.phase.kind === "paired";
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;
  useEffect(() => {
    if (paired) onPairedRef.current?.();
  }, [paired]);
  return <PairingCard controller={controller} snapshot={snapshot} />;
}

export const devicesKey = ["devices"] as const;

export function useDevices() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: devicesKey,
    queryFn: async () => (await api.devices.list()).items,
    enabled: up,
    staleTime: 15_000,
  });
}

export function deviceDetail(device: Device, now: Date = new Date()): string {
  const platform = { ios: "iPhone", ipados: "iPad", macos: "Mac", other: "Cihaz" }[device.platform];
  const seen = device.lastSeenAt
    ? `Son bağlantı ${formatAgo(device.lastSeenAt, now)}`
    : "Henüz bağlanmadı";
  return `${platform} · ${seen} · Eşleşme ${formatAgo(device.createdAt, now)}`;
}

export function deviceSearchText(device: Device): string {
  return `${device.name} iphone cihaz telefon eşleşmiş kaldır`;
}

export function DevicesSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const devices = useDevices();
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = (devices.data ?? []).filter((d) => d.revokedAt === null);

  const revoke = async (device: Device) => {
    setRemoving(device.id);
    setError(null);
    try {
      await api.devices.revoke(device.id);
      await queryClient.invalidateQueries({ queryKey: devicesKey });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Pane title="Cihazlar">
      <Row
        item={ITEMS.pairPhone}
        footer={
          pairing ? (
            <div className="mx-auto max-w-[360px]">
              <LivePairingCard
                onPaired={() => void queryClient.invalidateQueries({ queryKey: devicesKey })}
              />
            </div>
          ) : undefined
        }
      >
        <Button
          variant={pairing ? "secondary" : "primary"}
          icon={pairing ? undefined : <IconPhone size={14} />}
          onClick={() => setPairing((p) => !p)}
        >
          {pairing ? "Gizle" : "QR kodunu göster"}
        </Button>
      </Row>
      {devices.isLoading && <Note>Cihazlar okunuyor…</Note>}
      {devices.isError && <Note tone="danger">{describeError(devices.error)}</Note>}
      {error && <Note tone="danger">{error}</Note>}
      {devices.isSuccess && active.length === 0 && <Note>Eşleşmiş iPhone yok.</Note>}
      {active.map((device) => (
        <Row
          key={device.id}
          id={`device:${device.id}`}
          title={device.name}
          detail={deviceDetail(device)}
        >
          <Button
            disabled={removing === device.id}
            icon={removing === device.id ? <Spinner size={12} /> : undefined}
            aria-label={`${device.name}: kaldır`}
            onClick={() =>
              confirm({
                title: `${device.name} kaldırılsın mı?`,
                message:
                  "Bu iPhone Studio'ya bir daha bağlanamaz; yeniden kullanmak için QR kodla tekrar eşleştir.",
                confirm: "Kaldır",
                danger: true,
                onConfirm: () => void revoke(device),
              })
            }
          >
            Kaldır
          </Button>
        </Row>
      ))}
    </Pane>
  );
}
