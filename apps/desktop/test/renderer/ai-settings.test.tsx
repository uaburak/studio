import type {
  AiPreferences,
  AiSpendSummary,
  ApiClient,
  ClaudeAccount,
  WorkerPresence,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../src/shared/ipc.ts";
import { presence as basePresence } from "./fixtures.ts";

// Ayarlar → Yapay zekâ / Kullanım with a stand-in API (S7 preference, Claude limit answer, U8 spend).

const NOW = "2026-11-18T10:00:00.000Z";

const state = vi.hoisted(() => ({ presence: null as WorkerPresence | null }));

vi.mock("../../src/renderer/state/studio.tsx", async () => {
  const { fallbackSettings } = await import("../../src/renderer/lib/bridge.ts");
  const host: HostSnapshot = {
    status: { kind: "attached" },
    apiPort: 8790,
    lanPort: 8791,
    instance: "i",
    lanUrls: [],
    tunnelUrl: null,
    tunnelNote: null,
    services: {},
    ownsChildren: false,
  };
  const settings = fallbackSettings();
  return {
    isHostUp: () => true,
    useHost: () => host,
    useSettings: () => ({ settings, update: () => undefined }),
    useJobs: () => ({ jobs: [], presence: state.presence, status: "open", controller: {} }),
  };
});

import { AiSection, UsageSection } from "../../src/renderer/features/settings/sections/ai.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";

const claude = (over: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  status: "signed_in",
  email: "a@b.c",
  plan: "Claude Max",
  cliVersion: "2.1.0",
  loginUrl: null,
  detail: null,
  checkedAt: NOW,
  ...over,
});

const prefs = (over: Partial<AiPreferences> = {}): AiPreferences => ({
  claudeLimit: "ask",
  monthlyBudgetUsd: null,
  stopAtBudget: false,
  limitDecision: null,
  updatedAt: null,
  ...over,
});

const totals = (costUsd: number, calls: number) => ({
  costUsd,
  calls,
  unpricedCalls: 0,
  inputTokens: 1000,
  outputTokens: 100,
  thoughtsTokens: 0,
});

function summary(over: Partial<AiSpendSummary> = {}): AiSpendSummary {
  return {
    provider: "gemini",
    currency: "USD",
    today: totals(1, 1),
    month: totals(6, 3),
    byModel: [
      { model: "gpt-image-1", provider: "openai", ...totals(4, 1) },
      { model: "gemini-2.5-flash", provider: "gemini", ...totals(2, 2) },
    ],
    byProvider: [
      { provider: "openai", ...totals(4, 1) },
      { provider: "gemini", ...totals(2, 2) },
    ],
    budget: {
      monthlyUsd: 5,
      remainingUsd: -1,
      usedPercent: 120,
      warning: true,
      stopAtBudget: true,
      exhausted: true,
    },
    balance: { known: false, remainingUsd: null, billingUrl: "https://aistudio.google.com/usage" },
    pricingVersion: "2026-11-18",
    dayStart: NOW,
    monthStart: NOW,
    ...over,
  };
}

function fakeApi(initial: AiPreferences = prefs(), spend: AiSpendSummary = summary()) {
  let current = initial;
  const ai = {
    keys: vi.fn(async () => ({ items: [], vaultReady: true })),
    preferences: vi.fn(async () => current),
    setPreferences: vi.fn(async (input: Partial<AiPreferences>) => {
      current = { ...current, ...input, updatedAt: NOW };
      return current;
    }),
    decideClaudeLimit: vi.fn(async (input: { choice: "gemini" | "wait" }) => {
      current = {
        ...current,
        limitDecision: { choice: input.choice, until: "2026-11-18T14:30:00.000Z", decidedAt: NOW },
      };
      return current;
    }),
    spend: vi.fn(async () => spend),
    setBudget: vi.fn(async () => spend),
  };
  const api = {
    ai,
    workers: {
      claude: async () => ({ account: null, online: true, sent: 0 }),
      gemini: async () => ({ account: null, online: true, sent: 0 }),
      providers: async () => ({ providers: [], online: true, sent: 0 }),
    },
  };
  return { api, ai };
}

