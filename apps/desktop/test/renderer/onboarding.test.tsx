import type { ApiClient, Brand } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, HostSnapshot } from "../../src/shared/ipc.ts";

const T = "2026-11-17T10:00:00.000Z";

const state = vi.hoisted(() => ({
  settings: null as unknown as DesktopSettings,
  update: (() => undefined) as (patch: Partial<DesktopSettings>) => void,
  brands: [] as Brand[],
}));

vi.mock("../../src/renderer/state/studio.tsx", () => {
  const host: HostSnapshot = {
    status: { kind: "running" },
    apiPort: 8790,
    lanPort: null,
    instance: "i",
    lanUrls: [],
    tunnelUrl: null,
    tunnelNote: null,
    services: {},
    ownsChildren: true,
  };
  return {
    queryKeys: { brands: ["brands"], conversations: ["conversations"], accounts: ["accounts"] },
    isHostUp: () => true,
    useHost: () => host,
    useSettings: () => ({ settings: state.settings, update: state.update }),
    useJobs: () => ({ jobs: [], presence: null, status: "open" }),
    useBrands: () => ({ data: state.brands, isSuccess: true, isLoading: false }),
  };
});

import {
  EMPTY_DRAFT,
  withName,
  withSlug,
} from "../../src/renderer/features/onboarding/brand-form.tsx";
import {
  brandProblem,
  loginProgress,
  needsSetup,
  nextStep,
  normalizedHandle,
  previousStep,
  reopenStep,
  shouldAutoOpen,
  stepButtons,
} from "../../src/renderer/features/onboarding/model.ts";
import { OnboardingSheet } from "../../src/renderer/features/onboarding/onboarding-sheet.tsx";
import {
  openOnboarding,
  useOnboardingSheet,
} from "../../src/renderer/features/onboarding/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { fallbackSettings } from "../../src/renderer/lib/bridge.ts";

const ctx = {
  claudeReady: false,
  hasBrand: false,
  createdBrand: false,
  brandName: "",
  brandProblem: "Marka adını yaz." as string | null,
  creating: false,
};

describe("onboarding steps", () => {
  it("walks welcome → claude → server → brand → done and back", () => {
    expect(nextStep("welcome")).toBe("claude");
    expect(nextStep("claude")).toBe("server");
    expect(nextStep("brand")).toBe("done");
    expect(nextStep("done")).toBe("done");
    expect(previousStep("server")).toBe("claude");
    expect(previousStep("welcome")).toBe("welcome");
  });

  it("opens by itself only when something needs setting up, never after finish or skip", () => {
    const fresh = { completed: false, skipped: false, step: "welcome" };
    expect(needsSetup(0, "signed_in")).toBe(true);
    expect(needsSetup(2, "signed_out")).toBe(true);
    expect(needsSetup(2, "signed_in")).toBe(false);
    expect(needsSetup(2, null)).toBe(false);
    expect(shouldAutoOpen(fresh, 0, null)).toBe(true);
    expect(shouldAutoOpen({ ...fresh, skipped: true }, 0, null)).toBe(false);
    expect(shouldAutoOpen({ ...fresh, completed: true }, 0, "signed_out")).toBe(false);
  });

  it("resumes where it stopped, starts over after completion", () => {
    expect(reopenStep({ completed: false, skipped: true, step: "brand" })).toBe("brand");
    expect(reopenStep({ completed: true, skipped: false, step: "done" })).toBe("welcome");
    expect(reopenStep({ completed: false, skipped: false, step: "bogus" })).toBe("welcome");
    expect(reopenStep({ completed: true, skipped: false, step: "done" }, "server")).toBe("server");
  });

  it("primary buttons per step", () => {
    expect(stepButtons("welcome", ctx)).toMatchObject({
      primary: { title: "Başla", action: "advance" },
      back: false,
      skip: true,
    });
    expect(stepButtons("claude", ctx).primary).toMatchObject({
      title: "Sonra yaparım",
      kind: "secondary",
    });
    expect(stepButtons("claude", { ...ctx, claudeReady: true }).primary).toMatchObject({
      title: "Devam",
      kind: "primary",
    });
    expect(stepButtons("brand", ctx).primary).toMatchObject({
      title: "Markayı oluştur",
      enabled: false,
      action: "create-brand",
    });
    expect(
      stepButtons("brand", { ...ctx, brandName: "MTM", brandProblem: null }).primary.enabled,
    ).toBe(true);
    // An existing brand and nothing typed: just continue.
    expect(stepButtons("brand", { ...ctx, hasBrand: true }).primary).toMatchObject({
      title: "Devam",
      action: "advance",
    });
    expect(stepButtons("done", { ...ctx, hasBrand: true })).toMatchObject({
      primary: { title: "Marka kitini hazırla", action: "open-brand" },
      secondary: { title: "Bitir" },
      back: false,
      skip: false,
    });
    expect(stepButtons("done", ctx).primary).toMatchObject({ title: "Bitir", action: "finish" });
  });

  it("brand form: short name follows the name until edited, and is checked", () => {
    const named = withName(EMPTY_DRAFT, "Çiftçi Şükrü Ağa");
    expect(named.slug).toBe("ciftci-sukru-aga");
    const edited = withSlug(named, "kisa");
    expect(withName(edited, "Başka").slug).toBe("kisa");
    expect(brandProblem("", "")).toBe("Marka adını yaz.");
    expect(brandProblem("X", "Bad Slug")).toContain("küçük harf");
    expect(brandProblem("MTM", "mtm")).toBeNull();
    expect(normalizedHandle(" mtmagro ")).toBe("@mtmagro");
    expect(normalizedHandle("")).toBe("");
  });

  it("Claude login: waits, finishes when signed in, fails after signing_in falls back", () => {
    expect(loginProgress(false, "signed_out")).toEqual({ sawSigningIn: false, outcome: "waiting" });
    expect(loginProgress(false, "signing_in")).toEqual({ sawSigningIn: true, outcome: "waiting" });
    expect(loginProgress(true, "signed_out")).toEqual({ sawSigningIn: true, outcome: "failed" });
    expect(loginProgress(true, "signed_in").outcome).toBe("signed_in");
  });
});

