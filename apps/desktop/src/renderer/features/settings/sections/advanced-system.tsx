// Ayarlar → Gelişmiş, the packaged app's parts (P1, P2, P9): the host's health (every part,
// ok / warn / fail), starting with the Mac and keeping it awake, the tools Studio does not carry
// (each installable from here, through the worker's tool.install job), and the worker's keys from this Mac's secure store.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { HealthItem, PackagingBridge, WorkerEnvView } from "../../../../shared/system-ipc.ts";
import { Button, Switch, TextField } from "../../../components/ui/controls.tsx";
import { bridge } from "../../../lib/bridge.ts";
import { useHost, useSettings } from "../../../state/studio.tsx";
import { ToolsList } from "../../tools/tools.tsx";
import { ITEMS } from "../catalog.ts";
import { FormFooter, Row, Subheader, useConfirm } from "../parts.tsx";

function packaging(): PackagingBridge | null {
  return bridge().packaging ?? null;
}

const STATE_MARK: Record<HealthItem["state"], string> = { ok: "●", warn: "▲", fail: "✕" };
const STATE_TONE: Record<HealthItem["state"], string> = {
  ok: "text-fg-3",
  warn: "text-accent-text",
  fail: "text-danger",
};

/** The host's parts, as `/api/health` reports them to this Mac. */
export function HealthRows() {
  const p = packaging();
  const host = useHost();
  const up = host?.status.kind === "running" || host?.status.kind === "attached";
  const health = useQuery({
    queryKey: ["host-health", host?.apiPort ?? null, host?.status.kind ?? null],
    queryFn: () => p?.health() ?? Promise.resolve(null),
    enabled: p !== null && up,
    refetchInterval: 15_000,
  });
  if (!p) return null;
  const data = health.data;
  const detail = !up
    ? "Sunucu çalışmıyor."
    : !data
      ? "Denetleniyor…"
      : !data.reachable
        ? "API yanıt vermiyor."
        : null;
  return (
    <Row
      item={ITEMS.health}
      detail={detail ?? undefined}
      footer={
        data?.reachable ? (
          <ul className="flex flex-col gap-1.5" aria-label="Sunucu parçaları">
            {data.components.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-body">
                <span aria-hidden className={`w-3 shrink-0 text-caption ${STATE_TONE[c.state]}`}>
                  {STATE_MARK[c.state]}
                </span>
                <span className="w-40 shrink-0 font-medium text-fg">{c.label}</span>
                <span
                  className={`selectable min-w-0 flex-1 ${c.state === "fail" ? "text-danger" : "text-fg-2"}`}
                >
                  {c.state === "ok" ? "" : c.state === "warn" ? "Dikkat: " : "Sorun: "}
                  {c.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      <Button disabled={!up || health.isFetching} onClick={() => void health.refetch()}>
        Denetle
      </Button>
    </Row>
  );
}

/** Starting with the Mac (the login item) and keeping it awake while work is due. */
export function StartupRows() {
  const p = packaging();
  const { settings, update } = useSettings();
  const queryClient = useQueryClient();
  const login = useQuery({
    queryKey: ["login-item"],
    queryFn: () => p?.loginItem.get() ?? Promise.resolve(null),
    enabled: p !== null,
  });
  const runtime = useQuery({
    queryKey: ["runtime-info", settings.keepAwake],
    queryFn: () => p?.runtime() ?? Promise.resolve(null),
    enabled: p !== null,
    refetchInterval: 60_000,
  });
  if (!p) return null;
  const state = login.data;
  const awake = runtime.data?.keepAwake;
  return (
    <>
      <Row item={ITEMS.loginItem} detail={state?.note} dimmed={state ? !state.supported : false}>
        <Switch
          label={ITEMS.loginItem.title}
          checked={state?.enabled === true}
          disabled={!state?.supported}
          onChange={(on) =>
            void p.loginItem.set(on).then((next) => queryClient.setQueryData(["login-item"], next))
          }
        />
      </Row>
      <Row
        item={ITEMS.keepAwake}
        detail={
          settings.keepAwake && awake?.active && awake.reason
            ? `${ITEMS.keepAwake.detail} Şu an uyanık: ${awake.reason}.`
            : ITEMS.keepAwake.detail
        }
      >
        <Switch
          label={ITEMS.keepAwake.title}
          checked={settings.keepAwake}
          onChange={(on) => update({ keepAwake: on })}
        />
      </Row>
    </>
  );
}

/** The tools Studio uses on the Mac: status and Kur / Güncelle / Kaldır (worker jobs). */
export function ToolsRows() {
  return <Row item={ITEMS.tools} footer={<ToolsList />} />;
}

const SOURCE_TEXT = { "env-file": "depodaki .env'den", settings: "buradan" } as const;

/** The worker's keys from this Mac's secure store (names only; values never come back). */
export function WorkerKeyRows() {
  const p = packaging();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["worker-env"],
    queryFn: () => p?.workerEnv.get() ?? Promise.resolve(null),
    enabled: p !== null,
  });
  const [name, setName] = useState("ELEVENLABS_API_KEY");
  const value = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  if (!p) return null;
  const data = view.data;
  const store = (next: WorkerEnvView) => queryClient.setQueryData(["worker-env"], next);
  const editable = data?.editable ?? [];
  const chosen = editable.find((e) => e.name === name) ?? editable[0];
  const lines: string[] = [];
  if (data) {
    lines.push(
      data.entries.length > 0
        ? `Kayıtlı: ${data.entries.map((e) => `${e.name} (${SOURCE_TEXT[e.source]})`).join(", ")}.`
        : "Kayıtlı anahtar yok.",
    );
    if (data.imported) {
      lines.push(
        `Son içe aktarma: ${new Date(data.imported.at).toLocaleString("tr-TR")} · ${data.imported.count} değişken.`,
      );
    }
    if (!data.sealed)
      lines.push(
        "Anahtar Zinciri erişimi yok: değerler şifresiz (yalnızca senin okuyabileceğin) dosyada.",
      );
  }
  const save = async () => {
    const text = value.current?.value.trim() ?? "";
    if (!chosen || !text) {
      setMessage({ text: "Değeri yapıştır.", error: true });
      return;
    }
    store(await p.workerEnv.set(chosen.name, text));
    if (value.current) value.current.value = "";
    setMessage({
      text: `${chosen.name} kaydedildi; sunucu yeniden başlayınca worker kullanır.`,
      error: false,
    });
  };
  return (
    <Row
      item={ITEMS.workerKeys}
      detail={[ITEMS.workerKeys.detail, ...lines].join("\n")}
      footer={
        <FormFooter
          fields={
            <>
              <select
                aria-label="Anahtar"
                className="h-7 rounded-[8px] bg-field px-2 text-body text-fg"
                value={chosen?.name ?? ""}
                onChange={(e) => setName(e.target.value)}
              >
                {editable.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.label}
                  </option>
                ))}
              </select>
              <TextField
                ref={value}
                aria-label="Değer"
                type={chosen?.secret === false ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={chosen?.name ?? ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
            </>
          }
          buttons={
            <>
              {chosen && data?.entries.some((e) => e.name === chosen.name) && (
                <Button
                  onClick={() =>
                    confirm({
                      title: `${chosen.name} silinsin mi?`,
                      message: "Worker bundan sonra bu değeri almaz (sunucu yeniden başlayınca).",
                      confirm: "Sil",
                      danger: true,
                      onConfirm: async () => {
                        store(await p.workerEnv.remove(chosen.name));
                        setMessage({ text: `${chosen.name} silindi.`, error: false });
                      },
                    })
                  }
                >
                  Sil
                </Button>
              )}
              <Button variant="primary" onClick={() => void save()}>
                Kaydet
              </Button>
            </>
          }
          message={message?.text ?? null}
          messageTone={message?.error ? "danger" : "default"}
        />
      }
    />
  );
}

/** The packaged-app rows of Gelişmiş, in order (absent outside Electron). */
export function SystemRows() {
  if (!packaging()) return null;
  return (
    <>
      <HealthRows />
      <Subheader title="Başlangıç ve uyku" ids={[ITEMS.loginItem.id, ITEMS.keepAwake.id]} />
      <StartupRows />
      <Subheader title="Araçlar" ids={[ITEMS.tools.id]} />
      <ToolsRows />
      <Subheader title="Worker" ids={[ITEMS.workerKeys.id]} />
      <WorkerKeyRows />
    </>
  );
}