function wrap(ui: ReactNode, api: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-settings-row="${id}"]`) as HTMLElement;

beforeEach(() => {
  state.presence = { ...basePresence, claude: claude() };
});

describe("Claude sınırı dolunca (S7)", () => {
  it("shows the stored choice with a line for each option and saves a new one", async () => {
    const { api, ai } = fakeApi(prefs({ claudeLimit: "wait" }));
    wrap(<AiSection />, api);
    const group = await screen.findByRole("radiogroup", { name: "Claude sınırı dolunca" });
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Bekle" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    const text = row("ai.claudeLimit").textContent ?? "";
    expect(text).toContain("Sor: iş durur, sana sorulur.");
    expect(text).toContain("Gemini'ye geç: Gemini ile sürer");
    expect(text).toContain("Bekle: sınır sıfırlanınca kendiliğinden devam eder.");

    await userEvent.click(within(group).getByRole("radio", { name: "Gemini'ye geç" }));
    expect(ai.setPreferences).toHaveBeenCalledWith({ claudeLimit: "gemini" });
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Gemini'ye geç" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });

  it("defaults to Sor", async () => {
    const { api } = fakeApi();
    wrap(<AiSection />, api);
    const group = await screen.findByRole("radiogroup", { name: "Claude sınırı dolunca" });
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Sor" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });
});

describe("Claude limit in the Claude row (S7)", () => {
  const limited = (over: Partial<NonNullable<ClaudeAccount["limit"]>> = {}) => {
    state.presence = {
      ...basePresence,
      claude: claude({
        limit: {
          resetsAt: "2026-11-18T14:30:00.000Z",
          mode: "ask",
          decision: null,
          waiting: 2,
          geminiReady: true,
          ...over,
        },
      }),
    };
  };

  it("asks for an answer and sends it", async () => {
    limited();
    const { api, ai } = fakeApi();
    wrap(<AiSection />, api);
    const claudeRow = row("ai.claude");
    expect(claudeRow.textContent).toContain("Claude sınırı doldu");
    expect(claudeRow.textContent).toContain("sıfırlanır · 2 iş bekliyor");
    await userEvent.click(within(claudeRow).getByRole("button", { name: "Gemini ile devam et" }));
    expect(ai.decideClaudeLimit).toHaveBeenCalledWith({ choice: "gemini" });
    await waitFor(() => expect(claudeRow.textContent).toContain("Gemini ile sürüyor"));
    expect(within(claudeRow).queryByRole("button", { name: "Sınırı bekle" })).toBeNull();
  });

  it("cannot go on with Gemini without a key", () => {
    limited({ geminiReady: false });
    const { api } = fakeApi();
    wrap(<AiSection />, api);
    const claudeRow = row("ai.claude");
    expect(within(claudeRow).getByRole("button", { name: "Gemini ile devam et" })).toBeDisabled();
    expect(claudeRow.textContent).toContain("Gemini anahtarı yok");
  });

  it("shows an answer already given instead of the buttons", () => {
    limited({ decision: "wait" });
    const { api } = fakeApi();
    wrap(<AiSection />, api);
    const claudeRow = row("ai.claude");
    expect(claudeRow.textContent).toContain("Sınır bekleniyor");
    expect(within(claudeRow).queryByRole("button", { name: "Gemini ile devam et" })).toBeNull();
  });

  it("shows nothing about a limit when there is none", () => {
    const { api } = fakeApi();
    wrap(<AiSection />, api);
    expect(row("ai.claude").textContent).not.toContain("Claude sınırı doldu");
  });
});

describe("Kullanım: paid AI spend and budget (U8)", () => {
  it("shows every service, the used-up budget and the stop switch", async () => {
    const { api, ai } = fakeApi(prefs({ monthlyBudgetUsd: 5, stopAtBudget: true }));
    wrap(<UsageSection />, api);
    await waitFor(() =>
      expect(row("usage.gemini").textContent).toContain("OpenAI — $4.00 · 1 çağrı"),
    );
    expect(row("usage.gemini").textContent).toContain("Gemini — $2.00 · 2 çağrı");
    expect(row("usage.gemini").textContent).toContain("ElevenLabs — harcama yok");
    expect(row("usage.gemini").textContent).toContain("Yapay zekâ harcaması");
    expect(row("usage.geminiBudget").textContent).toContain("Aylık yapay zekâ bütçesi");
    expect(row("usage.geminiBudget").textContent).toContain(
      "Bütçe doldu: ücretli yapay zekâ çağrıları durduruldu.",
    );
    const toggle = within(row("usage.stopAtBudget")).getByRole("switch", {
      name: "Bütçe dolunca dur",
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(toggle);
    expect(ai.setPreferences).toHaveBeenCalledWith({ stopAtBudget: false });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("refuses a budget that is not a number", async () => {
    const { api, ai } = fakeApi();
    wrap(<UsageSection />, api);
    const field = await screen.findByRole("textbox", { name: "Aylık yapay zekâ bütçesi (USD)" });
    await waitFor(() => expect(field).toHaveValue("5"));
    await userEvent.clear(field);
    await userEvent.type(field, "çok");
    await userEvent.click(
      within(row("usage.geminiBudget")).getByRole("button", { name: "Kaydet" }),
    );
    expect(ai.setBudget).not.toHaveBeenCalled();
    expect(row("usage.geminiBudget").textContent).toContain("Bütçe 0 ya da daha büyük");
    await userEvent.clear(field);
    await userEvent.type(field, "7,5");
    await userEvent.click(
      within(row("usage.geminiBudget")).getByRole("button", { name: "Kaydet" }),
    );
    expect(ai.setBudget).toHaveBeenCalledWith(expect.objectContaining({ geminiMonthlyUsd: 7.5 }));
  });
});
