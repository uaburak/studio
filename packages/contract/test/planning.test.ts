import { describe, expect, it } from "vitest";
import {
  BrandPlanningSettingsPut,
  briefWithHook,
  effectiveSectorTags,
  historyWindow,
  hookOf,
  istanbulToday,
  looksLikePlanning,
  normalizeTurkish,
  PlanItem,
  type PlanningHistoryEntry,
  planItemSimilarities,
  planningPeriodFromText,
  SpecialDayOverridesPut,
  SpecialDaysQuery,
  similarLabel,
  suggestSectorTags,
  textSimilarity,
  topicWords,
} from "../src/index.ts";

function entry(over: Partial<PlanningHistoryEntry> & { title: string }): PlanningHistoryEntry {
  return {
    kind: "post",
    contentId: "c-1",
    planId: null,
    planItemId: null,
    date: "2026-10-12",
    hook: null,
    brief: null,
    pillar: null,
    contentType: "post",
    status: "published",
    reason: null,
    ...over,
  };
}

describe("Turkish text", () => {
  it("normalises case, letters and noise", () => {
    expect(normalizeTurkish("KIŞA Hazırlık: Çiftçi #gübre İĞDIR 🌱 https://x.y")).toBe(
      "kisa hazirlik ciftci igdir",
    );
    expect(topicWords("Bu kış için 3 ipucu ve bir post")).toEqual(["kis", "ipucu"]);
  });

  it("takes the caption's first meaningful line as the hook", () => {
    expect(hookOf("🌾 #hasat\nToprağın kışa hazır mı? 👀\nDevamı…")).toBe(
      "Toprağın kışa hazır mı?",
    );
    expect(hookOf("")).toBeNull();
    expect(hookOf("#a #b\n@marka")).toBeNull();
    expect(hookOf("x".repeat(300))?.length).toBe(158);
  });

  it("adds the planned hook to the generation brief once", () => {
    expect(briefWithHook("Kış bakımı.", "Bahçen kışa hazır mı?")).toBe(
      "Kış bakımı.\n\nAçılış cümlesi (kanca): Bahçen kışa hazır mı?",
    );
    expect(briefWithHook("Bahçen kışa hazır mı? diye sor.", "Bahçen kışa hazır mı?")).toBe(
      "Bahçen kışa hazır mı? diye sor.",
    );
    expect(briefWithHook("Kış bakımı.", null)).toBe("Kış bakımı.");
  });
});

