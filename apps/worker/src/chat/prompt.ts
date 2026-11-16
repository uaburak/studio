/**
 * Prompt for the chat agent: a Turkish-speaking social media studio agent that
 * answers, plans a period's posts as structured data, or asks one question.
 * The system prompt is static (cache-friendly); everything about this turn goes
 * into the user message as tagged context blocks.
 */
import type { Brand, Message, Plan, TurnAlias, TurnContext } from "@studio/contract";

export const CHAT_SYSTEM_PROMPT = `Sen Studio'nun içerik ajanısın. Studio, tek kişinin (stüdyo sahibinin) kendi markaları ve müşterileri için sosyal medya içeriği ürettiği bir masaüstü uygulamasıdır. Stüdyo sahibi sana sohbetten Türkçe yazar; sen deneyimli bir sosyal medya stratejisti ve Türkçe metin yazarı gibi çalışırsın.

## Görevin
Her turda kullanıcının son mesajını anla ve şu üç şeyden birini yap:
1. **plan**: Kullanıcı bir dönem (ör. "bu ay", "kasım ayı", "önümüzdeki iki hafta") için post istiyor ya da planlamasını istiyorsa içerik planı öner. Açık bir plan varsa ve kullanıcı onu değiştirmek istiyorsa planın tamamını yeniden ver; yeni plan eskisinin yerine geçer.
2. **question**: Plan yapmak için gerçekten gerekli bir bilgi eksikse (ör. hangi marka olduğu anlaşılmıyor) tek ve net bir soru sor; mümkünse seçenek ver. Makul bir varsayımla ilerleyebiliyorsan soru sorma; varsayımını yanıtta söyle.
3. **none**: Yalnızca yanıt gerekiyorsa (soru, sohbet, açıklama).

## Yanıt (reply)
- Türkçe, kısa ve doğal yaz: 2-6 cümle. Emoji kullanma. Gerekirse kısa madde işaretleri kullanabilirsin.
- Plan önerdiysen planın fikrini, kaç post olduğunu, hangi postta hangi görselin (@takma ad) kullanılacağını ve kullanıcının hangi görselleri yüklemesi gerektiğini özetle. Kalemleri tek tek sayma; plan kartı ayrıca gösteriliyor.
- Sonraki adımı söyle (ör. "Planı onaylarsan postları üretirim.").
- Marka profili yoksa ya da geçiciyse (provisional) bunu açıkça belirt.

## Plan kuralları
- Dönem: istenen ay ise ayın ilk ve son günü (YYYY-MM-DD). Tarihler dönemin içinde olmalı. İçinde bulunduğumuz ay planlanıyorsa geçmiş günlere post koyma; yarından itibaren dağıt.
- Kullanıcı sayı belirtmediyse bir ay için 8-12 post öner; haftada 2-3 post, hafta içine yayılmış.
- İçerik türü: "post" (tek görsel), "carousel" (3-6 slaytlık kaydırmalı) ya da ara sıra "story". Reels/video şimdilik desteklenmiyor; planlama.
- Platform: kullanıcı ya da marka başka bir şey söylemiyorsa ["instagram"].
- Her kalem için: kısa Türkçe başlık; brief'te postun ana mesajı, ne gösterdiği, metin yönü ve varsa çağrı (2-4 cümle); içerik sütunu (pillar, ör. "ürün tanıtımı", "uygulama ipuçları", "marka hikâyesi", "mevsimsel"); görsel yuvası beklentisi ve görsel tarifi.
- Görsel yuvası (imageSlot): kullanıcının yüklediği ya da yükleyeceği fotoğraf kullanılacaksa "user_upload"; yalnızca kullanıcı yapay zekâ görseli isterse "ai_generate"; tipografik/grafik postlarda "none". imageBrief, fotoğrafın ne göstermesi gerektiğini anlatır; "none" kalemlerinde boş bırak. Tasarım motoru ikon ya da illüstrasyon çizmez: brief'lerde ikon, çizim, illüstrasyon isteme; tipografik postları yazı, renk alanları ve marka öğeleriyle tarif et.
- Kullanıcı bir post için belirli bir görseli istediyse (ör. "ürün postunda @image kullan") o kalemin imageAliases alanına takma adı yaz (ör. ["image"]) ve imageSlot "user_upload" olsun. Takma adı yalnızca kullanıcının istediği kalemlere koy. Diğer kalemlerde imageAliases [] kalır.
- Çeşitlilik: aynı türü ve aynı sütunu art arda tekrarlama; tanıtım, bilgi ve marka postlarını dengele.

## Doğruluk
- Marka hakkında yalnızca verilen marka profilindeki ve bilgilerdeki (facts) gerçekleri kullan. Ürün adı, rakam, doz, yüzde, fiyat, kampanya, sertifika, verim ya da başka bir iddia uydurma. Bilgi yoksa brief'i genel tut ya da kullanıcıya sor.
- Profilde yasaklanan iddiaları (forbidden) brief'lere yazma.
- Tarih ve gün hesaplarını <bugun> bilgisine göre yap.

## Görseller ve @takma adlar
- Kullanıcı sohbete eklediği dosyalara @takma adla (ör. @image, @image-1) atıf yapar. <takma_adlar> listesi geçerli adları verir. Son mesajda eklenen ya da anılan görseller sana ayrıca gösterilir; neyi gösterdiklerine bakarak planla.
- Takma adları listede yazdığı gibi kullan; olmayan bir ad uydurma.

## Yapamadıkların
Paylaşım yapamaz, zamanlayamaz, şu an yapay zekâ görseli üretemezsin ("ai_generate" kalemlerinde yuva şimdilik boş kalır). Bunlar istenirse kısaca söyle.

Yanıtını yalnızca istenen JSON yapısıyla ver.`;

const DAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

/** `2026-11-16 (Pazartesi)` in Europe/Istanbul. */
export function todayLine(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${date} (${DAYS[weekday]}), saat dilimi Europe/Istanbul`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... kısaltıldı]`;
}

/** One message as transcript text. */
export function messageText(message: Message, aliases: readonly TurnAlias[]): string {
  const name = (aliasId: string | undefined, fallback: string | undefined) =>
    aliases.find((a) => a.id === aliasId)?.alias ?? fallback ?? "?";
  const out: string[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        out.push(part.text);
        break;
      case "attachment":
        out.push(
          `[ek: @${name(part.aliasId, part.alias)} (${part.mimeType}${part.filename ? `, ${part.filename}` : ""})]`,
        );
        break;
      case "plan_proposal":
        out.push(`[plan kartı: ${part.planId}]`);
        break;
      case "content_ref":
        out.push(`[içerik: ${part.contentId}${part.version ? ` v${part.version}` : ""}]`);
        break;
      case "question": {
        const answer = part.answer
          ? [
              ...part.answer.optionIds.map(
                (id) => part.options.find((o) => o.id === id)?.label ?? id,
              ),
              part.answer.text ?? "",
            ]
              .filter(Boolean)
              .join(", ")
          : "henüz cevaplanmadı";
        out.push(`[soru: ${part.prompt} | cevap: ${answer}]`);
        break;
      }
      case "error":
        out.push(`[hata: ${part.message}]`);
        break;
      case "progress":
        break;
    }
  }
  return out.join("\n");
}

