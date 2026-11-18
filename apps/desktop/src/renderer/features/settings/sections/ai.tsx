// Ayarlar → Yapay zekâ (default model and effort grouped by provider; the Mac's Claude Code
// sign-in, its limit and what happens then (S7); Gemini readiness and its API key in the vault;
// Codex CLI, OpenAI API key and Antigravity CLI) and Kullanım (Claude subscription windows, paid
// AI spend of Gemini / OpenAI / ElevenLabs, the monthly budget and "Bütçe dolunca dur").
import {
  type AiKeyList,
  type AiKeyProvider,
  type AiKeyState,
  type AiPreferences,
  type AiProviderStatus,
  type AiProvidersControl,
  type AiSpendSummary,
  type ClaudeControl,
  type ClaudeLimitChoice,
  type ClaudeLimitMode,
  type ClaudeLimitState,
  DEFAULT_CLAUDE_LIMIT_MODE,
  type GeminiControl,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Meter,
  SegmentedControl,
  Spinner,
  Switch,
  TextField,
} from "../../../components/ui/controls.tsx";
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
  budgetNotice,
  EXHAUSTED_TEXT,
  formatUsd,
  modelSpendLine,
  parseBudgetInput,
  serviceSpendLines,
  spendHeadline,
  spendKey,
  unpricedNote,
  useAiSpend,
} from "../../../lib/spend.ts";
import { usageMeters } from "../../../lib/usage.ts";
import { isHostUp, useHost, useJobs, useSettings } from "../../../state/studio.tsx";
import { ITEMS, type SettingsItem } from "../catalog.ts";
import {
  CLAUDE_LIMIT_OPTIONS,
  claudeLimitChoiceNow,
  claudeLimitChoiceText,
  claudeLimitHints,
  claudeLimitLine,
  claudeLimitModeWarning,
} from "../claude-limit.ts";
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

export const aiPreferencesKey = ["ai", "preferences"] as const;

