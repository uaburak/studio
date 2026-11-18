import type { AiProviderStatus, AiSpendSummary, WorkerPresence } from "@studio/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { modelMenu } from "../../src/renderer/components/chat/status-line.tsx";
import { Menu } from "../../src/renderer/components/ui/menu.tsx";
import {
  keyStateText,
  modelSpendLines,
} from "../../src/renderer/features/settings/sections/ai.tsx";
import { providerStatusLines } from "../../src/renderer/features/settings/status-text.ts";
import { modelUnavailableReason } from "../../src/renderer/lib/models.ts";
import {
  budgetLine,
  formatUsd,
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

describe("Gemini spend wording", () => {
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
