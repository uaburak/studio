// First-run sheet (the AppKit OnboardingSheet in the new style): Hoş geldin → Claude hesabı →
// Mac ve iPhone → İlk marka → Hazır. ↩ runs the primary action, Esc skips (resumable from
// Ayarlar → Hakkında → Başlangıç rehberi). Opens by itself once after the first load when
// something needs setting up (Electron only; the browser preview never opens it uninvited).
import { ApiError, type Brand, type ClaudeControl } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, Layers, MonitorSmartphone, UserRoundCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingState } from "../../../shared/ipc.ts";
import { Button, cn, Spinner } from "../../components/ui/controls.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { bridge, isElectron } from "../../lib/bridge.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  isHostUp,
  queryKeys,
  useBrands,
  useHost,
  useJobs,
  useSettings,
} from "../../state/studio.tsx";
import { LivePairingCard } from "../settings/sections/devices.tsx";
import { openSettings } from "../settings/store.ts";
import { ToolRequired } from "../tools/tools.tsx";
import { BrandForm, createBrandFromDraft, useBrandDraft } from "./brand-form.tsx";
import {
  LOGIN_POLL_MS,
  LOGIN_TIMEOUT_MS,
  loginProgress,
  nextStep,
  type OnboardingStep,
  previousStep,
  reopenStep,
  STEPS,
  shouldAutoOpen,
  stepButtons,
  stepIndex,
  stepTitle,
} from "./model.ts";
import { openOnboarding, useOnboardingSheet } from "./store.ts";

const claudeKey = ["workers", "claude"] as const;

function useClaude(polling: boolean) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: claudeKey,
    queryFn: () => api.workers.claude(),
    enabled: up,
    staleTime: 5_000,
    refetchInterval: polling ? LOGIN_POLL_MS : false,
  });
}

export function describeLoginError(error: unknown): string {
  if (error instanceof ApiError && error.code === "conflict") {
    return "Studio'nun arka planı henüz hazır değil. Hazır olunca tekrar dene.";
  }
  if (error instanceof ApiError && error.code === "forbidden") {
    return "Giriş yalnızca bu Mac'ten başlatılabilir.";
  }
  return describeError(error);
}

/** Opens the guide once after the first load when there is something to set up. */
function useAutoOpen() {
  const { settings } = useSettings();
  const brands = useBrands();
  const claude = useClaude(false);
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !isElectron()) return;
    if (!brands.isSuccess || claude.isLoading) return;
    decided.current = true;
    const status = claude.data?.account?.status ?? null;
    const count = (brands.data ?? []).filter((b) => b.status === "active").length;
    if (shouldAutoOpen(settings.onboarding, count, status)) openOnboarding();
  }, [brands.isSuccess, brands.data, claude.isLoading, claude.data, settings.onboarding]);
}

export function OnboardingSheet() {
  useAutoOpen();
  const open = useOnboardingSheet((s) => s.open);
  const openId = useOnboardingSheet((s) => s.openId);
  if (!open) return null;
  return <OnboardingPanel key={openId} />;
}

function OnboardingPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { settings, update } = useSettings();
  const host = useHost();
  const { presence } = useJobs();
  const brands = useBrands();
  const [step, setStepState] = useState<OnboardingStep>(() =>
    reopenStep(settings.onboarding, useOnboardingSheet.getState().requested ?? undefined),
  );
  const progress = useRef<OnboardingState>(settings.onboarding);
  progress.current = settings.onboarding;

  const save = useCallback(
    (patch: Partial<OnboardingState>) => update({ onboarding: { ...progress.current, ...patch } }),
    [update],
  );
  const go = useCallback(
    (next: OnboardingStep) => {
      setStepState(next);
      save({ step: next });
    },
    [save],
  );
  const close = () => useOnboardingSheet.getState().setOpen(false);
  const skip = () => {
    save({ skipped: true, step });
    close();
  };
  const finish = () => {
    save({ completed: true, step: "done" });
    close();
  };

  // --- Claude ---
  const [signingIn, setSigningIn] = useState(false);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const claude = useClaude(signingIn);
  const [override, setOverride] = useState<ClaudeControl | null>(null);
  const account = presence?.claude ?? claude.data?.account ?? override?.account ?? null;
  const online =
    presence?.online === true || claude.data?.online === true || override?.online === true;
  const claudeReady = account?.status === "signed_in";
  const login = useRef<{ saw: boolean; deadline: number }>({ saw: false, deadline: 0 });

  useEffect(() => {
    if (!signingIn) return;
    const result = loginProgress(login.current.saw, account?.status);
    login.current.saw = result.sawSigningIn;
    if (result.outcome === "signed_in") setSigningIn(false);
    else if (result.outcome === "failed") {
      setSigningIn(false);
      setClaudeError(account?.detail ?? "Giriş tamamlanmadı. Yeniden dene.");
    } else if (Date.now() > login.current.deadline) {
      setSigningIn(false);
      setClaudeError("Giriş 10 dakika içinde tamamlanmadı. Yeniden dene.");
    }
  }, [signingIn, account?.status, account?.detail]);

  const startLogin = async () => {
    if (signingIn) {
      setSigningIn(false);
      return;
    }
    setClaudeError(null);
    try {
      const control = await api.workers.claudeLogin();
      setOverride(control);
      login.current = { saw: false, deadline: Date.now() + LOGIN_TIMEOUT_MS };
      setSigningIn(true);
    } catch (error) {
      setClaudeError(describeLoginError(error));
    }
  };
  const recheck = async () => {
    setRechecking(true);
    try {
      setOverride(await api.workers.claudeRefresh());
      setClaudeError(null);
      await new Promise((r) => setTimeout(r, 600));
      await queryClient.invalidateQueries({ queryKey: claudeKey });
    } catch (error) {
      setClaudeError(describeError(error));
    } finally {
      setRechecking(false);
    }
  };

  // --- Brand ---
  const { draft, setDraft, problem } = useBrandDraft();
  const [creating, setCreating] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);
  const [created, setCreated] = useState<Brand | null>(null);
  const existing = created ?? (brands.data ?? []).find((b) => b.status === "active") ?? null;
  const createBrand = async () => {
    if (problem || creating) return;
    setCreating(true);
    try {
      const result = await createBrandFromDraft(api, draft);
      setCreated(result.brand);
      setBrandError(result.warning);
      useAppStore.getState().setCurrentBrand(result.brand.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.brands });
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      go("done");
    } catch (error) {
      setBrandError(describeError(error));
    } finally {
      setCreating(false);
    }
  };

  const buttons = stepButtons(step, {
    claudeReady,
    hasBrand: existing !== null,
    createdBrand: created !== null,
    brandName: draft.name,
    brandProblem: problem,
    creating,
  });

  const primary = () => {
    switch (buttons.primary.action) {
      case "advance":
        go(nextStep(step));
        break;
      case "create-brand":
        void createBrand();
        break;
      case "finish":
        finish();
        break;
      case "open-brand":
        finish();
        if (existing) useAppStore.getState().navigate({ kind: "brand", id: existing.id });
        break;
    }
  };
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const enabledRef = useRef(buttons.primary.enabled);
  enabledRef.current = buttons.primary.enabled;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        skipRef.current();
        return;
      }
      const target = event.target as HTMLElement | null;
      const inField = target?.closest("input, textarea, button, [role=menu]") !== null;
      if (event.key === "Enter" && !inField && !event.metaKey && !event.shiftKey) {
        if (enabledRef.current) {
          event.preventDefault();
          primaryRef.current();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const index = stepIndex(step);
  const hostUp = isHostUp(host);

  return (
    <div className="fixed inset-0 z-[97] flex items-center justify-center bg-black/40 animate-fade-in">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Başlangıç rehberi"
        className="flex h-[min(620px,calc(100vh-80px))] w-[720px] animate-pop-in flex-col overflow-hidden rounded-[14px] border border-border bg-surface-2 shadow-popover"
      >
        <div className="flex items-center gap-1.5 px-7 pt-6">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              aria-hidden="true"
              className={cn(
                "size-[7px] rounded-full transition-colors duration-200",
                i === index ? "bg-accent" : i < index ? "bg-fg-3" : "bg-control-pressed",
              )}
            />
          ))}
          <span className="flex-1" />
          <span className="text-footnote text-fg-3">
            {index + 1} / {STEPS.length} · {stepTitle(step)}
          </span>
        </div>
        <div className="scroll-area min-h-0 flex-1 px-7 pt-5 pb-2">
          {step === "welcome" && <Welcome />}
          {step === "claude" && (
            <ClaudeStep
              account={account}
              online={online}
              signingIn={signingIn}
              rechecking={rechecking}
              error={claudeError}
              onLogin={() => void startLogin()}
              onRecheck={() => void recheck()}
            />
          )}
          {step === "server" && <ServerStep hostUp={hostUp} online={presence?.online === true} />}
          {step === "brand" && (
            <Page
              title="İlk marka"
              text="Müşteri markasının adını yaz. Sonra marka kitine örnek postlarını, logosunu ve renklerini ekleyip profilini çıkaracaksın."
            >
              {existing && !created && (
                <p className="mb-3 text-body text-fg-2">
                  {existing.name} markan hazır. Yeni bir marka eklemek istersen aşağıyı doldur;
                  istemezsen devam et.
                </p>
              )}
              <BrandForm
                draft={draft}
                onChange={setDraft}
                onSubmit={() => {
                  if (buttons.primary.enabled) primary();
                }}
                autoFocus
              />
              {(brandError || (draft.name && problem)) && (
                <p role="alert" className="mt-3 text-footnote text-danger">
                  {brandError ?? problem}
                </p>
              )}
            </Page>
          )}
          {step === "done" && (
            <Page
              title="Hazırsın"
              text={`Bundan sonra Yeni sohbet'ten bir şey iste: "Bu ayın postlarını planla" gibi. Önce marka kitini doldurup profili çıkarmanı öneririz.`}
            >
              <ul className="flex flex-col gap-2.5">
                <DoneRow
                  ok={claudeReady}
                  text={
                    claudeReady
                      ? "Claude hesabı bağlı"
                      : "Claude girişi yapılmadı · Ayarlar → Yapay zekâ"
                  }
                />
                <DoneRow
                  ok={hostUp}
                  text={
                    hostUp
                      ? "Mac sunucusu çalışıyor"
                      : "Mac sunucusu çalışmıyor · Ayarlar → Gelişmiş"
                  }
                />
                <DoneRow
                  ok={existing !== null}
                  text={
                    existing ? `Marka: ${existing.name}` : "Marka eklenmedi · Ayarlar → Markalar"
                  }
                />
                {brandError && <DoneRow ok={false} text={`${brandError} · Ayarlar → Hesaplar`} />}
              </ul>
            </Page>
          )}
        </div>
        <div className="flex items-center gap-2 px-6 pt-3 pb-5">
          {buttons.back && (
            <Button size="lg" onClick={() => go(previousStep(step))}>
              Geri
            </Button>
          )}
          {buttons.skip && (
            <Button
              size="lg"
              variant="ghost"
              title="Sonra Ayarlar → Hakkında → Başlangıç rehberi ile kaldığın yerden devam edebilirsin."
              onClick={skip}
            >
              Şimdilik geç
            </Button>
          )}
          <span className="flex-1" />
          {buttons.secondary && (
            <Button size="lg" onClick={finish}>
              {buttons.secondary.title}
            </Button>
          )}
          <Button
            size="lg"
            variant={buttons.primary.kind}
            disabled={!buttons.primary.enabled}
            icon={creating ? <Spinner size={12} /> : undefined}
            onClick={primary}
          >
            {buttons.primary.title}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Page({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <h2 className="text-title font-semibold text-fg">{title}</h2>
      <p className="mt-2 mb-5 text-body-lg text-fg-2">{text}</p>
      {children}
    </div>
  );
}