/** The Claude-limit behaviour, the monthly budget and "Bütçe dolunca dur" (S7). */
function useAiPreferences() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: aiPreferencesKey,
    queryFn: () => api.ai.preferences(),
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
      <ClaudeLimitRow />
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
  const queryClient = useQueryClient();
  const { presence } = useJobs();
  const fetched = useClaudeControl();
  const [override, setOverride] = useState<ClaudeControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An answer just sent for this limit window (presence shows it once the worker re-reads).
  const [answered, setAnswered] = useState<{ choice: ClaudeLimitChoice; resetsAt: string } | null>(
    null,
  );
  const [deciding, setDeciding] = useState<ClaudeLimitChoice | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const account = presence?.claude ?? override?.account ?? fetched.data?.account ?? null;
  const online =
    presence?.online === true || override?.online === true || fetched.data?.online === true;
  const status = claudeStatus(account, online, ITEMS.claude.detail);
  const limit: ClaudeLimitState | null = account?.limit ?? null;
  const choice = limit
    ? claudeLimitChoiceNow(
        limit,
        answered && answered.resetsAt === limit.resetsAt ? answered.choice : null,
      )
    : null;
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
  const decide = async (next: ClaudeLimitChoice) => {
    if (!limit || deciding) return;
    setDeciding(next);
    setLimitError(null);
    try {
      const saved = await api.ai.decideClaudeLimit({ choice: next });
      queryClient.setQueryData<AiPreferences>(aiPreferencesKey, saved);
      setAnswered({ choice: next, resetsAt: limit.resetsAt });
    } catch (e) {
      setLimitError(describeError(e));
    } finally {
      setDeciding(null);
    }
  };
  const lines = [...status.lines];
  if (limit) {
    lines.push(claudeLimitLine(limit));
    if (choice) lines.push(claudeLimitChoiceText(choice));
  }
  if (error) lines.push(error);
  return (
    <Row
      item={ITEMS.claude}
      detail={lines.join("\n")}
      detailTone={error ? "danger" : limit ? "accent" : "default"}
      footer={
        limit && !choice ? (
          <ClaudeLimitActions
            geminiReady={limit.geminiReady}
            busy={deciding}
            error={limitError}
            onDecide={(next) => void decide(next)}
          />
        ) : undefined
      }
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

/** The owner's answer while Claude is at its limit and the preference is "Sor". */
export function ClaudeLimitActions({
  geminiReady,
  busy,
  error,
  onDecide,
}: {
  geminiReady: boolean;
  busy: ClaudeLimitChoice | null;
  error: string | null;
  onDecide(choice: ClaudeLimitChoice): void;
}) {
  return (
    <FormFooter
      fields={
        <p className="text-footnote text-fg-2">
          Gemini ile sürerse ücretlidir ve işte not görünür.
        </p>
      }
      buttons={
        <>
          <Button
            disabled={busy !== null}
            icon={busy === "wait" ? <Spinner size={12} /> : undefined}
            onClick={() => onDecide("wait")}
          >
            Sınırı bekle
          </Button>
          <Button
            variant="primary"
            disabled={!geminiReady || busy !== null}
            title={geminiReady ? undefined : "Gemini anahtarı yok"}
            icon={busy === "gemini" ? <Spinner size={12} /> : undefined}
            onClick={() => onDecide("gemini")}
          >
            Gemini ile devam et
          </Button>
        </>
      }
      message={error ?? (geminiReady ? null : "Gemini anahtarı yok")}
      messageTone={error ? "danger" : "default"}
    />
  );
}

/** "Claude sınırı dolunca": Sor (default) / Gemini'ye geç / Bekle. */
function ClaudeLimitRow() {
  const api = useApi();
  const up = isHostUp(useHost());
  const queryClient = useQueryClient();
  const { presence } = useJobs();
  const prefs = useAiPreferences();
  const [saving, setSaving] = useState<ClaudeLimitMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mode: ClaudeLimitMode = saving ?? prefs.data?.claudeLimit ?? DEFAULT_CLAUDE_LIMIT_MODE;
  const geminiReady =
    presence?.claude?.limit?.geminiReady ?? presence?.gemini?.apiKeyConfigured ?? true;
  const choose = async (next: ClaudeLimitMode) => {
    if (!up || saving !== null || next === mode) return;
    setSaving(next);
    setError(null);
    try {
      queryClient.setQueryData<AiPreferences>(
        aiPreferencesKey,
        await api.ai.setPreferences({ claudeLimit: next }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(null);
    }
  };
  const warning = claudeLimitModeWarning(mode, geminiReady);
  const problem = error ?? (prefs.isError ? describeError(prefs.error) : null);
  return (
    <Row
      item={ITEMS.claudeLimit}
      detail={[...claudeLimitHints(), warning, problem].filter(Boolean).join("\n")}
      detailTone={problem ? "danger" : "default"}
    >
      <SegmentedControl
        label={ITEMS.claudeLimit.title}
        value={mode}
        onChange={(next) => void choose(next)}
        options={CLAUDE_LIMIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
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
      <AiSpendRows />
    </Pane>
  );
}

/** "gemini-2.5-flash — $0.42 · 18 çağrı · 120K giriş / 8K çıkış" */
export function modelSpendLines(spend: AiSpendSummary): string[] {
  return spend.byModel.map(modelSpendLine);
}

/** Paid AI spend (Gemini, OpenAI, ElevenLabs), the monthly budget and "Bütçe dolunca dur". */
function AiSpendRows() {
  const api = useApi();
  const up = isHostUp(useHost());
  const queryClient = useQueryClient();
  const spend = useAiSpend();
  const prefs = useAiPreferences();
  const data = spend.data;
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  useEffect(() => {
    const value = data?.budget.monthlyUsd;
    setBudget(value === null || value === undefined ? "" : String(value));
  }, [data?.budget.monthlyUsd]);

  const saveBudget = async () => {
    const parsed = parseBudgetInput(budget);
    if (!parsed.ok) {
      setMessage({ text: parsed.error, error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.ai.setBudget({
        geminiMonthlyUsd: parsed.value,
        tzOffset: new Date().getTimezoneOffset(),
      });
      queryClient.setQueryData(spendKey, next);
      void queryClient.invalidateQueries({ queryKey: aiPreferencesKey });
      setMessage({
        text: parsed.value === null ? "Bütçe kaldırıldı." : "Bütçe kaydedildi.",
        error: false,
      });
    } catch (e) {
      setMessage({ text: describeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const stopAtBudget = prefs.data?.stopAtBudget ?? data?.budget.stopAtBudget ?? false;
  const setStopAtBudget = async (next: boolean) => {
    if (stopBusy) return;
    setStopBusy(true);
    setStopError(null);
    try {
      queryClient.setQueryData<AiPreferences>(
        aiPreferencesKey,
        await api.ai.setPreferences({ stopAtBudget: next }),
      );
      await queryClient.invalidateQueries({ queryKey: spendKey });
    } catch (e) {
      setStopError(describeError(e));
    } finally {
      setStopBusy(false);
    }
  };

  const lines: string[] = [];
  if (data) {
    lines.push(spendHeadline(data));
    const unpriced = unpricedNote(data);
    if (unpriced) lines.push(unpriced);
    lines.push(
      `Tahmini tutar: kullanım × fiyat tablosu${data.pricingVersion ? ` (${data.pricingVersion} tarihli)` : ""}.`,
    );
  } else if (spend.isError) {
    lines.push(describeError(spend.error));
  } else {
    lines.push(ITEMS.geminiSpend.detail);
  }
  const services = data ? serviceSpendLines(data) : [];
  const models = data ? modelSpendLines(data) : [];
  const budgetText = data ? budgetLine(data) : null;
  const exhausted = data?.budget.exhausted === true;
  const notice = data ? budgetNotice(data) : null;
  const hasBudget = data?.budget.monthlyUsd !== null && data?.budget.monthlyUsd !== undefined;

  return (
    <>
      <Row
        item={ITEMS.geminiSpend}
        detail={lines.join("\n")}
        footer={
          services.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="selectable text-footnote whitespace-pre-line text-fg-2">
                {services.join("\n")}
              </p>
              {models.length > 0 && (
                <p className="selectable text-footnote whitespace-pre-line text-fg-3">
                  {models.join("\n")}
                </p>
              )}
            </div>
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
        detailTone={exhausted ? "danger" : data?.budget.warning ? "accent" : "default"}
        footer={
          <FormFooter
            fields={
              <>
                {hasBudget && data && (
                  <Meter
                    percent={Math.min(100, data.budget.usedPercent ?? 0)}
                    tone={data.budget.warning ? "danger" : "info"}
                  />
                )}
                <TextField
                  aria-label="Aylık yapay zekâ bütçesi (USD)"
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
            message={message?.text ?? notice}
            messageTone={message?.error || (!message && notice) ? "danger" : "default"}
          />
        }
      />
      <Row
        item={ITEMS.stopAtBudget}
        detail={
          stopError ??
          (exhausted
            ? EXHAUSTED_TEXT
            : stopAtBudget && data && !hasBudget
              ? "Bütçe girilmedi; bütçe girilene kadar sınır yok."
              : ITEMS.stopAtBudget.detail)
        }
        detailTone={stopError || exhausted ? "danger" : "default"}
      >
        <Switch
          label={ITEMS.stopAtBudget.title}
          checked={stopAtBudget}
          disabled={!up || stopBusy}
          onChange={(next) => void setStopAtBudget(next)}
        />
      </Row>
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
