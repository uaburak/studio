// Accepting a plan never has to start generation: `accept_and_generate_plan` takes
// `generate: false`, and a plan whose posts the user brings ready-made (`generate: false` on
// every item) is accepted without generation unless the agent asks for it.
import type { Plan, PlanItem } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { convertPlan } from "../src/chat/schema.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { createFakeApi, NOW } from "./fake-api.ts";

function item(position: number, generate?: boolean): PlanItem {
  return {
    id: `item_${position}`,
    planId: "plan_1",
    position,
    date: `2026-12-${String(position + 1).padStart(2, "0")}`,
    platforms: ["instagram"],
    contentType: "post",
    title: `Post ${position + 1}`,
    brief: "Hazır görsel ve metin yüklenecek; üretim yok.",
    pillar: null,
    hook: null,
    imageSlot: "none",
    imageBrief: null,
    productIds: [],
    imageView: null,
    ...(generate === undefined ? {} : { generate }),
    status: "planned",
    similar: [],
    contentId: null,
    generation: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function plan(items: PlanItem[]): Plan {
  return {
    id: "plan_1",
    brandId: "brand_1",
    conversationId: "conv_1",
    runId: "run_1",
    title: "Seri",
    periodStart: "2026-12-01",
    periodEnd: "2026-12-31",
    status: "proposed",
    summary: "",
    revision: 1,
    decidedAt: null,
    rejectionReason: null,
    items,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function setup(open: Plan) {
  const { api, state } = createFakeApi({ storedPlans: new Map([[open.id, open]]) });
  // The owner allows every card.
  const timer = setInterval(() => {
    for (const p of state.parts) {
      if (p.type === "consent" && p.state === "pending") state.decideConsent(p.consentId, true);
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
    initialOpenPlan: open,
    aliases: [],
    signal,
    consentPollIntervalMs: 5,
    consentTimeoutMs: 10_000,
  });
  return { ex, state, stop: () => clearInterval(timer) };
}

const consentTitles = (state: ReturnType<typeof createFakeApi>["state"]) =>
  state.parts.flatMap((p) => (p.type === "consent" ? [p.title] : []));

describe("propose_plan marks ready-made posts", () => {
  it("carries generate: false into the saved plan, and nothing for designed items", () => {
    const { plan: put } = convertPlan(
      {
        title: "Seri",
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
        summary: "",
        items: [
          {
            platforms: ["instagram"],
            contentType: "post",
            title: "Hazır",
            brief: "Hazır görsel ve metin yüklenecek.",
            imageSlot: "none",
            imageAliases: [],
            generate: false,
          },
          {
            platforms: ["instagram"],
            contentType: "post",
            title: "Tasarla",
            brief: "Tipografik post.",
            imageSlot: "none",
            imageAliases: [],
          },
        ],
      },
      { aliases: [] },
    );
    expect(put.items.map((i) => i.generate)).toEqual([false, undefined]);
  });
});

describe("accept_and_generate_plan without generation", () => {
  it("accepts a plan of ready-made posts without generating by default", async () => {
    const { ex, state, stop } = setup(plan([item(0, false), item(1, false)]));
    try {
      const res = await ex.execute("accept_and_generate_plan", {});
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({ allowed: true, ok: true, generated: false, queuedJobs: 0 });
      expect(state.planAccepts).toHaveLength(1);
      expect(state.planGenerates).toEqual([]);
      expect(consentTitles(state)).toEqual(["Planı onayla (üretim başlamaz)"]);
    } finally {
      stop();
    }
  });

  it("accepts only when the agent says generate: false", async () => {
    const { ex, state, stop } = setup(plan([item(0), item(1)]));
    try {
      const res = await ex.execute("accept_and_generate_plan", { generate: false });
      expect(res.isError).toBe(false);
      expect(state.planAccepts).toHaveLength(1);
      expect(state.planGenerates).toEqual([]);
    } finally {
      stop();
    }
  });

  it("still generates a plan Studio designs, and counts only those posts", async () => {
    const { ex, state, stop } = setup(plan([item(0), item(1, false)]));
    try {
      const res = await ex.execute("accept_and_generate_plan", {});
      expect(res.isError).toBe(false);
      expect(state.planAccepts).toHaveLength(1);
      expect(state.planGenerates).toHaveLength(1);
      // No itemIds: the API leaves the hand-made item alone.
      expect(state.planGenerates[0]?.input.itemIds).toBeUndefined();
      const detail = state.parts.flatMap((p) => (p.type === "consent" ? [p.detail ?? ""] : []));
      expect(detail[0]).toContain("1 post için tasarım üretimi");
      expect(consentTitles(state)).toEqual(["Planı onayla ve post üretimini başlat"]);
    } finally {
      stop();
    }
  });
});