function Welcome() {
  const items: [ReactNode, string][] = [
    [
      <UserRoundCheck key="c" size={17} strokeWidth={1.5} />,
      "Claude hesabını bağla: içerikleri Mac'indeki Claude aboneliğinle üretirsin.",
    ],
    [
      <MonitorSmartphone key="m" size={17} strokeWidth={1.5} />,
      "Veriler ve üretim bu Mac'te; iPhone'unu bir QR kodla bağlarsın.",
    ],
    [
      <Layers key="b" size={17} strokeWidth={1.5} />,
      "İlk markanı ekle: örnek postlardan marka profilini çıkarırsın.",
    ],
  ];
  return (
    <Page
      title="Studio'ya hoş geldin"
      text="Birkaç adımda hazır olacağız. İstediğin adımı geçebilir, sonra Ayarlar → Hakkında'dan kaldığın yerden devam edebilirsin."
    >
      <ul className="flex flex-col gap-4">
        {items.map(([icon, text]) => (
          <li key={text} className="flex items-start gap-3 text-body-lg text-fg">
            <span className="mt-0.5 flex w-[22px] shrink-0 justify-center text-fg-2">{icon}</span>
            {text}
          </li>
        ))}
      </ul>
    </Page>
  );
}

function StatusLine({
  tone,
  text,
  title,
}: {
  tone: "ok" | "wait" | "off" | "error";
  text: string;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-body text-fg" title={title}>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "ok"
            ? "bg-success"
            : tone === "wait"
              ? "bg-accent"
              : tone === "error"
                ? "bg-danger"
                : "bg-fg-3",
        )}
      />
      {text}
    </div>
  );
}

