// First-run guide (the AppKit app's OnboardingModel): Hoş geldin → Claude hesabı → Mac ve
// iPhone → İlk marka → Hazır. Pure step logic; the sheet renders it.
//
// It opens by itself after the first load when there is no brand or Claude is signed out,
// unless it was completed or skipped. Skipping keeps the step (Hakkında → Başlangıç rehberi
// resumes there); completion is final.
import { type ClaudeAccountStatus, slugify } from "@studio/contract";
import type { OnboardingState } from "../../../shared/ipc.ts";

export type OnboardingStep = "welcome" | "claude" | "server" | "brand" | "done";

export const STEPS: { id: OnboardingStep; title: string }[] = [
  { id: "welcome", title: "Hoş geldin" },
  { id: "claude", title: "Claude hesabı" },
  { id: "server", title: "Mac ve iPhone" },
  { id: "brand", title: "İlk marka" },
  { id: "done", title: "Hazır" },
];

export function parseStep(value: string | null | undefined): OnboardingStep {
  return STEPS.some((s) => s.id === value) ? (value as OnboardingStep) : "welcome";
}

export function stepIndex(step: OnboardingStep): number {
  return STEPS.findIndex((s) => s.id === step);
}

export function stepTitle(step: OnboardingStep): string {
  return STEPS[stepIndex(step)]?.title ?? "";
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  return STEPS[Math.min(stepIndex(step) + 1, STEPS.length - 1)]?.id ?? step;
}

export function previousStep(step: OnboardingStep): OnboardingStep {
  return STEPS[Math.max(stepIndex(step) - 1, 0)]?.id ?? step;
}

/** Nothing to set up when there is a brand and Claude is signed in (or its state is unknown). */
export function needsSetup(brandCount: number, claude: ClaudeAccountStatus | null | undefined) {
  if (brandCount === 0) return true;
  return claude === "signed_out" || claude === "not_installed" || claude === "error";
}

export function shouldAutoOpen(
  state: OnboardingState,
  brandCount: number,
  claude: ClaudeAccountStatus | null | undefined,
): boolean {
  if (state.completed || state.skipped) return false;
  return needsSetup(brandCount, claude);
}

/** Reopened from Hakkında: resume where it stopped (start over after completion). */
export function reopenStep(state: OnboardingState, target?: OnboardingStep): OnboardingStep {
  if (target) return target;
  const step = parseStep(state.step);
  return state.completed || step === "done" ? "welcome" : step;
}

export const LANGUAGES: { tag: string; label: string }[] = [
  { tag: "tr", label: "Türkçe" },
  { tag: "en", label: "İngilizce" },
  { tag: "de", label: "Almanca" },
  { tag: "fr", label: "Fransızca" },
  { tag: "es", label: "İspanyolca" },
  { tag: "it", label: "İtalyanca" },
  { tag: "ar", label: "Arapça" },
  { tag: "ru", label: "Rusça" },
];

export function languageLabel(tag: string): string {
  return LANGUAGES.find((l) => l.tag === tag)?.label ?? tag;
}

/** Why "Markayı oluştur" is disabled, or null. */
export function brandProblem(name: string, slug: string): string | null {
  if (!name.trim()) return "Marka adını yaz.";
  if (slug.length < 2 || slug !== slugify(slug)) {
    return "Kısa ad yalnızca küçük harf, rakam ve tire içerebilir.";
  }
  return null;
}

/** `@handle` for Instagram (BrandSettingsModel.normalizedHandle). */
export function normalizedHandle(raw: string): string {
  const handle = raw.trim();
  if (!handle) return "";
  return (handle.startsWith("@") ? handle : `@${handle}`).slice(0, 100);
}

/**
 * While "Claude'a giriş yap" waits on the browser: polled status → keep waiting, done, or the
 * CLI finished without signing in (it reported `signing_in` before, now something else).
 */
export function loginProgress(
  sawSigningIn: boolean,
  status: ClaudeAccountStatus | null | undefined,
): { sawSigningIn: boolean; outcome: "waiting" | "signed_in" | "failed" } {
  if (status === "signed_in") return { sawSigningIn, outcome: "signed_in" };
  if (status === "signing_in") return { sawSigningIn: true, outcome: "waiting" };
  if (sawSigningIn && (status === "signed_out" || status === "error" || status === "not_installed"))
    return { sawSigningIn, outcome: "failed" };
  return { sawSigningIn, outcome: "waiting" };
}

/** The CLI waits at most 10 minutes for the browser. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const LOGIN_POLL_MS = 2_000;

export type PrimaryAction = "advance" | "create-brand" | "finish" | "open-brand";

export interface StepButtons {
  primary: {
    title: string;
    kind: "primary" | "secondary";
    enabled: boolean;
    action: PrimaryAction;
  };
  /** "Bitir" next to "Marka kitini hazırla" on the last step. */
  secondary: { title: string; action: "finish" } | null;
  back: boolean;
  skip: boolean;
}

export function stepButtons(
  step: OnboardingStep,
  ctx: {
    claudeReady: boolean;
    hasBrand: boolean;
    createdBrand: boolean;
    brandName: string;
    brandProblem: string | null;
    creating: boolean;
  },
): StepButtons {
  const base = { back: step !== "welcome" && step !== "done", skip: step !== "done" };
  switch (step) {
    case "welcome":
      return {
        ...base,
        primary: { title: "Başla", kind: "primary", enabled: true, action: "advance" },
        secondary: null,
      };
    case "claude":
      return {
        ...base,
        primary: {
          title: ctx.claudeReady ? "Devam" : "Sonra yaparım",
          kind: ctx.claudeReady ? "primary" : "secondary",
          enabled: true,
          action: "advance",
        },
        secondary: null,
      };
    case "server":
      return {
        ...base,
        primary: { title: "Devam", kind: "primary", enabled: true, action: "advance" },
        secondary: null,
      };
    case "brand":
      if (ctx.hasBrand && !ctx.createdBrand && !ctx.brandName.trim()) {
        return {
          ...base,
          primary: { title: "Devam", kind: "primary", enabled: true, action: "advance" },
          secondary: null,
        };
      }
      return {
        ...base,
        primary: {
          title: "Markayı oluştur",
          kind: "primary",
          enabled: ctx.brandProblem === null && !ctx.creating,
          action: "create-brand",
        },
        secondary: null,
      };
    case "done":
      return ctx.hasBrand
        ? {
            ...base,
            primary: {
              title: "Marka kitini hazırla",
              kind: "primary",
              enabled: true,
              action: "open-brand",
            },
            secondary: { title: "Bitir", action: "finish" },
          }
        : {
            ...base,
            primary: { title: "Bitir", kind: "primary", enabled: true, action: "finish" },
            secondary: null,
          };
  }
}
