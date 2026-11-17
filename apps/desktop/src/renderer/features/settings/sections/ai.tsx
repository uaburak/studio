// Ayarlar → Yapay zekâ (default model and effort, the Mac's Claude Code sign-in, Gemini) and
// Kullanım (Claude subscription windows as the worker last reported them).
import type { ClaudeControl, GeminiControl } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Meter, Spinner } from "../../../components/ui/controls.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { bridge } from "../../../lib/bridge.ts";
import { formatAgo } from "../../../lib/format.ts";
import {
  CLAUDE_MODELS,
  EFFORTS,
  GEMINI_MODELS,
  lastChoice,
  saveChoicePatch,
} from "../../../lib/models.ts";
import { usageMeters } from "../../../lib/usage.ts";
import { isHostUp, useHost, useJobs, useSettings } from "../../../state/studio.tsx";
import { ITEMS } from "../catalog.ts";
import { Note, Pane, Row, Select } from "../parts.tsx";
import { claudeStatus, geminiStatusLines } from "../status-text.ts";

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

export function AiSection() {
  const { settings, update } = useSettings();
  const choice = lastChoice(settings);
  return (
    <Pane title="Yapay zekâ">
      <Row item={ITEMS.defaultModel}>
        <Select
          label={ITEMS.defaultModel.title}
          value={choice.model}
          onChange={(model) => update(saveChoicePatch({ ...choice, model }, null))}
          options={[
            ...GEMINI_MODELS.map((m) => ({ value: m.id, label: m.label })),
            { separator: true as const },
            ...CLAUDE_MODELS.map((m) => ({ value: m.id, label: m.label })),
          ]}
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
    </Pane>
  );
}