describe("near-duplicates", () => {
  it("catches the same topic despite Turkish suffixes", () => {
    expect(
      textSimilarity(
        { title: "Kışa hazırlık: toprak analizi" },
        { title: "Kış öncesi toprak analizi" },
      ),
    ).toMatchObject({ field: "title" });
    expect(
      textSimilarity(
        { title: "Domateste yaprak yanıklığı", hook: "Yaprakların sararıyor mu?" },
        { title: "Domates hastalıkları", hook: "Domates yaprakların sararıyor mu?" },
      ),
    ).toMatchObject({ field: "hook" });
  });

  it("compares briefs only for their message", () => {
    const style = "Sade, tipografik bir tasarım; marka renkleri. Çağrı: profildeki bağlantı.";
    expect(
      textSimilarity(
        { title: "Zeytin hasadı başladı", brief: `Hasat dönemi ve zeytinin kalitesi. ${style}` },
        { title: "Sera ısıtma ipuçları", brief: `Kışın serada ısıyı korumanın yolları. ${style}` },
      ),
    ).toBeNull();
    expect(
      textSimilarity(
        {
          title: "Kış hazırlığı",
          brief: "Kış gelmeden önce toprağın analiz edilmesi ve gübre planı.",
        },
        {
          title: "Soğuklar gelmeden",
          brief: "Kış gelmeden toprak analizi yaptır, gübre planını ona göre kur.",
        },
      ),
    ).toMatchObject({ field: "topic" });
    // Same series, another crop: the titles flag it, the messages alone would not.
    const tomato = { title: "Domates fidesi dikimi", brief: "Fideleri doğru derinlikte dikmek." };
    const pepper = { title: "Biber fidesi dikimi", brief: "Biber fidelerini dikerken dikkat." };
    expect(textSimilarity(tomato, pepper)).toMatchObject({ field: "title" });
    expect(
      textSimilarity({ ...tomato, title: "Domates" }, { ...pepper, title: "Biber" }),
    ).toBeNull();
  });

  it("lets different topics pass", () => {
    expect(
      textSimilarity(
        { title: "Kışa hazırlık: toprak analizi" },
        { title: "Damla sulama ile su tasarrufu" },
      ),
    ).toBeNull();
    expect(
      textSimilarity({ title: "Anneler Günü kutlaması" }, { title: "Öğretmenler Günü kutlaması" }),
    ).toBeNull();
  });

  it("ignores the brand's everyday words", () => {
    const history = [
      "MTM Agro ile toprak analizi",
      "MTM Agro gübre önerileri",
      "MTM Agro hasat sonrası bakım",
      "MTM Agro fide dikimi",
      "MTM Agro damla sulama",
      "MTM Agro sera ısıtma",
      "MTM Agro budama rehberi",
    ].map((title, i) => entry({ title, contentId: `c-${i}` }));
    const [marks] = planItemSimilarities([{ title: "MTM Agro zeytin hasadı" }], history);
    expect(marks).toEqual([]);
    const [repeat] = planItemSimilarities([{ title: "MTM Agro budama rehberi 2" }], history);
    expect(repeat?.[0]).toMatchObject({ kind: "post", contentId: "c-6", field: "title" });
  });

  it("marks history and earlier items of the same plan, best first", () => {
    const history = [
      entry({
        title: "Kış öncesi toprak analizi",
        hook: "Toprağın kışa hazır mı?",
        contentId: "post-1",
        date: "2026-10-12",
      }),
      entry({
        kind: "rejected",
        title: "Black Friday indirim duyurusu",
        contentId: null,
        planItemId: "old-item",
        date: null,
        reason: "kampanya yok",
      }),
    ];
    const marks = planItemSimilarities(
      [
        { id: "i1", title: "Kışa hazırlık: toprak analizi", date: "2026-12-03" },
        { id: "i2", title: "Black Friday indirim duyurusu!", date: "2026-11-27" },
        { id: "i3", title: "Yeni yıl mesajı", date: "2026-12-31" },
        { id: "i4", title: "Yeni yıl mesajımız", date: "2026-12-30" },
      ],
      history,
    );
    expect(marks[0]?.[0]).toMatchObject({ kind: "post", contentId: "post-1", date: "2026-10-12" });
    // A rejected plan never happened: its items are not history.
    expect(marks[1]).toEqual([]);
    expect(marks[2]).toEqual([]);
    expect(marks[3]?.[0]).toMatchObject({ kind: "same_plan", planItemId: "i3" });
  });

  it("counts only real posts as history", () => {
    const same = { title: "Bu haftanın şarkısı: Halil Sezai – Olsun", hook: "Olsun'u çalalım" };
    const history = (["rejected", "skipped", "planned", "deleted"] as const).map((kind, i) =>
      entry({ kind, ...same, contentId: null, planItemId: `old-${i}` }),
    );
    expect(planItemSimilarities([same], history)).toEqual([[]]);
    const [marks] = planItemSimilarities([same], [...history, entry({ ...same })]);
    expect(marks).toHaveLength(1);
    expect(marks?.[0]).toMatchObject({ kind: "post", contentId: "c-1" });
  });

  it("does not mark a plan's items for its series names, pillars and numbering", () => {
    // The real case: a 32-item plan of a guitar school where every item was marked.
    const titles = [
      "01 · Bu haftanın şarkısı · Sezen Aksu – Gülümse",
      "02 · Teknik · Barre akoru nasıl basılır",
      "03 · Bu haftanın şarkısı · Halil Sezai – Olsun",
      "04 · Topluluk · Kendi şarkını ekle",
      "05 · Teknik · Ritim kalıpları: 4/4 tutuş",
      "06 · Bu haftanın şarkısı · Teoman – İstanbul'da Sonbahar",
      "07 · Topluluk · Ayın gitaristi: Sizden gelen videolar",
      "08 · Gituar'da yeni: şarkı listesi güncellendi",
      "09 · Teknik · Parmak egzersizleri ile hız",
      "10 · Bu haftanın şarkısı · Barış Manço – Gülpembe",
      "11 · Topluluk · En sevdiğin şarkıyı yorumla",
      "12 · Gituar ipucu · Tel değiştirme rehberi",
    ];
    const items = titles.map((title, i) => ({
      id: `i${i + 1}`,
      title,
      pillar: title.includes("Teknik") ? "Teknik" : "Topluluk",
      hook: `${title.split("·").pop()?.trim()} için hazır mısın?`,
      brief: "Gituar topluluğu için şarkı ve gitar odaklı, sıcak bir paylaşım.",
      date: `2026-11-${String(i + 1).padStart(2, "0")}`,
    }));
    const marks = planItemSimilarities(items, []);
    expect(marks.map((m) => m.length)).toEqual(titles.map(() => 0));
    // Two episodes of the series, without the rest of the plan around them.
    expect(
      planItemSimilarities(
        [
          { title: "Bu haftanın şarkısı · Halil Sezai – Olsun" },
          { title: "Bu haftanın şarkısı · Sezen Aksu – Gülümse" },
        ],
        [],
      ),
    ).toEqual([[], []]);
    // The Olsun item against "Kendi şarkını ekle", by title, hook and brief.
    expect(
      textSimilarity(
        {
          title: "03 · Bu haftanın şarkısı · Halil Sezai – Olsun",
          hook: "Bu haftanın şarkısı: Olsun",
          brief: "Gituar'da bu haftanın şarkısı Olsun; akorlarıyla birlikte.",
        },
        {
          title: "04 · Topluluk · Kendi şarkını ekle",
          hook: "Sen de kendi şarkını ekle",
          brief: "Gituar'da kendi şarkını ekleyebilirsin; akorlarıyla birlikte.",
        },
        { withTopic: false },
      ),
    ).toBeNull();
  });

  it("still marks a real near-duplicate in the same plan and in the history", () => {
    const marks = planItemSimilarities(
      [
        { id: "a", title: "03 · Bu haftanın şarkısı · Halil Sezai – Olsun" },
        { id: "b", title: "07 · Teknik · Barre akoru nasıl basılır", pillar: "Teknik" },
        { id: "c", title: "11 · Bu haftanın şarkısı · Halil Sezai – Olsun (akustik)" },
      ],
      [entry({ title: "Barre akoruna nasıl basılır?", contentId: "c-9" })],
    );
    expect(marks[0]).toEqual([]);
    expect(marks[2]?.[0]).toMatchObject({ kind: "same_plan", planItemId: "a", field: "title" });
    expect(marks[2]?.[0]?.score).toBeGreaterThanOrEqual(0.6);
    expect(marks[1]?.[0]).toMatchObject({ kind: "post", contentId: "c-9" });
  });

  it("skips the plan's own items in the history", () => {
    const history = [
      entry({ kind: "planned", title: "Kış öncesi toprak analizi", planItemId: "i1" }),
    ];
    const [marks] = planItemSimilarities(
      [{ id: "i1", title: "Kış öncesi toprak analizi" }],
      history,
    );
    expect(marks).toEqual([]);
  });

  it("labels marks in plain Turkish", () => {
    expect(similarLabel({ kind: "post", title: "x", date: "2026-10-12" })).toBe("12 Ekim postu");
    expect(similarLabel({ kind: "rejected", title: "Black Friday", date: null })).toBe(
      "reddedilen “Black Friday”",
    );
    expect(similarLabel({ kind: "same_plan", title: "Yılbaşı", date: "2026-12-31" })).toBe(
      "bu plandaki 31 Aralık postu",
    );
  });

  it("reads plan items from older servers without the new fields", () => {
    const item = PlanItem.parse({
      id: "i",
      planId: "p",
      position: 0,
      date: null,
      platforms: ["instagram"],
      contentType: "post",
      title: "t",
      brief: "",
      pillar: null,
      imageSlot: "none",
      imageBrief: null,
      status: "planned",
      contentId: null,
      generation: null,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    });
    expect(item.hook).toBeNull();
    expect(item.similar).toEqual([]);
  });
});

