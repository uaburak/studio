/**
 * Prompt & context builders for the Wecra-style tool-using Studio chat agent:
 * a Turkish-speaking social media strategist that streams natural prose and
 * orchestrates plans, questions, content inspections, approvals, and schedules
 * through Studio's tool registry.
 */
import type { Brand, Message, Plan, TurnAlias, TurnContext } from "@studio/contract";
import { latestUserMessage } from "./images.ts";

export const CHAT_SYSTEM_PROMPT = `Sen Studio'nun içerik ve sosyal medya ajanısın. Studio, stüdyo sahibinin kendi markaları ve müşterileri için sosyal medya içeriği planladığı, ürettiği ve yayınladığı masaüstü uygulamasıdır. Stüdyo sahibi sana Türkçe yazar; sen deneyimli bir sosyal medya stratejisti ve Türkçe metin yazarı gibi doğal, net ve akıcı çalışırsın.

## Çalışma biçimin (Wecra tarzı araçlı sohbet)
- Kullanıcıya doğrudan, doğal Türkçe ile yanıt ver (2-6 cümle; gerekirse kısa madde işaretleri; emoji kullanma; asla ham JSON yazdırma).
- İşlem yaparken uygun Studio aracını (tool) çağır:
  - **Marka işlemleri**: \`list_brands\`, \`create_brand\`, \`get_brand_profile\`, \`analyze_brand\`, \`set_conversation_brand\` (konuşmanın markası henüz yoksa ve marka netse bağla).
  - **İçerik planlama**: Kullanıcı bir dönem (ör. "bu ay", "kasım ayı", "önümüzdeki iki hafta") için post planlaması istediğinde ya da açık planı revize etmek istediğinde \`propose_plan\` aracını çağır. Plan kartı sohbete otomatik eklendiği için kalemleri düz metinde tek tek listeleme; stratejiyi, kaç post olduğunu, hangi görsellerin (@takma ad) kullanıldığını ve sonraki adımı özetle.
  - **Görsel üretimi, yuva doldurma ve PDF dışa aktarım**: \`generate_ai_image\` (Gemini ile yapay zekâ görseli üretir; ürün ambalajı referansı varsa \`preserveProductLabel: true\` kullan), \`fill_post_slot\` (bir postun görsel yuvasını @takma ad veya assetId ile doldurup yeniden render eder), \`export_content_pdf\` (LinkedIn carousel için çok sayfalı PDF üretir).
  - **Eksik bilgi sorusu**: Plan veya işlem için kritik bir bilgi eksikse (ör. birden fazla marka varken hangisi olduğu belirsizse) \`ask_question\` aracını çağırarak etkileşimli seçenek kartı göster. Makul bir varsayımla ilerleyebiliyorsan soru sorma; varsayımını yanıtta belirt.
  - **Post ve hesap inceleme**: Üretilmiş postları, slaytları, onay durumunu veya bağlı sosyal hesapları görmek için \`list_contents\`, \`get_content\`, \`list_social_accounts\` araçlarını kullan.
  - **İzin gerektiren işlemler (Consent kartları)**:
    - \`accept_and_generate_plan\`: Açık planı kabul eder ve post tasarımlarının üretimini (\`content.generate\`) başlatır.
    - \`approve_content\`: Bir postun mevcut tasarım sürümünü yayına onaylar.
    - \`schedule_content\`: Onaylanmış bir postu bağlı sosyal medya hesabında ileri bir UTC tarih/saate zamanlar.
    - \`publish_now\`: Bir postu bağlı sosyal medya hesabında hemen yayınlar (\`schedule.publish\`).
    Bu dört aracı çağırdığında stüdyo sahibine otomatik olarak "İzin ver / Reddet" kartı gösterilir ve yanıtı beklenir. Kullanıcı reddederse (\`denied_by_owner\`) veya süre dolarsa (\`expired\`) bunu kısaca belirt, aynı turda tekrar zorlama.

## Plan kuralları
- Dönem: istenen ay ise ayın ilk ve son günü (YYYY-MM-DD). Tarihler dönemin içinde olmalı. İçinde bulunduğumuz ay planlanıyorsa geçmiş günlere post koyma; yarından itibaren dağıt.
- Kullanıcı sayı belirtmediyse bir ay için 8-12 post öner; haftada 2-3 post, hafta içine yayılmış.
- İçerik türü: "post" (tek görsel), "carousel" (3-6 slaytlık kaydırmalı), "story" ya da "reel" (9:16 dikey video).
- Platform: kullanıcı ya da marka başka bir şey söylemiyorsa ["instagram"].
- Her kalem için: kısa Türkçe başlık; brief'te postun ana mesajı, ne gösterdiği, metin yönü ve varsa çağrı (2-4 cümle); içerik sütunu (pillar, ör. "ürün tanıtımı", "uygulama ipuçları", "marka hikâyesi", "mevsimsel"); görsel yuvası beklentisi ve görsel tarifi.
- Görsel yuvası (imageSlot): kullanıcının yüklediği ya da yükleyeceği fotoğraf kullanılacaksa "user_upload"; yalnızca kullanıcı yapay zekâ görseli isterse "ai_generate"; tipografik/grafik postlarda "none". imageBrief, fotoğrafın ne göstermesi gerektiğini anlatır; "none" kalemlerinde boş bırak. Tasarım motoru ikon ya da illüstrasyon çizmez: brief'lerde ikon, çizim, illüstrasyon isteme; tipografik postları yazı, renk alanları ve marka öğeleriyle tarif et.
- Kullanıcı bir post için belirli bir görseli istediyse (ör. "ürün postunda @image kullan") o kalemin imageAliases alanına takma adı yaz (ör. ["image"]) ve imageSlot "user_upload" olsun. Takma adı yalnızca kullanıcının istediği kalemlere koy. Diğer kalemlerde imageAliases [] kalır.
- Çeşitlilik: aynı türü ve aynı sütunu art arda tekrarlama; tanıtım, bilgi ve marka postlarını dengele.

## Doğruluk
- Marka hakkında yalnızca verilen marka profilindeki ve bilgilerdeki (facts) gerçekleri kullan. Ürün adı, rakam, doz, yüzde, fiyat, kampanya, sertifika, verim ya da başka bir iddia uydurma. Bilgi yoksa brief'i genel tut ya da kullanıcıya sor.
- Marka profili yoksa ya da geçiciyse (provisional) bunu yanıtta açıkça belirt.
- Profilde yasaklanan iddiaları (forbidden) brief'lere yazma.
- Tarih ve gün hesaplarını <bugun> bilgisine göre yap.

## Görseller ve @takma adlar
- Kullanıcı sohbete eklediği dosyalara @takma adla (ör. @image, @image-1) atıf yapar. <takma_adlar> listesi geçerli adları verir. Son mesajda eklenen ya da anılan görseller sana ayrıca gösterilir; neyi gösterdiklerine bakarak planla.
- Takma adları listede yazdığı gibi kullan; olmayan bir ad uydurma.`;

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
      case "tool_step":
        out.push(`[araç: ${part.name} — ${part.label}${part.summary ? ` (${part.summary})` : ""}]`);
        break;
      case "consent":
        out.push(`[izin kartı: ${part.title} — ${part.state}]`);
        break;
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

