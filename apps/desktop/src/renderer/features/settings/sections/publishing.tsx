// Ayarlar → Yayın: who publishes (the cloud publisher or this Mac), the cloud publisher's address
// and token (the token goes straight to the API's vault and is never shown again), last sync,
// and removing it.
import type { PublishingStatus } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SETUP_GUIDE } from "../../../../shared/accounts-ipc.ts";
import { Button, Spinner, TextField } from "../../../components/ui/controls.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { isHostUp, useHost } from "../../../state/studio.tsx";
import { numbered } from "../../accounts/model.ts";
import { ITEMS } from "../catalog.ts";
import { FormFooter, Pane, Row, useConfirm } from "../parts.tsx";

export const publishingKey = ["publishing-status"] as const;

export function dayAndTime(iso: string): string {
  return new Date(iso).toLocaleString("tr-TR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Son eşitleme" lines (empty: the row hides). */
export function syncLines(status: PublishingStatus | undefined, error: string | null): string[] {
  const lines: string[] = [];
  if (status?.cloud.lastSyncAt) {
    const failed = status.cloud.lastSyncOk === false;
    lines.push(
      `${dayAndTime(status.cloud.lastSyncAt)}${failed ? ` — hata: ${status.cloud.lastSyncError ?? ""}` : ""}`,
    );
  }
  if (status && !status.vaultReady) {
    lines.push("Token kasası anahtarı yok: API'yi Studio başlatmadıysa hesaplar kaydedilemez.");
  }
  if (error) lines.push(error);
  return lines;
}

export function PublishingSection() {
  const api = useApi();
  const up = isHostUp(useHost());
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const status = useQuery({
    queryKey: publishingKey,
    queryFn: () => api.publishing.status(),
    enabled: up,
    staleTime: 15_000,
  });
  const [url, setUrl] = useState("");
  const token = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const cloud = status.data?.cloud.configured === true;
  useEffect(() => {
    if (status.data?.cloud.url) setUrl((u) => u || (status.data?.cloud.url ?? ""));
  }, [status.data?.cloud.url]);

  const store = (next: PublishingStatus) => queryClient.setQueryData(publishingKey, next);

  const save = async () => {
    const address = url.trim();
    const secret = token.current?.value.trim() ?? "";
    if (!address || !secret) {
      setMessage({ text: "Adres ve PUBLISHER_TOKEN ikisi de gerekli.", error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      store(await api.publishing.setCloud({ url: address, token: secret }));
      if (token.current) token.current.value = "";
      setMessage({
        text: "Bulut yayıncıya bağlanıldı. Bekleyen zamanlamalar birkaç saniye içinde gönderilir.",
        error: false,
      });
    } catch (e) {
      setMessage({ text: describeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const sync = syncLines(status.data, status.isError ? describeError(status.error) : null);
  const syncProblem =
    status.data?.cloud.lastSyncOk === false || status.data?.vaultReady === false || status.isError;

  return (
    <Pane title="Yayın">
      <Row
        item={ITEMS.publisher}
        detail={
          cloud
            ? "Onaylanan zamanlamalar buluta gönderilir; Mac kapalıyken de paylaşılır."
            : "Zamanlanan saatte Mac açık ve Studio çalışıyor olmalı. Instagram ve Facebook görselleri için bulut yayıncı gerekir (Meta görseli herkese açık bir adresten indirir)."
        }
      >
        <span className="text-body text-fg-2">
          {status.isLoading ? <Spinner size={12} /> : cloud ? "Bulut yayıncı" : "Bu Mac"}
        </span>
      </Row>
      {sync.length > 0 && (
        <Row
          item={ITEMS.lastSync}
          detail={sync.join("\n")}
          detailTone={syncProblem ? "accent" : "default"}
        />
      )}
      <Row
        item={ITEMS.cloudPublisher}
        footer={
          <FormFooter
            fields={
              <>
                {!cloud && (
                  <p className="selectable text-footnote whitespace-pre-line text-fg-2">
                    {`Kurulum (bir kez, Cloudflare hesabınla):\n${numbered(SETUP_GUIDE.cloud)}`}
                  </p>
                )}
                <TextField
                  aria-label="Bulut yayıncı adresi"
                  placeholder="Adres (ör. https://publish.burakkoc.net)"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <TextField
                  ref={token}
                  aria-label="PUBLISHER_TOKEN"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    cloud ? "PUBLISHER_TOKEN (kayıtlı; değiştirmek için yaz)" : "PUBLISHER_TOKEN"
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save();
                  }}
                />
              </>
            }
            buttons={
              <Button
                disabled={busy || !up}
                icon={busy ? <Spinner size={12} /> : undefined}
                onClick={() => void save()}
              >
                Kaydet ve dene
              </Button>
            }
            message={message?.text ?? null}
            messageTone={message?.error ? "danger" : "default"}
          />
        }
      />
      {cloud && (
        <Row item={ITEMS.removeCloudPublisher}>
          <Button
            onClick={() =>
              confirm({
                title: "Bulut yayıncı kaldırılsın mı?",
                message:
                  "Bundan sonra yayını bu Mac yapar (zamanlanan saatte açık olmalı). Buluta zaten gönderilmiş siparişler orada kalır ve paylaşılır; istemiyorsan önce Takvim'den iptal et.",
                confirm: "Kaldır",
                danger: true,
                onConfirm: async () => {
                  try {
                    store(await api.publishing.clearCloud());
                    setUrl("");
                    setMessage({ text: "Bulut yayıncı kaldırıldı.", error: false });
                  } catch (e) {
                    setMessage({ text: describeError(e), error: true });
                  }
                },
              })
            }
          >
            Kaldır
          </Button>
        </Row>
      )}
    </Pane>
  );
}
