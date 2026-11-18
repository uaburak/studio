import type {
  AiProviderStatus,
  AiSpendSummary,
  ClaudeLimitState,
  WorkerPresence,
} from "@studio/contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { modelMenu } from "../../src/renderer/components/chat/status-line.tsx";
import { Menu } from "../../src/renderer/components/ui/menu.tsx";
import {
  CLAUDE_LIMIT_OPTIONS,
  claudeLimitChoiceNow,
  claudeLimitChoiceText,
  claudeLimitHints,
  claudeLimitLine,
  claudeLimitModeWarning,
  resetTimeText,
} from "../../src/renderer/features/settings/claude-limit.ts";
import {
  ClaudeLimitActions,
  keyStateText,
  modelSpendLines,
} from "../../src/renderer/features/settings/sections/ai.tsx";
import { providerStatusLines } from "../../src/renderer/features/settings/status-text.ts";
import { modelUnavailableReason } from "../../src/renderer/lib/models.ts";
import {
  budgetLine,
  budgetNotice,
  EXHAUSTED_TEXT,
  exhaustedNote,
  formatUsd,
  modelSpendLine,
  parseBudgetInput,
  serviceLabel,
  serviceSpendLines,
  serviceTotals,
  spendHeadline,
  unpricedNote,
} from "../../src/renderer/lib/spend.ts";
import { presence as basePresence } from "./fixtures.ts";

const NOW = "2026-11-18T10:00:00.000Z";

function row(
  provider: AiProviderStatus["provider"],
  state: AiProviderStatus["state"],
  extra: Partial<AiProviderStatus> = {},
): AiProviderStatus {
  return {
    provider,
    state,
    account: null,
    cliVersion: null,
    defaultModel: null,
    models: [],
    loginUrl: null,
    tools: provider !== "antigravity",
    detail: null,
    checkedAt: NOW,
    ...extra,
  };
}

const presence: WorkerPresence = {
  ...basePresence,
  online: true,
  claude: {
    status: "signed_in",
    email: "a@b.c",
    plan: "Claude Max",
    cliVersion: "2.1.0",
    loginUrl: null,
    detail: null,
    checkedAt: NOW,
  },
  gemini: {
    status: "not_configured",
    mode: "none",
    apiKeyConfigured: false,
    cliVersion: null,
    defaultModel: null,
    detail: null,
    checkedAt: NOW,
  },
  providers: [
    row("codex", "not_installed"),
    row("openai", "ready", { account: "API anahtarı" }),
    row("antigravity", "signed_out"),
  ],
};

