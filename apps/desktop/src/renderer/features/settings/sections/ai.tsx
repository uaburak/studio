// Ayarlar → Yapay zekâ (default model and effort grouped by provider; the Mac's Claude Code
// sign-in; Gemini readiness and its API key in the vault; Codex CLI, OpenAI API key and
// Antigravity CLI) and Kullanım (Claude subscription windows, Gemini API spend and budget).
import type {
  AiKeyList,
  AiKeyProvider,
  AiKeyState,
  AiProviderStatus,
  AiProvidersControl,
  AiSpendSummary,
  ClaudeControl,
  GeminiControl,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Meter, Spinner, TextField } from "../../../components/ui/controls.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { bridge } from "../../../lib/bridge.ts";
import { formatAgo } from "../../../lib/format.ts";
import {
  EFFORTS,
  lastChoice,
  MODEL_GROUPS,
  modelUnavailableReason,
  saveChoicePatch,
} from "../../../lib/models.ts";
import {
  budgetLine,
  formatTokens,
  formatUsd,
  spendHeadline,
  spendKey,
  unpricedNote,
  useGeminiSpend,
} from "../../../lib/spend.ts";
import { usageMeters } from "../../../lib/usage.ts";
import { isHostUp, useHost, useJobs, useSettings } from "../../../state/studio.tsx";
import { ITEMS, type SettingsItem } from "../catalog.ts";
import { FormFooter, Note, Pane, Row, Select, Subheader, useConfirm } from "../parts.tsx";
import { claudeStatus, geminiStatusLines, providerStatusLines } from "../status-text.ts";

const KEY_PAGES: Record<AiKeyProvider, { url: string; label: string }> = {
  gemini: { url: "https://aistudio.google.com/apikey", label: "AI Studio'da anahtar al" },
  openai: { url: "https://platform.openai.com/api-keys", label: "OpenAI'de anahtar al" },
};

const aiKeysKey = ["ai", "keys"] as const;

function useClaudeControl() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: ["workers", "claude"],
    queryFn: () => api.workers.claude(),
    enabled: up,
    staleTime: 10_000,
  });
}

function useGeminiControl() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: ["workers", "gemini"],
    queryFn: () => api.workers.gemini(),
    enabled: up,
    staleTime: 10_000,
  });
}

function useProvidersControl() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: ["workers", "providers"],
    queryFn: () => api.workers.providers(),
    enabled: up,
    staleTime: 10_000,
  });
}

function useAiKeys() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: aiKeysKey,
    queryFn: () => api.ai.keys(),
    enabled: up,
    staleTime: 15_000,
  });
}

export function AiSection() {
  const { settings, update } = useSettings();
  const { presence } = useJobs();
  const choice = lastChoice(settings);
  return (
    <Pane title="Yapay zekâ">
      <Row item={ITEMS.defaultModel}>
        <Select
          label={ITEMS.defaultModel.title}
          value={choice.model}
          onChange={(model) => update(saveChoicePatch({ ...choice, model }, null))}
          width={240}
          options={MODEL_GROUPS.flatMap((group, gi) => [
            ...(gi > 0 ? [{ separator: true as const }] : []),
            { heading: group.title },
            ...group.models.map((m) => {
              const reason = modelUnavailableReason(m.id, presence);
              return {
                value: m.id,
                label: reason ? `${m.label} · ${reason}` : m.label,
                disabled: Boolean(reason) && m.id !== choice.model,
              };
            }),
          ])}
        />
      </Row>
      <Row item={ITEMS.defaultEffort}>
        <Select
          label={ITEMS.defaultEffort.title}
          value={choice.effort}
          onChange={(effort) => update(saveChoicePatch({ ...choice, effort }, null))}
          options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))}
        />
      </Row>
      <ClaudeRow />
      <GeminiRow />
      <KeyRow provider="gemini" item={ITEMS.geminiKey} />
      <Subheader
        title="Diğer sağlayıcılar"
        ids={[ITEMS.codex.id, ITEMS.openaiKey.id, ITEMS.antigravity.id]}
      />
      <ProviderRow provider="codex" item={ITEMS.codex} />
      <KeyRow provider="openai" item={ITEMS.openaiKey} />
      <ProviderRow provider="antigravity" item={ITEMS.antigravity} />
    </Pane>
  );
}