describe("planning turns", () => {
  it("knows today in Türkiye", () => {
    expect(istanbulToday(new Date("2026-11-19T22:30:00Z"))).toBe("2026-11-20");
    expect(istanbulToday(new Date("2026-11-19T20:30:00Z"))).toBe("2026-11-19");
  });

  it("recognises planning messages", () => {
    expect(looksLikePlanning("Aralık planını hazırla")).toBe(true);
    expect(looksLikePlanning("/aylik-plan")).toBe(true);
    expect(looksLikePlanning("ocak için 10 post öner")).toBe(true);
    expect(looksLikePlanning("Bu postun rengini değiştir")).toBe(false);
  });

  it("finds the period a message means", () => {
    const today = "2026-11-19";
    expect(planningPeriodFromText("Aralık planı", today)).toEqual({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
    });
    expect(planningPeriodFromText("ocakta neler paylaşalım, plan yap", today)).toEqual({
      periodStart: "2027-01-01",
      periodEnd: "2027-01-31",
    });
    expect(planningPeriodFromText("aralık ve ocak planı", today)).toEqual({
      periodStart: "2026-12-01",
      periodEnd: "2027-01-31",
    });
    expect(planningPeriodFromText("bu ayın planı", today)).toEqual({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
    });
    expect(planningPeriodFromText("önümüzdeki iki hafta için plan", today)).toEqual({
      periodStart: "2026-11-20",
      periodEnd: "2026-12-03",
    });
    expect(planningPeriodFromText("plan yap", today)).toEqual({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
    });
    expect(planningPeriodFromText("mart 2028 planı", today).periodStart).toBe("2028-03-01");
  });

  it("looks three months back for history", () => {
    expect(historyWindow("2026-12-01", "2026-12-31")).toEqual({
      from: "2026-09-01",
      to: "2026-12-31",
    });
    expect(historyWindow("2027-02-01", "2027-02-28").from).toBe("2026-11-01");
  });
});