describe("model menu grouped by provider", () => {
  it("says why a provider cannot answer", () => {
    expect(modelUnavailableReason("opus", presence)).toBeNull();
    expect(modelUnavailableReason("gemini-flash", presence)).toBe("anahtar yok");
    expect(modelUnavailableReason("codex", presence)).toBe("kurulu değil");
    expect(modelUnavailableReason("gpt", presence)).toBeNull();
    expect(modelUnavailableReason("antigravity", presence)).toBe("giriş yapılmadı");
    expect(modelUnavailableReason("codex", { ...presence, online: false })).toBe("Mac çevrimdışı");
    // An older worker without `providers`: nothing to say yet.
    expect(modelUnavailableReason("codex", { ...presence, providers: undefined })).toBeNull();
  });

  it("lists Claude, Gemini, OpenAI and Antigravity with the unavailable ones greyed out", () => {
    const entries = modelMenu({ model: "opus", effort: "medium" }, () => undefined, presence);
    const labels = entries
      .filter((e) => e.type === "label")
      .map((e) => (e as { label: string }).label);
    expect(labels).toEqual(["Claude", "Gemini", "OpenAI", "Google Antigravity"]);
    render(<Menu inline open anchor={null} entries={entries} onClose={() => undefined} />);
    const codex = screen.getByRole("menuitem", { name: /Codex \(ChatGPT\)/ });
    expect(codex).toHaveAttribute("aria-disabled", "true");
    expect(codex.textContent).toContain("kurulu değil");
    expect(screen.getByRole("menuitem", { name: /GPT \(OpenAI API\)/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("provider rows and keys", () => {
  it("describes Codex / Antigravity readiness and offers sign-in", () => {
    expect(
      providerStatusLines(
        row("codex", "signed_out", { detail: "“Giriş yap” tarayıcıda açar." }),
        true,
        "d",
      ),
    ).toEqual({ lines: ["Giriş yapılmadı.", "“Giriş yap” tarayıcıda açar."], canLogin: true });
    expect(providerStatusLines(row("antigravity", "ready"), true, "d").canLogin).toBe(false);
    expect(providerStatusLines(row("codex", "ready"), true, "d").canLogin).toBe(true);
    const installed = providerStatusLines(
      row("codex", "not_installed", { detail: "npm i -g --prefix ~/.local @openai/codex" }),
      true,
      "d",
    );
    expect(installed.canLogin).toBe(false);
    expect(installed.lines.join("\n")).toContain("@openai/codex");
    expect(providerStatusLines(undefined, false, "d").lines[0]).toContain("Arka plan");
  });

  it("shows a stored key only by its hint", () => {
    expect(keyStateText(undefined, true)).toBe("Kayıtlı değil.");
    expect(
      keyStateText(
        {
          provider: "gemini",
          configured: true,
          hint: "…WXYZ",
          valid: true,
          checkedAt: null,
          detail: null,
          models: ["a", "b"],
          updatedAt: NOW,
        },
        true,
      ),
    ).toBe("Kayıtlı: …WXYZ · geçerli · 2 model");
    expect(keyStateText(undefined, false)).toContain("Kasa anahtarı yok");
  });
});

describe("AI spend wording", () => {
  const spend: AiSpendSummary = {
    provider: "gemini",
    currency: "USD",
    today: {
      costUsd: 0.0042,
      calls: 2,
      unpricedCalls: 0,
      inputTokens: 1000,
      outputTokens: 10,
      thoughtsTokens: 0,
    },
    month: {
      costUsd: 8.5,
      calls: 40,
      unpricedCalls: 1,
      inputTokens: 2_500_000,
      outputTokens: 90_000,
      thoughtsTokens: 10_000,
    },
    byModel: [
      {
        model: "gemini-2.5-flash",
        costUsd: 8.5,
        calls: 39,
        unpricedCalls: 0,
        inputTokens: 2_500_000,
        outputTokens: 90_000,
        thoughtsTokens: 10_000,
      },
    ],
    budget: { monthlyUsd: 10, remainingUsd: 1.5, usedPercent: 85, warning: true },
    balance: { known: false, remainingUsd: null, billingUrl: "https://aistudio.google.com/usage" },
    pricingVersion: "2026-11-18",
    dayStart: NOW,
    monthStart: NOW,
  };

  it("formats today / month, the budget and per-model lines", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(spendHeadline(spend)).toBe("Bugün $0.0042 · bu ay $8.50");
    expect(budgetLine(spend)).toBe("Kalan bütçe $1.50 / $10.00 (%85 kullanıldı)");
    expect(
      budgetLine({ ...spend, budget: { ...spend.budget, remainingUsd: -2, usedPercent: 120 } }),
    ).toBe("Bütçe aşıldı: $2.00 fazla (%120 kullanıldı)");
    expect(unpricedNote(spend)).toContain("1 çağrının");
    expect(modelSpendLines(spend)).toEqual([
      "gemini-2.5-flash — $8.50 · 39 çağrı · 2.5M giriş / 100K çıkış",
    ]);
  });
});

describe("paid AI spend per service (U8)", () => {
  const totals = (costUsd: number, calls: number) => ({
    costUsd,
    calls,
    unpricedCalls: 0,
    inputTokens: 12_000,
    outputTokens: 0,
    thoughtsTokens: 0,
  });
  const spend: AiSpendSummary = {
    provider: "gemini",
    currency: "USD",
    today: totals(1, 2),
    month: totals(5.25, 6),
    byModel: [
      { model: "gpt-image-1", provider: "openai", ...totals(3, 2) },
      { model: "gemini-2.5-flash", provider: "gemini", ...totals(2, 3) },
      { model: "eleven_multilingual_v2", provider: "elevenlabs", ...totals(0.25, 1) },
    ],
    byProvider: [
      { provider: "openai", ...totals(3, 2) },
      { provider: "gemini", ...totals(2, 3) },
    ],
    budget: {
      monthlyUsd: 5,
      remainingUsd: -0.25,
      usedPercent: 105,
      warning: true,
      stopAtBudget: true,
      exhausted: true,
    },
    balance: { known: false, remainingUsd: null, billingUrl: "https://aistudio.google.com/usage" },
    pricingVersion: "2026-11-18",
    dayStart: NOW,
    monthStart: NOW,
  };

  it("lists every paid service, the most expensive first, and the ones without spend", () => {
    expect(serviceSpendLines(spend)).toEqual([
      "OpenAI — $3.00 · 2 çağrı",
      "Gemini — $2.00 · 3 çağrı",
      "ElevenLabs — harcama yok",
    ]);
    expect(serviceLabel("elevenlabs")).toBe("ElevenLabs");
    expect(serviceLabel("yeni-servis")).toBe("yeni-servis");
  });

  it("treats an older API without byProvider as Gemini only", () => {
    const { byProvider: _drop, ...old } = spend;
    expect(serviceTotals(old)).toEqual([{ provider: "gemini", ...spend.month }]);
    expect(serviceSpendLines(old)[0]).toBe("Gemini — $5.25 · 6 çağrı");
  });

  it("counts ElevenLabs in characters", () => {
    expect(modelSpendLine(spend.byModel[2] as AiSpendSummary["byModel"][number])).toBe(
      "eleven_multilingual_v2 — $0.250 · 1 çağrı · 12K karakter",
    );
  });

  it("says the budget is used up only when stop-at-budget stopped the calls", () => {
    expect(exhaustedNote(spend)).toBe(EXHAUSTED_TEXT);
    expect(budgetNotice(spend)).toBe(EXHAUSTED_TEXT);
    const warned = { ...spend, budget: { ...spend.budget, stopAtBudget: false, exhausted: false } };
    expect(exhaustedNote(warned)).toBeNull();
    expect(budgetNotice(warned)).toBe("Aylık bütçenin %80'i aşıldı.");
    const older = { ...spend, budget: { ...spend.budget, exhausted: undefined, warning: false } };
    expect(budgetNotice(older)).toBeNull();
  });

  it("reads the budget field", () => {
    expect(parseBudgetInput("")).toEqual({ ok: true, value: null });
    expect(parseBudgetInput(" 12,5 ")).toEqual({ ok: true, value: 12.5 });
    expect(parseBudgetInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseBudgetInput("-1").ok).toBe(false);
    expect(parseBudgetInput("on dolar").ok).toBe(false);
  });
});

describe("Claude limit (S7)", () => {
  const limit = (over: Partial<ClaudeLimitState> = {}): ClaudeLimitState => ({
    resetsAt: "2026-11-18T14:30:00.000Z",
    mode: "ask",
    decision: null,
    waiting: 3,
    geminiReady: true,
    ...over,
  });

  it("offers Sor (default), Gemini'ye geç and Bekle with one plain line each", () => {
    expect(CLAUDE_LIMIT_OPTIONS.map((o) => o.label)).toEqual(["Sor", "Gemini'ye geç", "Bekle"]);
    expect(CLAUDE_LIMIT_OPTIONS[0]?.value).toBe("ask");
    expect(claudeLimitHints()).toEqual([
      "Sor: iş durur, sana sorulur.",
      "Gemini'ye geç: Gemini ile sürer, notla gösterilir; ücretlidir.",
      "Bekle: sınır sıfırlanınca kendiliğinden devam eder.",
    ]);
    expect(claudeLimitModeWarning("gemini", false)).toContain("Gemini anahtarı yok");
    expect(claudeLimitModeWarning("gemini", true)).toBeNull();
    expect(claudeLimitModeWarning("ask", false)).toBeNull();
  });

  it("says when the limit resets and how much work waits (Istanbul time)", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    expect(claudeLimitLine(limit(), now)).toBe(
      "Claude sınırı doldu · saat 17:30 civarında sıfırlanır · 3 iş bekliyor",
    );
    expect(claudeLimitLine(limit({ waiting: 0 }), now)).toBe(
      "Claude sınırı doldu · saat 17:30 civarında sıfırlanır",
    );
    expect(resetTimeText("2026-11-19T06:00:00.000Z", now)).toBe("Per 09:00 civarında");
  });

  it("knows what happens now: the answer, the preference, or a question", () => {
    expect(claudeLimitChoiceNow(limit())).toBeNull();
    expect(claudeLimitChoiceNow(limit(), "wait")).toBe("wait");
    expect(claudeLimitChoiceNow(limit({ decision: "gemini" }))).toBe("gemini");
    expect(claudeLimitChoiceNow(limit({ mode: "gemini" }))).toBe("gemini");
    expect(claudeLimitChoiceNow(limit({ mode: "gemini", geminiReady: false }))).toBe("wait");
    expect(claudeLimitChoiceNow(limit({ mode: "wait" }))).toBe("wait");
    expect(claudeLimitChoiceText("gemini")).toBe("Gemini ile sürüyor");
    expect(claudeLimitChoiceText("wait")).toBe("Sınır bekleniyor");
  });

  it("asks: Gemini ile devam et / Sınırı bekle; Gemini needs a key", async () => {
    const onDecide = vi.fn();
    const { rerender } = render(
      <ClaudeLimitActions geminiReady busy={null} error={null} onDecide={onDecide} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Gemini ile devam et" }));
    await userEvent.click(screen.getByRole("button", { name: "Sınırı bekle" }));
    expect(onDecide.mock.calls).toEqual([["gemini"], ["wait"]]);

    rerender(
      <ClaudeLimitActions geminiReady={false} busy={null} error={null} onDecide={onDecide} />,
    );
    const gemini = screen.getByRole("button", { name: "Gemini ile devam et" });
    expect(gemini).toBeDisabled();
    expect(gemini).toHaveAttribute("title", "Gemini anahtarı yok");
    expect(screen.getByText("Gemini anahtarı yok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sınırı bekle" })).toBeEnabled();
  });
});