describe("OnboardingSheet", () => {
  const api = {
    workers: {
      claude: async () => ({ account: null, online: true, sent: 0 }),
      claudeLogin: vi.fn(async () => ({ account: null, online: true, sent: 1 })),
    },
    brands: {
      create: vi.fn(async (input: { name: string; slug?: string; defaultLanguage?: string }) => ({
        id: "new",
        name: input.name,
        slug: input.slug ?? "x",
        defaultLanguage: input.defaultLanguage ?? "tr",
        status: "active",
        createdAt: T,
        updatedAt: T,
      })),
    },
    // The pairing QR card on the "Mac ve iPhone" step.
    pairing: {
      createCode: vi.fn(async () => ({
        code: "123456",
        expiresAt: "2099-01-01T00:00:00.000Z",
        secret: "s".repeat(43),
        secretExpiresAt: "2099-01-01T00:00:00.000Z",
      })),
      routes: async () => ({
        macName: "Mac",
        macId: "i",
        lanAddresses: ["192.168.1.5"],
        lanPort: 8791,
        bonjourName: null,
        tunnelUrl: null,
        updatedAt: T,
      }),
    },
    devices: { list: async () => ({ items: [] }) },
  } as unknown as ApiClient;

  beforeEach(() => {
    state.settings = fallbackSettings();
    state.update = vi.fn((patch) => {
      state.settings = { ...state.settings, ...patch } as DesktopSettings;
    });
    state.brands = [];
    useOnboardingSheet.setState({ open: false, requested: null });
  });

  function show() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={client}>
          <OnboardingSheet />
        </QueryClientProvider>
      </ApiContext.Provider>,
    );
  }

  it("never opens by itself in the browser preview", () => {
    show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("steps through, saves the step, creates the first brand", async () => {
    openOnboarding();
    show();
    expect(screen.getByText("Studio'ya hoş geldin")).toBeInTheDocument();
    expect(screen.getByText("1 / 5 · Hoş geldin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Başla" }));
    expect(screen.getByText("Claude hesabı", { selector: "h2" })).toBeInTheDocument();
    expect(state.update).toHaveBeenLastCalledWith({
      onboarding: { completed: false, skipped: false, step: "claude" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Claude'a giriş yap" }));
    expect(api.workers.claudeLogin).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Beklemeyi bırak" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sonra yaparım" }));
    expect(screen.getByText("Mac ve iPhone", { selector: "h2" })).toBeInTheDocument();
    expect(screen.getByText("Studio bu Mac'te çalışıyor")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "iPhone'u bağla" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Devam" }));
    const create = screen.getByRole("button", { name: "Markayı oluştur" });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Marka adı" }), "MTM Agro");
    expect(screen.getByRole("textbox", { name: "Kısa ad" })).toHaveValue("mtm-agro");
    await userEvent.click(screen.getByRole("button", { name: "Markayı oluştur" }));
    expect(api.brands.create).toHaveBeenCalledWith({
      name: "MTM Agro",
      slug: "mtm-agro",
      defaultLanguage: "tr",
    });
    expect(await screen.findByText("Hazırsın")).toBeInTheDocument();
    expect(screen.getByText("Marka: MTM Agro")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bitir" }));
    expect(state.update).toHaveBeenLastCalledWith({
      onboarding: { completed: true, skipped: false, step: "done" },
    });
    expect(useOnboardingSheet.getState().open).toBe(false);
  });

  it("Esc skips and keeps the step for later", () => {
    state.settings = {
      ...state.settings,
      onboarding: { completed: false, skipped: false, step: "server" },
    };
    openOnboarding();
    show();
    expect(screen.getByText("3 / 5 · Mac ve iPhone")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(state.update).toHaveBeenLastCalledWith({
      onboarding: { completed: false, skipped: true, step: "server" },
    });
    expect(useOnboardingSheet.getState().open).toBe(false);
  });
});