function ClaudeRow() {
  const api = useApi();
  const { presence } = useJobs();
  const fetched = useClaudeControl();
  const [override, setOverride] = useState<ClaudeControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = presence?.claude ?? override?.account ?? fetched.data?.account ?? null;
  const online =
    presence?.online === true || override?.online === true || fetched.data?.online === true;
  const status = claudeStatus(account, online, ITEMS.claude.detail);
  const run = async (call: () => Promise<ClaudeControl>, openLogin: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await call();
      setOverride(next);
      const url = next.account?.loginUrl;
      if (openLogin && url) void bridge().openExternal(url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      item={ITEMS.claude}
      detail={[...status.lines, error].filter(Boolean).join("\n")}
      detailTone={error ? "danger" : "default"}
    >
      {status.loginUrl && (
        <Button onClick={() => void bridge().openExternal(status.loginUrl as string)}>
          Bağlantıyı aç
        </Button>
      )}
      <Button
        disabled={!online || busy}
        onClick={() => void run(() => api.workers.claudeRefresh(), false)}
      >
        Yenile
      </Button>
      <Button
        variant={status.action.primary ? "primary" : "secondary"}
        disabled={!status.canLogin || busy}
        icon={busy ? <Spinner size={12} /> : undefined}
        onClick={() => void run(() => api.workers.claudeLogin(), true)}
      >
        {status.action.title}
      </Button>
    </Row>
  );
}

function GeminiRow() {
  const api = useApi();
  const { presence } = useJobs();
  const fetched = useGeminiControl();
  const [override, setOverride] = useState<GeminiControl | null>(null);
  const [busy, setBusy] = useState(false);
  const account = presence?.gemini ?? override?.account ?? fetched.data?.account ?? null;
  const online =
    presence?.online === true || override?.online === true || fetched.data?.online === true;
  return (
    <Row
      item={ITEMS.gemini}
      detail={geminiStatusLines(account, online, ITEMS.gemini.detail).join("\n")}
    >
      <Button
        disabled={!online || busy}
        icon={busy ? <Spinner size={12} /> : undefined}
        onClick={async () => {
          setBusy(true);
          try {
            setOverride(await api.workers.geminiRefresh());
          } catch {
            // the row keeps the last state
          } finally {
            setBusy(false);
          }
        }}
      >
        Yenile
      </Button>
    </Row>
  );
}

/** "Kayıtlı: …a1B2 · geçerli · 12 model · 3 dk önce denetlendi" */
export function keyStateText(state: AiKeyState | undefined, vaultReady: boolean): string {
  if (!vaultReady) return "Kasa anahtarı yok: Studio API'yi başlatmadıysa anahtar kaydedilemez.";
  if (!state?.configured) return "Kayıtlı değil.";
  const check =
    state.valid === true ? "geçerli" : state.valid === false ? "geçersiz" : "denetlenemedi";
  const parts = [`Kayıtlı: ${state.hint ?? ""}`, check];
  if (state.models.length > 0) parts.push(`${state.models.length} model`);
  if (state.checkedAt) parts.push(`${formatAgo(state.checkedAt)} denetlendi`);
  return parts.join(" · ");
}

function KeyRow({ provider, item }: { provider: AiKeyProvider; item: SettingsItem }) {
  const api = useApi();
  const up = isHostUp(useHost());
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const keys = useAiKeys();
  const { presence } = useJobs();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const state = keys.data?.items.find((k) => k.provider === provider);
  const vaultReady = keys.data?.vaultReady ?? true;

  const store = (next: AiKeyState) =>
    queryClient.setQueryData<AiKeyList>(aiKeysKey, (old) =>
      old ? { ...old, items: old.items.map((k) => (k.provider === provider ? next : k)) } : old,
    );

  const save = async () => {
    const key = input.current?.value.trim() ?? "";
    if (!key) {
      setMessage({ text: "Anahtarı yapıştırın.", error: true });
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const next = await api.ai.setKey(provider, { key });
      store(next);
      if (input.current) input.current.value = "";
      setMessage({
        text:
          next.valid === true
            ? "Anahtar denetlendi ve kasaya kaydedildi; worker bundan sonra bunu kullanır."
            : `Kaydedildi ama denetlenemedi: ${next.detail ?? ""}`,
        error: next.valid !== true,
      });
    } catch (e) {
      setMessage({ text: describeError(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setMessage(null);
    try {
      const next = await api.ai.checkKey(provider);
      store(next);
      setMessage({ text: next.detail ?? "Denetlendi.", error: next.valid === false });
    } catch (e) {
      setMessage({ text: describeError(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const openaiRow = presence?.providers?.find((p) => p.provider === "openai");
  const lines = [keyStateText(state, vaultReady)];
  if (provider === "gemini" && presence?.gemini?.keySource === "env" && !state?.configured) {
    lines.push("Şu an .env içindeki GEMINI_API_KEY kullanılıyor.");
  }
  if (provider === "openai" && state?.configured && openaiRow?.detail) lines.push(openaiRow.detail);
  if (keys.isError) lines.push(describeError(keys.error));

  return (
    <Row
      item={item}
      detail={lines.join("\n")}
      detailTone={state?.valid === false || keys.isError ? "danger" : "default"}
      footer={
        <FormFooter
          fields={
            <TextField
              ref={input}
              aria-label={item.title}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                state?.configured ? "Yeni anahtar (değiştirmek için yapıştır)" : "API anahtarı"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          }
          buttons={
            <>
              <Button onClick={() => void bridge().openExternal(KEY_PAGES[provider].url)}>
                {KEY_PAGES[provider].label}
              </Button>
              {state?.configured && (
                <Button
                  disabled={!up || busy !== null}
                  icon={busy === "check" ? <Spinner size={12} /> : undefined}
                  onClick={() => void check()}
                >
                  Denetle
                </Button>
              )}
              {state?.configured && (
                <Button
                  disabled={!up || busy !== null}
                  onClick={() =>
                    confirm({
                      title: "Anahtar silinsin mi?",
                      message:
                        provider === "gemini"
                          ? "Worker bundan sonra .env içindeki GEMINI_API_KEY'i (varsa) kullanır."
                          : "GPT (OpenAI API) modeli bundan sonra kullanılamaz.",
                      confirm: "Sil",
                      danger: true,
                      onConfirm: async () => {
                        try {
                          store(await api.ai.deleteKey(provider));
                          setMessage({ text: "Anahtar silindi.", error: false });
                        } catch (e) {
                          setMessage({ text: describeError(e), error: true });
                        }
                      },
                    })
                  }
                >
                  Sil
                </Button>
              )}
              <Button
                variant="primary"
                disabled={!up || busy !== null || !vaultReady}
                icon={busy === "save" ? <Spinner size={12} /> : undefined}
                onClick={() => void save()}
              >
                Denetle ve kaydet
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

function ProviderRow({
  provider,
  item,
}: {
  provider: "codex" | "antigravity";
  item: SettingsItem;
}) {
  const api = useApi();
  const { presence } = useJobs();
  const fetched = useProvidersControl();
  const [override, setOverride] = useState<AiProvidersControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list: AiProviderStatus[] =
    presence?.providers ?? override?.providers ?? fetched.data?.providers ?? [];
  const row = list.find((p) => p.provider === provider);
  const online =
    presence?.online === true || override?.online === true || fetched.data?.online === true;
  // The CLI opens the sign-in page itself; "Bağlantıyı aç" is there when it did not.
  const status = providerStatusLines(row, online, item.detail);
  const run = async (call: () => Promise<AiProvidersControl>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setOverride(await call());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const login = provider === "codex" ? api.workers.codexLogin : api.workers.antigravityLogin;
  return (
    <Row
      item={item}
      detail={[...status.lines, error].filter(Boolean).join("\n")}
      detailTone={error ? "danger" : "default"}
    >
      {row?.loginUrl && (
        <Button onClick={() => void bridge().openExternal(row.loginUrl as string)}>
          Bağlantıyı aç
        </Button>
      )}
      <Button
        disabled={!online || busy}
        onClick={() => void run(() => api.workers.providersRefresh())}
      >
        Yenile
      </Button>
      {status.canLogin && (
        <Button
          variant={row?.state === "signed_out" ? "primary" : "secondary"}
          disabled={!online || busy}
          icon={busy ? <Spinner size={12} /> : undefined}
          onClick={() => void run(() => login())}
        >
          {row?.state === "ready" ? "Hesabı değiştir" : "Giriş yap"}
        </Button>
      )}
    </Row>
  );
}

export function UsageSection() {
  const { presence } = useJobs();
  const claude = presence?.claude;
  const meters = usageMeters(presence?.usage);
  const who =
    claude?.status === "signed_in" ? [claude.email, claude.plan].filter(Boolean).join(" · ") : "";
  return (
    <Pane title="Kullanım">
      <Row item={ITEMS.claudeUsage} detail={who || ITEMS.claudeUsage.detail}>
        {presence?.usage && (
          <span className="text-body text-fg-2">
            Güncellendi: {formatAgo(presence.usage.observedAt)}
          </span>
        )}
      </Row>
      {meters.length === 0 ? (
        <Note>
          {presence?.online
            ? "Henüz bildirilmedi; Claude Code bir işi bitirince gelir."
            : "Arka plan çalışmıyor; Studio hazır olunca gelir."}
        </Note>
      ) : (
        meters.map((m) => (
          <Row
            key={m.kind}
            id={`${ITEMS.claudeUsage.id}.${m.kind}`}
            title={m.title}
            detail={m.resetText ?? undefined}
            footer={
              <Meter
                percent={m.percent}
                tone={m.warning ? "danger" : m.kind === "weekly" ? "warning" : "info"}
              />
            }
          >
            <span className={m.warning ? "text-body text-accent-text" : "text-body text-fg-2"}>
              {m.percentText}
            </span>
          </Row>
        ))
      )}
      <GeminiSpendRows />
    </Pane>
  );
}

/** "gemini-2.5-flash — $0.42 · 18 çağrı · 120K giriş / 8K çıkış" */
export function modelSpendLines(spend: AiSpendSummary): string[] {
  return spend.byModel.map(
    (m) =>
      `${m.model} — ${formatUsd(m.costUsd)} · ${m.calls} çağrı · ${formatTokens(m.inputTokens)} giriş / ${formatTokens(m.outputTokens + m.thoughtsTokens)} çıkış`,
  );
}

function GeminiSpendRows() {
  const api = useApi();
  const up = isHostUp(useHost());
  const queryClient = useQueryClient();
  const spend = useGeminiSpend();
  const data = spend.data;
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    const value = data?.budget.monthlyUsd;
    setBudget(value === null || value === undefined ? "" : String(value));
  }, [data?.budget.monthlyUsd]);

  const saveBudget = async () => {
    const raw = budget.trim().replace(",", ".");
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setMessage({ text: "Bütçe 0 ya da daha büyük bir sayı olmalı (USD).", error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.ai.setBudget({
        geminiMonthlyUsd: value,
        tzOffset: new Date().getTimezoneOffset(),
      });
      queryClient.setQueryData(spendKey, next);
      setMessage({
        text: value === null ? "Bütçe kaldırıldı." : "Bütçe kaydedildi.",
        error: false,
      });
    } catch (e) {
      setMessage({ text: describeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const lines: string[] = [];
  if (data) {
    lines.push(spendHeadline(data));
    const unpriced = unpricedNote(data);
    if (unpriced) lines.push(unpriced);
    lines.push(
      `Tahmini tutar: token sayısı × fiyat tablosu${data.pricingVersion ? ` (${data.pricingVersion} tarihli)` : ""}.`,
    );
  } else if (spend.isError) {
    lines.push(describeError(spend.error));
  } else {
    lines.push(ITEMS.geminiSpend.detail);
  }
  const models = data ? modelSpendLines(data) : [];
  const budgetText = data ? budgetLine(data) : null;

  return (
    <>
      <Row
        item={ITEMS.geminiSpend}
        detail={lines.join("\n")}
        footer={
          models.length > 0 ? (
            <p className="selectable text-footnote whitespace-pre-line text-fg-2">
              {models.join("\n")}
            </p>
          ) : undefined
        }
      >
        <span className="text-body text-fg-2">
          {spend.isLoading ? <Spinner size={12} /> : data ? formatUsd(data.month.costUsd) : "—"}
        </span>
      </Row>
      <Row
        item={ITEMS.geminiBudget}
        detail={budgetText ?? ITEMS.geminiBudget.detail}
        detailTone={data?.budget.warning ? "accent" : "default"}
        footer={
          <FormFooter
            fields={
              <>
                {data?.budget.monthlyUsd !== null && data?.budget.monthlyUsd !== undefined && (
                  <Meter
                    percent={Math.min(100, data.budget.usedPercent ?? 0)}
                    tone={data.budget.warning ? "danger" : "info"}
                  />
                )}
                <TextField
                  aria-label="Aylık bütçe (USD)"
                  inputMode="decimal"
                  placeholder="Aylık bütçe, USD (ör. 10)"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveBudget();
                  }}
                />
              </>
            }
            buttons={
              <Button
                disabled={!up || busy}
                icon={busy ? <Spinner size={12} /> : undefined}
                onClick={() => void saveBudget()}
              >
                Kaydet
              </Button>
            }
            message={
              message?.text ?? (data?.budget.warning ? "Aylık bütçenin %80'i aşıldı." : null)
            }
            messageTone={
              message?.error || (!message && data?.budget.warning) ? "danger" : "default"
            }
          />
        }
      />
      <Row item={ITEMS.geminiCredit}>
        <span className="text-body text-fg-2">Bilinmiyor</span>
        <Button
          onClick={() =>
            void bridge().openExternal(
              data?.balance.billingUrl ?? "https://aistudio.google.com/usage",
            )
          }
        >
          AI Studio'yu aç
        </Button>
      </Row>
    </>
  );
}
