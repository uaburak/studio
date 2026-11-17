// Ayarlar → Gelişmiş: the local host (API + LAN gateway + worker): run it here or attach, status
// and ports, LAN access, repository folder; remote access (Cloudflare Tunnel: hostname, token,
// switch); logs. Changing how the host runs restarts it, like the AppKit app.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { OAUTH_PORT } from "../../../../shared/accounts-ipc.ts";
import { Button, Switch, TextField } from "../../../components/ui/controls.tsx";
import { bridge } from "../../../lib/bridge.ts";
import { useHost, useSettings } from "../../../state/studio.tsx";
import { systemBridge } from "../../accounts/use-accounts.ts";
import { ITEMS } from "../catalog.ts";
import { FormFooter, Pane, Row, Subheader, useConfirm } from "../parts.tsx";
import { hostStatusText } from "../status-text.ts";

export const DEFAULT_REMOTE_HOSTNAME = "social.burakkoc.net";

export function normalizedHostname(raw: string): string {
  let clean = raw.trim();
  clean = clean.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return clean.length === 0 ? DEFAULT_REMOTE_HOSTNAME : clean;
}

const tunnelKey = ["tunnel-token"] as const;

function restartHost() {
  void bridge().host.restart();
}

export function AdvancedSection() {
  const { settings, update } = useSettings();
  const host = useHost();
  const system = systemBridge();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const hasToken = useQuery({
    queryKey: tunnelKey,
    queryFn: () => system?.tunnelToken.has() ?? Promise.resolve(false),
    staleTime: 60_000,
  });
  const info = useQuery({
    queryKey: ["system-info"],
    queryFn: () => system?.info() ?? Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [repo, setRepo] = useState(settings.repoPath);
  const [hostname, setHostname] = useState(settings.remoteHostname);
  const token = useRef<HTMLInputElement | null>(null);
  const [tunnelMessage, setTunnelMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => setRepo(settings.repoPath), [settings.repoPath]);
  useEffect(() => setHostname(settings.remoteHostname), [settings.remoteHostname]);

  const enabled = settings.hostEnabled;
  const status = hostStatusText(host);
  const ports = [
    host?.apiPort ? `API ${host.apiPort}` : null,
    host?.lanPort ? `Yerel ağ ${host.lanPort}` : null,
    `Hesap girişi dönüşü ${OAUTH_PORT}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const errorLog = host?.status.kind === "error" ? host.status.log : "";
  const cleanHost = normalizedHostname(settings.remoteHostname);
  const tokenSaved = hasToken.data === true;

  let remoteDetail: string;
  if (settings.remoteControlEnabled) {
    const phase = host?.services.tunnel;
    const phaseText = phase
      ? `Durum: ${phase.kind === "running" ? "çalışıyor" : phase.kind === "failed" ? "durdu (hata)" : "bekliyor"}. `
      : "";
    if (host?.tunnelNote) remoteDetail = phaseText + host.tunnelNote;
    else if (tokenSaved)
      remoteDetail = `${phaseText}Anahtar kayıtlı · eşleşmiş telefonlar ev dışından https://${cleanHost} ile bağlanır.`;
    else
      remoteDetail =
        "Kurulum: `brew install cloudflared`, sonra Cloudflare Zero Trust → Tunnels'tan aldığın CLOUDFLARE_TUNNEL_TOKEN'ı aşağıya kaydet.";
  } else {
    remoteDetail = `Kapalı. Açınca ev dışındaki iPhone https://${cleanHost} üzerinden Cloudflare Tunnel ile bağlanır.`;
  }

  const saveTunnel = async () => {
    const clean = normalizedHostname(hostname);
    setHostname(clean);
    if (clean !== settings.remoteHostname) update({ remoteHostname: clean });
    const value = token.current?.value.trim() ?? "";
    setTunnelMessage(null);
    if (value) {
      if (!system) {
        setTunnelMessage({
          text: "Anahtar yalnızca Studio uygulamasında kaydedilir.",
          error: true,
        });
        return;
      }
      const result = await system.tunnelToken.save(value);
      if (!result.ok) {
        // Keep what was typed and say so.
        setTunnelMessage({ text: result.message, error: true });
        return;
      }
      if (token.current) token.current.value = "";
      await queryClient.invalidateQueries({ queryKey: tunnelKey });
      setTunnelMessage({ text: "Anahtar bu Mac'te şifreli kaydedildi.", error: false });
    }
    if (settings.remoteControlEnabled) restartHost();
  };

  return (
    <Pane title="Gelişmiş">
      <Row item={ITEMS.hostEnabled} tag="Bu Mac">
        <Switch
          label={ITEMS.hostEnabled.title}
          checked={enabled}
          onChange={(on) => {
            update({ hostEnabled: on });
            restartHost();
          }}
        />
      </Row>
      {enabled && (
        <>
          <Row
            item={ITEMS.hostStatus}
            detail={`${status.text}\n${ports}`}
            detailTone={status.error ? "accent" : "default"}
          >
            <Button disabled={host?.status.kind === "starting"} onClick={restartHost}>
              Yeniden başlat
            </Button>
          </Row>
          <Row
            item={ITEMS.lan}
            detail={
              settings.lanEnabled
                ? (host?.lanUrls.length ?? 0) > 0
                  ? `Telefonlar: ${host?.lanUrls.join(", ")} · Bonjour ile bulunur; eşleştirme gerekir.`
                  : "Telefonlar aynı ağda Bonjour ile bulur (_studio._tcp); eşleştirme gerekir."
                : "Kapalı: API yalnızca bu Mac'ten (127.0.0.1) erişilebilir."
            }
          >
            <Switch
              label={ITEMS.lan.title}
              checked={settings.lanEnabled}
              onChange={(on) => {
                update({ lanEnabled: on });
                restartHost();
              }}
            />
          </Row>
          <Row
            item={ITEMS.repo}
            footer={
              <FormFooter
                fields={
                  <TextField
                    aria-label={ITEMS.repo.title}
                    placeholder="Depo klasörü"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  />
                }
                buttons={
                  <Button
                    disabled={!repo.trim() || repo.trim() === settings.repoPath}
                    onClick={() => {
                      update({ repoPath: repo.trim() });
                      restartHost();
                    }}
                  >
                    Kaydet
                  </Button>
                }
              />
            }
          />
          <Subheader
            title="Uzaktan erişim"
            ids={[ITEMS.remote.id, ITEMS.tunnel.id, ITEMS.forgetTunnel.id]}
          />
          <Row item={ITEMS.remote} detail={remoteDetail}>
            <Switch
              label={ITEMS.remote.title}
              checked={settings.remoteControlEnabled}
              onChange={(on) => {
                update({ remoteControlEnabled: on });
                restartHost();
              }}
            />
          </Row>
          <Row
            item={ITEMS.tunnel}
            footer={
              <FormFooter
                fields={
                  <>
                    <TextField
                      aria-label="Tünel adresi"
                      placeholder={DEFAULT_REMOTE_HOSTNAME}
                      value={hostname}
                      onChange={(e) => setHostname(e.target.value)}
                    />
                    <TextField
                      ref={token}
                      aria-label="CLOUDFLARE_TUNNEL_TOKEN"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        tokenSaved
                          ? "CLOUDFLARE_TUNNEL_TOKEN (kayıtlı; değiştirmek için yaz)"
                          : "CLOUDFLARE_TUNNEL_TOKEN"
                      }
                    />
                  </>
                }
                buttons={<Button onClick={() => void saveTunnel()}>Kaydet ve uygula</Button>}
                message={tunnelMessage?.text ?? null}
                messageTone={tunnelMessage?.error ? "danger" : "default"}
              />
            }
          />
          <Subheader title="Kayıtlar" ids={[ITEMS.errorLog.id, ITEMS.logsFolder.id]} />
          {errorLog && (
            <Row
              item={ITEMS.errorLog}
              footer={
                <pre className="selectable max-h-[120px] overflow-auto rounded-[8px] bg-field p-2 font-mono text-caption text-fg">
                  {errorLog}
                </pre>
              }
            />
          )}
          <Row
            item={ITEMS.logsFolder}
            detail={`${ITEMS.logsFolder.detail}${info.data ? ` ${info.data.logsDir}` : ""}`}
          >
            <Button disabled={!system} onClick={() => void system?.reveal("logs")}>
              Aç
            </Button>
          </Row>
          {tokenSaved && (
            <Row item={ITEMS.forgetTunnel}>
              <Button
                onClick={() =>
                  confirm({
                    title: "Tünel anahtarı silinsin mi?",
                    message: ITEMS.forgetTunnel.detail,
                    confirm: "Sil",
                    danger: true,
                    onConfirm: async () => {
                      await system?.tunnelToken.forget();
                      await queryClient.invalidateQueries({ queryKey: tunnelKey });
                      if (settings.remoteControlEnabled) restartHost();
                    },
                  })
                }
              >
                Sil
              </Button>
            </Row>
          )}
        </>
      )}
    </Pane>
  );
}