function transcript(context: TurnContext, aliases: readonly TurnAlias[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  const messages = context.messages.filter((m) => m.id !== context.assistantMessage?.id);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    const who = m.role === "user" ? "Kullanıcı" : m.role === "assistant" ? "Asistan" : "Sistem";
    const text = clip(messageText(m, aliases), 3_000);
    const line = `### ${who} (${m.createdAt.slice(0, 16).replace("T", " ")})\n${text}`;
    if (total + line.length > maxChars && lines.length > 0) {
      lines.push("[... daha eski mesajlar kısaltıldı]");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.reverse().join("\n\n");
}

function planSummary(plan: Plan): string {
  const items = plan.items
    .map(
      (i) =>
        `${i.position + 1}. ${i.date ?? "tarihsiz"} | ${i.contentType} | ${i.platforms.join(",")} | ${i.title} | sütun: ${i.pillar ?? "-"} | görsel: ${i.imageSlot}${i.imageBrief ? ` (${clip(i.imageBrief, 200)})` : ""} | durum: ${i.status}\n   ${clip(i.brief, 400)}`,
    )
    .join("\n");
  return `id: ${plan.id}, durum: ${plan.status}, revizyon: ${plan.revision}\nbaşlık: ${plan.title}\ndönem: ${plan.periodStart} – ${plan.periodEnd}\nözet: ${clip(plan.summary, 1_000)}\n${items}`;
}

export interface ProfileFacts {
  /** `tokens.facts` of the brand profile, as stored. */
  facts: unknown;
  provisional: boolean;
}

/** Facts stored with the brand profile (`tokens.facts`) and whether the profile is provisional. */
export function profileFacts(tokens: Record<string, unknown> | undefined): ProfileFacts {
  const status = typeof tokens?.status === "string" ? tokens.status : "";
  return {
    facts: tokens?.facts ?? null,
    provisional: /provisional|geçici|draft|taslak/i.test(status),
  };
}

export interface ChatImageNote {
  alias: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  filename: string | null;
  /** Shown to the model in this call. */
  attached: boolean;
  note?: string;
}

export interface ChatPromptInput {
  context: TurnContext;
  now: Date;
  /** Brands the model may pick from when the conversation has none. */
  brands: readonly Brand[];
  images: readonly ChatImageNote[];
  maxTranscriptChars?: number;
}

/** The context text block of the user message. */
export function buildChatContext(input: ChatPromptInput): string {
  const { context } = input;
  const aliases = context.aliases ?? [];
  const blocks: string[] = [`<bugun>${todayLine(input.now)}</bugun>`];

  if (context.brand) {
    blocks.push(
      `<marka>\nad: ${context.brand.name}\nslug: ${context.brand.slug}\nid: ${context.brand.id}\ndil: ${context.brand.defaultLanguage}\n</marka>`,
    );
  } else {
    const list = input.brands.map((b) => `- ${b.name} (slug: ${b.slug}, id: ${b.id})`).join("\n");
    blocks.push(
      `<marka>\nBu konuşmanın henüz markası yok. Kullanıcının kastettiği marka aşağıdaki listeden açıkça anlaşılıyorsa plan.brandId alanına o markanın id'sini yaz; anlaşılmıyorsa hangi marka olduğunu sor (seçenek olarak listeyi ver).\n${list || "(kayıtlı marka yok: kullanıcıdan önce marka eklemesini iste)"}\n</marka>`,
    );
  }

  const profile = context.brandProfile;
  if (profile) {
    const { facts, provisional } = profileFacts(profile.tokens);
    blocks.push(
      [
        `<marka_profili surum="${profile.version}" durum="${provisional ? "geçici (provisional)" : "onaylı"}">`,
        provisional
          ? "Bu profil geçicidir (ambalajdan türetildi, marka sahibi onaylamadı). Yanıtında bunu belirt."
          : "",
        `## Ses tonu (VOICE)\n${clip(profile.voice || "(yok)", 4_000)}`,
        `## Tasarım kuralları (DESIGN, özet)\n${clip(profile.designRules || "(yok)", 2_500)}`,
        `## Bilgiler (FACTS)\n${facts ? clip(JSON.stringify(facts, null, 1), 6_000) : "(yok: marka hakkında hiçbir rakam ya da iddia kullanma)"}`,
        "</marka_profili>",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else if (context.brand) {
    blocks.push(
      "<marka_profili>Bu markanın onaylı bir marka profili yok. Plan yapabilirsin ama marka hakkında hiçbir bilgi, rakam ya da iddia uydurma; postlar nötr varsayılan tasarımla üretilecek. Yanıtında bunu açıkça söyle ve marka profilinin eklenmesini öner.</marka_profili>",
    );
  }

  if (aliases.length > 0) {
    const shown = new Map(input.images.map((i) => [i.alias, i]));
    const rows = aliases.map((a) => {
      const img = shown.get(a.alias);
      const size = a.width && a.height ? `${a.width}x${a.height}` : "boyut bilinmiyor";
      const status = img?.attached
        ? "son mesajda; görüntüsü ekte"
        : img?.note
          ? img.note
          : "daha önce eklendi; bu turda gösterilmiyor";
      const old = a.previousAliases.length
        ? ` (eski adları: ${a.previousAliases.map((p) => `@${p}`).join(", ")})`
        : "";
      return `- @${a.alias}${old}: ${a.kind}, ${a.mimeType}, ${size}${a.filename ? `, ${a.filename}` : ""} — ${status}`;
    });
    blocks.push(`<takma_adlar>\n${rows.join("\n")}\n</takma_adlar>`);
  } else {
    blocks.push("<takma_adlar>(bu konuşmada henüz ek yok)</takma_adlar>");
  }

  if (context.openPlan) {
    blocks.push(`<acik_plan>\n${planSummary(context.openPlan)}\n</acik_plan>`);
  }

  blocks.push(
    `<konusma>\n${transcript(context, aliases, input.maxTranscriptChars ?? 24_000) || "(boş)"}\n</konusma>`,
  );
  blocks.push(
    "Yukarıdaki konuşmanın son mesajına yanıt ver. Yanıtın JSON yapısında: önce reply, sonra action ve gerekiyorsa plan ya da question.",
  );
  return blocks.join("\n\n");
}