describe("settings", () => {
  it("guesses sector tags from the brand", () => {
    expect(
      suggestSectorTags({
        strong: ["MTM Agro", "Organik gübre", "Sıvı gübreler"],
        weak: ["Çiftçilere toprak verimi için çözümler sunar."],
      }),
    ).toEqual(["tarim"]);
    expect(
      suggestSectorTags({ strong: ["Kahve Durağı"], weak: ["Taze kahve ve tatlılar"] }),
    ).toEqual(["gida"]);
    expect(suggestSectorTags({ strong: ["Studio"], weak: ["Sade ve net bir dil."] })).toEqual([]);
  });

  it("uses the suggestion until the owner saves tags", () => {
    const base = { sectorTags: [], suggestedTags: ["tarim" as const] };
    expect(effectiveSectorTags({ ...base, updatedAt: null })).toEqual(["tarim"]);
    expect(effectiveSectorTags({ ...base, updatedAt: "2026-11-19T00:00:00.000Z" })).toEqual([]);
  });

  it("validates inputs", () => {
    expect(BrandPlanningSettingsPut.safeParse({ sectorTags: ["tarim", "tarim"] }).success).toBe(
      false,
    );
    expect(BrandPlanningSettingsPut.parse({})).toEqual({ sectorTags: [], disabledCategories: [] });
    expect(
      SpecialDayOverridesPut.safeParse({
        overrides: [{ year: 2031, ramazanBayrami: "2032-01-14" }],
      }).success,
    ).toBe(false);
    expect(SpecialDaysQuery.safeParse({ from: "2026-01-01", to: "2027-06-01" }).success).toBe(
      false,
    );
  });
});
