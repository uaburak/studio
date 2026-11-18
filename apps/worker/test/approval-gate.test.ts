// The approval gate (E7) in the chat: the API refuses an approval while the version's checks hold
// it back. The agent never approves past them on its own: `approve_content` and `publish_now`
// show the blocking checks on a consent card of their own and send `acknowledgeChecks: true`
// only when the owner allows it; otherwise the checks come back to the model in Turkish and
// nothing is approved or published.
import type { Content, SocialAccount } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { createFakeApi, NOW } from "./fake-api.ts";

const HASH = "a".repeat(64);
const GATE = {
  message:
    "v1 için 2 kontrol geçmedi: Kontrast, Taşma. Sonuçlara bakıp yine de onaylamak istediğinizi belirtin.",
  issues: [
    { path: "checks.layout.contrast", message: "Kontrast: başlık zeminde okunmuyor" },
    { path: "checks.layout.overflow", message: "Taşma: gövde metni kutudan taşıyor" },
  ],
};

function setup(answers: boolean[]) {
  const content: Content = {
    id: "cnt_1",
    brandId: "brand_1",
    type: "post",
    title: "Bahar",
    brief: "Tarla",
    status: "in_review",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: { id: "ver_1", version: 1, contentHash: HASH },
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const account: SocialAccount = {
    id: "acc_ig",
    brandId: "brand_1",
    platform: "instagram",
    handle: "@bahar",
    externalId: "17841",
    status: "connected",
    createdAt: NOW,
    updatedAt: NOW,
  } as SocialAccount;
  const { api, state } = createFakeApi({
    contents: new Map([["cnt_1", content]]),
    socialAccounts: [account],
  });
  state.approvalGate = GATE;
  // The owner answers the cards in order (true: Allow, false: Deny).
  const queue = [...answers];
  const timer = setInterval(() => {
    for (const p of state.parts) {
      if (p.type === "consent" && p.state === "pending" && queue.length) {
        state.decideConsent(p.consentId, queue.shift() as boolean);
      }
    }
  }, 5);
  const signal = new AbortController().signal;
  const writer = new TurnWriter({ api, runId: "run_1", attempt: 1, signal, flushIntervalMs: 5 });
  const ex = new StudioToolExecutor({
    api,
    writer,
    runId: "run_1",
    conversationId: "conv_1",
    initialBrandId: "brand_1",
    initialOpenPlan: null,
    aliases: [],
    signal,
    consentPollIntervalMs: 5,
    consentTimeoutMs: 10_000,
  });
  return { ex, state, writer, stop: () => clearInterval(timer) };
}

const consents = (state: ReturnType<typeof createFakeApi>["state"]) =>
  state.parts.filter((p) => p.type === "consent");

describe("approve_content and the checks gate", () => {
  it("shows the blocking checks on a second card and approves only when the owner allows it", async () => {
    const { ex, state, writer, stop } = setup([true, true]);
    try {
      const res = await ex.execute("approve_content", { contentId: "cnt_1" });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        allowed: true,
        ok: true,
        approvedDespiteChecks: { message: GATE.message, issues: GATE.issues.map((i) => i.message) },
      });
      expect(state.contentApprovals).toEqual([
        { id: "cnt_1", hash: HASH, acknowledgeChecks: true },
      ]);
      await writer.flush();
      const cards = consents(state);
      expect(cards).toHaveLength(2);
      expect(cards[1]).toMatchObject({
        tool: "approve_content",
        title: "Kontroller geçmedi: yine de onaylansın mı?",
        state: "allowed",
      });
      const detail = cards[1]?.type === "consent" ? (cards[1].detail ?? "") : "";
      expect(detail).toContain("2 kontrol geçmedi");
      expect(detail).toContain("• Kontrast: başlık zeminde okunmuyor");
      expect(detail).toContain("• Taşma: gövde metni kutudan taşıyor");
    } finally {
      stop();
    }
  });

  it("returns the blocking checks to the model when the owner does not approve past them", async () => {
    const { ex, state, stop } = setup([true, false]);
    try {
      const res = await ex.execute("approve_content", { contentId: "cnt_1" });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        allowed: false,
        ok: false,
        approved: false,
        reason: "denied_by_owner",
        checks: {
          message: GATE.message,
          issues: ["Kontrast: başlık zeminde okunmuyor", "Taşma: gövde metni kutudan taşıyor"],
        },
      });
      expect(String(res.data.note)).toMatch(/onaylanmadı/);
      expect(state.contentApprovals).toEqual([]);
    } finally {
      stop();
    }
  });

  it("approves at once when the checks do not hold it back (no second card)", async () => {
    const { ex, state, writer, stop } = setup([true]);
    state.approvalGate = null;
    try {
      const res = await ex.execute("approve_content", { contentId: "cnt_1" });
      expect(res.data).toMatchObject({ allowed: true, ok: true });
      expect(res.data).not.toHaveProperty("approvedDespiteChecks");
      expect(state.contentApprovals).toEqual([{ id: "cnt_1", hash: HASH }]);
      await writer.flush();
      expect(consents(state)).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("publish_now and the checks gate", () => {
  it("publishes nothing when the owner keeps the checks' refusal", async () => {
    const { ex, state, stop } = setup([true, false]);
    try {
      const res = await ex.execute("publish_now", {
        contentId: "cnt_1",
        socialAccountId: "acc_ig",
      });
      expect(res.data).toMatchObject({ approved: false, reason: "denied_by_owner" });
      expect(state.contentApprovals).toEqual([]);
      expect(state.schedules).toEqual([]);
      expect(state.jobs.filter((j) => j.type === "schedule.publish")).toEqual([]);
    } finally {
      stop();
    }
  });

  it("approves past the checks only after the owner's second yes, then publishes", async () => {
    const { ex, state, stop } = setup([true, true]);
    try {
      const res = await ex.execute("publish_now", {
        contentId: "cnt_1",
        socialAccountId: "acc_ig",
      });
      expect(res.data).toMatchObject({ allowed: true, ok: true });
      expect(state.contentApprovals).toEqual([
        { id: "cnt_1", hash: HASH, acknowledgeChecks: true },
      ]);
      expect(state.jobs.filter((j) => j.type === "schedule.publish")).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