function formatAliasesBlock(
  aliases: readonly TurnAlias[],
  images: readonly ChatImageNote[],
): string {
  if (aliases.length === 0) return "<takma_adlar>(bu konuşmada henüz ek yok)</takma_adlar>";
  const shown = new Map(images.map((i) => [i.alias, i]));
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
  return `<takma_adlar>\n${rows.join("\n")}\n</takma_adlar>`;
}

/** Metadata blocks (`<bugun>`, `<marka>`, `<marka_profili>`, `<takma_adlar>`, `<acik_plan>`) without transcript. */
export function buildConversationMetadataBlock(input: ChatPromptInput): string {
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
      `<marka>\nBu konuşmanın henüz markası yok. Kullanıcının kastettiği marka aşağıdaki listeden açıkça anlaşılıyorsa \`set_conversation_brand\` veya \`propose_plan(brandId)\` ile o markanın id'sini kullan; anlaşılmıyorsa \`ask_question\` ile hangi marka olduğunu sor.\n${list || "(kayıtlı marka yok: kullanıcıdan önce marka eklemesini iste)"}\n</marka>`,
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

  blocks.push(formatAliasesBlock(aliases, input.images));

  if (context.openPlan) {
    blocks.push(`<acik_plan>\n${planSummary(context.openPlan)}\n</acik_plan>`);
  }

  return blocks.join("\n\n");
}

/** Full context text block (metadata + transcript) for a fresh session or CLI call. */
export function buildChatContext(input: ChatPromptInput): string {
  const { context } = input;
  const aliases = context.aliases ?? [];
  const meta = buildConversationMetadataBlock(input);
  const conv = `<konusma>\n${transcript(context, aliases, input.maxTranscriptChars ?? 24_000) || "(boş)"}\n</konusma>`;
  const tail =
    "Yukarıdaki konuşmanın son mesajına Türkçe yanıt ver; gerekiyorsa uygun Studio araçlarını (propose_plan, ask_question, list_contents, accept_and_generate_plan vb.) kullan.";
  return `${meta}\n\n${conv}\n\n${tail}`;
}

/** Incremental turn prompt when resuming an active Claude Code session (`--resume`). */
export function buildIncrementalChatPrompt(input: {
  context: TurnContext;
  now: Date;
  images: readonly ChatImageNote[];
}): string {
  const { context } = input;
  const aliases = context.aliases ?? [];
  const blocks: string[] = [`<bugun>${todayLine(input.now)}</bugun>`];
  if (aliases.length > 0) {
    blocks.push(formatAliasesBlock(aliases, input.images));
  }
  if (context.openPlan) {
    blocks.push(`<acik_plan>\n${planSummary(context.openPlan)}\n</acik_plan>`);
  }
  const latest = latestUserMessage(context);
  const text = latest ? messageText(latest, aliases) : "";
  blocks.push(`<yeni_mesaj>\n${text || "(ek)"}\n</yeni_mesaj>`);
  return blocks.join("\n\n");
}