function ClaudeStep({
  account,
  online,
  signingIn,
  rechecking,
  error,
  onLogin,
  onRecheck,
}: {
  account: ClaudeControl["account"];
  online: boolean;
  signingIn: boolean;
  rechecking: boolean;
  error: string | null;
  onLogin(): void;
  onRecheck(): void;
}) {
  let line: { tone: "ok" | "wait" | "off" | "error"; text: string };
  if (!account) {
    line = { tone: "off", text: online ? "Durum okunuyor…" : "Arka plan hazır değil" };
  } else {
    switch (account.status) {
      case "signed_in": {
        const who = [account.email, account.plan].filter(Boolean).join(" · ");
        line = { tone: "ok", text: who ? `Giriş yapıldı: ${who}` : "Giriş yapıldı" };
        break;
      }
      case "signing_in":
        line = { tone: "wait", text: "Tarayıcıda giriş bekleniyor…" };
        break;
      case "signed_out":
        line = { tone: "wait", text: "Giriş yapılmadı" };
        break;
      case "not_installed":
        line = { tone: "error", text: "Claude Code bu Mac'te kurulu değil" };
        break;
      default:
        line = { tone: "error", text: "Durum okunamadı" };
    }
  }
  const details: string[] = [];
  if (account?.cliVersion) details.push(`Claude Code ${account.cliVersion}`);
  if (account?.detail && account.status !== "signed_in") details.push(account.detail);
  if (account?.status === "not_installed")
    details.push("Aşağıdan Anthropic'in resmi kaynağından kur; kurulunca giriş yap.");
  if (!online) details.push("Mac sunucusu çalışınca durum burada görünür (sonraki adım).");
  const signedIn = account?.status === "signed_in";
  const loginUrl = account?.loginUrl && !signedIn ? account.loginUrl : null;
  return (
    <Page
      title="Claude hesabı"
      text="Studio içerikleri bu Mac'teki Claude Code ile, senin aboneliğinle üretir. Giriş tarayıcıda açılır; şifren Studio'ya gelmez."
    >
      <div className="flex flex-col gap-2 rounded-[12px] border border-border px-4 py-3">
        <StatusLine tone={line.tone} text={line.text} />
        {details.length > 0 && <p className="text-footnote text-fg-2">{details.join(" · ")}</p>}
        {account?.status === "not_installed" && <ToolRequired id="claude" />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant={signedIn || signingIn ? "secondary" : "primary"}
          disabled={!signingIn && (!online || account?.status === "not_installed")}
          icon={signingIn ? <Spinner size={12} /> : undefined}
          title={
            signingIn
              ? "Tarayıcıdaki giriş bekleniyor; vazgeçtiysen bekleme burada durur."
              : undefined
          }
          onClick={onLogin}
        >
          {signedIn ? "Hesabı değiştir" : signingIn ? "Beklemeyi bırak" : "Claude'a giriş yap"}
        </Button>
        <Button
          disabled={!online || rechecking}
          icon={rechecking ? <Spinner size={12} /> : undefined}
          onClick={onRecheck}
        >
          Durumu yenile
        </Button>
        {loginUrl && (
          <Button variant="ghost" onClick={() => void bridge().openExternal(loginUrl)}>
            Giriş sayfasını aç
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-footnote text-danger">
          {error}
        </p>
      )}
    </Page>
  );
}

function ServerStep({ hostUp, online }: { hostUp: boolean; online: boolean }) {
  const host = useHost();
  const status = host?.status;
  const server: { tone: "ok" | "wait" | "off" | "error"; text: string; title?: string } =
    status?.kind === "running" || status?.kind === "attached"
      ? { tone: "ok", text: "Studio bu Mac'te çalışıyor" }
      : status?.kind === "starting"
        ? { tone: "wait", text: "Studio hazırlanıyor…", title: status.message }
        : status?.kind === "error"
          ? { tone: "error", text: "Studio başlatılamadı", title: status.message }
          : { tone: "off", text: "Studio durdu" };
  const lan = (host?.lanUrls.length ?? 0) > 0;
  return (
    <Page
      title="Mac ve iPhone"
      text="Veriler, üretim ve yayın bu Mac'te çalışır. iPhone'dan da kullanmak için kodu okut; istersen bu adımı geçip sonra Ayarlar → Cihazlar'dan bağlarsın."
    >
      <div className="flex items-start gap-5">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-2 rounded-[12px] border border-border px-4 py-3">
            <StatusLine tone={server.tone} text={server.text} title={server.title} />
            {status?.kind === "error" && (
              <p className="text-footnote text-fg-2">
                Yeniden başlatmayı dene; sürerse Ayarlar → Gelişmiş'teki hata kaydına bak.
              </p>
            )}
            <StatusLine
              tone={online ? "ok" : "off"}
              text={
                online ? "Hazır: işler hemen çalışır" : "Arka plan çalışmıyor: işler sırada bekler"
              }
            />
            <StatusLine
              tone={lan ? "ok" : "off"}
              text={lan ? "iPhone bağlanabilir" : "iPhone şu an bağlanamaz"}
            />
            {!lan && hostUp && (
              <p className="text-footnote text-fg-2">
                iPhone'un bağlanabilmesi için Ayarlar → Gelişmiş → Yerel ağdan erişim açık olmalı.
              </p>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void bridge().host.restart()}>Yeniden başlat</Button>
            <Button
              variant="ghost"
              onClick={() => {
                useOnboardingSheet.getState().setOpen(false);
                openSettings("devices");
              }}
            >
              Ayarlar → Cihazlar
            </Button>
          </div>
        </div>
        {hostUp && (
          <div className="w-[270px] shrink-0">
            <LivePairingCard />
          </div>
        )}
      </div>
    </Page>
  );
}

function DoneRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={cn("flex items-center gap-2.5 text-body-lg", ok ? "text-fg" : "text-fg-2")}>
      {ok ? (
        <CircleCheck size={17} strokeWidth={1.75} className="shrink-0 text-accent" />
      ) : (
        <CircleDashed size={17} strokeWidth={1.5} className="shrink-0 text-fg-3" />
      )}
      {text}
    </li>
  );
}
