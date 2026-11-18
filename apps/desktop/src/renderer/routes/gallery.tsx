// /gallery (⌥⌘G in dev, or ?route=gallery): every design-system component in every state, for
// visual QA against the Wecra "Claude Code" components page.
import type {
  ConsentPart,
  Plan,
  ProgressPart,
  QuestionPart,
  ToolStepPart,
  WorkerPresence,
} from "@studio/contract";
import { type ReactNode, useState } from "react";
import {
  type CardActions,
  ConsentCard,
  EventLine,
  PlanProposalCard,
  ProgressCard,
  QuestionCard,
  StepLine,
  WorkingLine,
} from "../components/chat/blocks.tsx";
import { JumpToLatest } from "../components/chat/chat-view.tsx";
import { Composer } from "../components/chat/composer.tsx";
import { ImageGrid } from "../components/chat/images.tsx";
import { Markdown } from "../components/chat/markdown.tsx";
import { UserBubble } from "../components/chat/messages.tsx";
import { modelMenu, StatusLine, UsageCard } from "../components/chat/status-line.tsx";
import { PanelRow, PanelSection } from "../components/panels/right-panel.tsx";
import { ConversationRow, GroupHeader, SidebarRow } from "../components/shell/sidebar.tsx";
import {
  Button,
  type ButtonVariant,
  Checkbox,
  cn,
  IconButton,
  Meter,
  SearchField,
  SegmentedControl,
  Spinner,
  Switch,
  TagPill,
  TextField,
  UsageRing,
  WorkingDots,
} from "../components/ui/controls.tsx";
import { FontPicker } from "../components/ui/font-picker.tsx";
import { IconList, IconPlus, IconSearch, PlatformIcon } from "../components/ui/icons.tsx";
import { Menu, type MenuEntry } from "../components/ui/menu.tsx";
import tokens from "../design/tokens.json";
import { ChecksGallery } from "../features/checks/checks-gallery.tsx";
import { type AgentChoice, FALLBACK_CHOICE } from "../lib/models.ts";
import { stepSummary } from "../lib/transcript.ts";
import { useAppStore } from "../state/app-store.ts";

const now = new Date().toISOString();

function tile(from: string, to: string, title: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><text x="28" y="44" font-family="-apple-system" font-size="15" letter-spacing="2" fill="#fff" font-weight="600">MTM AGRO</text><text x="28" y="420" font-family="-apple-system" font-size="34" fill="#fff" font-weight="700">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const SAMPLE_IMAGES = [
  {
    assetId: "g1",
    width: 400,
    height: 500,
    caption: "@mtm-hasat-1.png",
    url: tile("#E8A050", "#6B3410", "Hasat bitti"),
  },
  {
    assetId: "g2",
    width: 400,
    height: 500,
    caption: "@mtm-hasat-2.png",
    url: tile("#9CC77A", "#2F5E22", "Toprak analizi"),
  },
  {
    assetId: "g3",
    width: 400,
    height: 500,
    caption: "@mtm-hasat-3.png",
    url: tile("#7DB3DD", "#284C70", "Damla sulama"),
  },
];

const MARKDOWN = `**Kasım planı hazır**

MTM Agro'nun marka profilini ve geçen ayın en iyi performans gösteren postlarını inceledim. Ayrıntılar için [Meta rehberi](https://example.com) işine yarar.

- Instagram: 3 kaydırmalı post — hasat sonrası toprak bakımı
  - 18 Kasım 10:00 · kaydırmalı, 5 kare
  - 22 Kasım 18:00 · Reels, damla sulama (30 sn)
- LinkedIn: Partner Agro bayi ağı ve \`sezon raporu\`

1. Metinleri yaz
2. Görselleri üret

| Gün | Platform | Post |
| --- | --- | --- |
| 18 Kas | Instagram | Hasat sonrası toprak bakımı · kaydırmalı |
| 20 Kas | LinkedIn | Partner Agro bayi ağı büyüyor |

\`\`\`json
{ "marka": "MTM Agro", "tarih": "2026-11-18T10:00" }
\`\`\`

> Not: Reels için müzik önerisi ayrıca gelecek.`;

const STEPS: ToolStepPart[] = [
  {
    type: "tool_step",
    id: "s1",
    name: "get_brand_profile",
    label: "Marka profili okundu",
    state: "done",
    summary: null,
  },
  {
    type: "tool_step",
    id: "s2",
    name: "generate_ai_image",
    label: "Görsel üretildi",
    state: "done",
    summary: "@mtm-hasat-1",
  },
  {
    type: "tool_step",
    id: "s3",
    name: "generate_ai_image",
    label: "Görsel üretildi",
    state: "done",
    summary: null,
  },
  {
    type: "tool_step",
    id: "s4",
    name: "generate_post",
    label: "Post oluşturuldu",
    state: "done",
    summary: null,
  },
];

const PROGRESS: ProgressPart[] = [
  {
    type: "progress",
    stepId: "p1",
    label: "Marka profilini ve geçen ayın postlarını oku",
    state: "done",
    detail: null,
    current: null,
    total: null,
  },
  {
    type: "progress",
    stepId: "p2",
    label: "6 post metni yaz · 3 Instagram, 2 LinkedIn, 1 Reels",
    state: "done",
    detail: null,
    current: null,
    total: null,
  },
  {
    type: "progress",
    stepId: "p3",
    label: "Görselleri üret",
    state: "running",
    detail: null,
    current: 2,
    total: 6,
  },
  {
    type: "progress",
    stepId: "p4",
    label: "Takvime yerleştir ve onaya gönder",
    state: "pending",
    detail: null,
    current: null,
    total: null,
  },
];

const PLAN: Plan = {
  id: "plan1",
  brandId: "b1",
  conversationId: "c1",
  runId: null,
  title: "Kasım kampanya planı",
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  status: "proposed",
  summary: "",
  revision: 1,
  decidedAt: null,
  rejectionReason: null,
  createdAt: now,
  updatedAt: now,
  items: [
    {
      platforms: ["instagram"],
      title: "Hasat sonrası toprak bakımı",
      date: "2026-11-18",
      contentType: "carousel",
    },
    {
      platforms: ["linkedin"],
      title: "Partner Agro bayi ağı büyüyor",
      date: "2026-11-20",
      contentType: "post",
    },
    {
      platforms: ["instagram", "facebook"],
      title: "Damla sulama ile %40 su tasarrufu",
      date: "2026-11-22",
      contentType: "reel",
    },
  ].map((item, position) => ({
    id: `i${position}`,
    planId: "plan1",
    position,
    date: item.date,
    platforms: item.platforms as Plan["items"][number]["platforms"],
    contentType: item.contentType as Plan["items"][number]["contentType"],
    title: item.title,
    brief: "",
    pillar: null,
    imageSlot: "none" as Plan["items"][number]["imageSlot"],
    imageBrief: null,
    status: "planned" as const,
    contentId: null,
    generation: null,
    createdAt: now,
    updatedAt: now,
  })),
};

const CONSENT: ConsentPart = {
  type: "consent",
  consentId: "k1",
  tool: "schedule_content",
  title: "Postu zamanla",
  detail: "Hasat sonrası toprak bakımı · Instagram · 18 Kasım 10:00",
  state: "pending",
  decidedAt: null,
};

const QUESTION: QuestionPart = {
  type: "question",
  questionId: "q1",
  prompt: "Reels için hangi tonu kullanalım?",
  mode: "single",
  options: [
    { id: "a", label: "Samimi", description: null },
    { id: "b", label: "Bilgilendirici", description: null },
    { id: "c", label: "Eğlenceli", description: null },
  ],
  allowText: true,
  answer: null,
};

const PRESENCE: WorkerPresence = {
  online: true,
  lastSeenAt: now,
  workers: [],
  currentJobs: [],
  queueLength: 0,
  usage: {
    source: "gallery",
    observedAt: now,
    windows: [
      {
        kind: "five_hour",
        usedPercent: 45,
        resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
        limited: false,
      },
      {
        kind: "weekly",
        usedPercent: 75,
        resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        limited: false,
      },
    ],
  },
};

const stub: CardActions = {
  acceptAndGenerate: async () => undefined,
  generatePlan: async () => undefined,
  rejectPlan: async () => undefined,
  decideConsent: async () => undefined,
  answer: async () => undefined,
};

const message = {
  id: "m1",
  conversationId: "c1",
  role: "assistant" as const,
  status: "complete" as const,
  runId: null,
  parts: [],
  createdAt: now,
  updatedAt: now,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-hairline py-6">
      <h2 className="mb-4 text-heading font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function State({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-1.5", className)}>
      {children}
      <span className="text-caption text-fg-3">{label}</span>
    </div>
  );
}

const STATES = ["Default", "Hover", "Pressed", "Disabled", "Focus"] as const;
const HOVER: Record<ButtonVariant, string> = {
  primary: "!bg-accent-hover",
  secondary: "!bg-control-hover",
  ghost: "!bg-control",
  danger: "opacity-[.88]",
};
const PRESSED: Record<ButtonVariant, string> = {
  primary: "!bg-accent-pressed",
  secondary: "!bg-control-pressed",
  ghost: "!bg-control-hover",
  danger: "opacity-75",
};
const FOCUS = "shadow-[0_0_0_1px_var(--focus-ring),var(--shadow-focus)]";

/** The FontPicker as a field and as a button (this Mac's fonts; a stand-in list in a browser). */
function FontPickerDemo() {
  const [value, setValue] = useState<{ family: string; style?: string | null }>({
    family: "Avenir Next",
    style: "Demi Bold",
  });
  return (
    <div className="flex flex-wrap items-center gap-4">
      <FontPicker
        label="Başlık yazı tipi"
        className="w-[240px]"
        value={value}
        pinned={["Avenir Next", "Söhne"]}
        onChange={(choice) =>
          setValue({ family: choice.family, style: choice.style?.name ?? null })
        }
      />
      <FontPicker
        trigger="button"
        label="Mac'ten seç"
        placeholder="Mac'ten seç"
        value={null}
        pinned={["Avenir Next"]}
        onChange={(choice) =>
          setValue({ family: choice.family, style: choice.style?.name ?? null })
        }
      />
      <span className="text-footnote text-fg-3">
        Seçili: {value.family}
        {value.style ? ` · ${value.style}` : ""}
      </span>
    </div>
  );
}

export default function Gallery() {
  const [segment, setSegment] = useState<"chat" | "posts">("chat");
  const [toggle, setToggle] = useState(true);
  const [check, setCheck] = useState(true);
  const [choice, setChoice] = useState<AgentChoice>({ model: "opus", effort: "medium" });
  const openLightbox = useAppStore((s) => s.openLightbox);
  const showToast = useAppStore((s) => s.showToast);
  const titleMenu: MenuEntry[] = [
    { id: "a", label: "Farklı aç", submenu: [{ id: "a1", label: "Yeni pencere" }] },
    { id: "r", label: "Yeniden adlandır", shortcut: "R" },
    { id: "f", label: "Çatalla", shortcut: "F", disabled: true },
    { type: "separator" },
    { id: "ar", label: "Arşivle", shortcut: "A" },
    { id: "d", label: "Sil", shortcut: "D", danger: true },
  ];
  return (
    <div className="scroll-area min-h-0 flex-1">
      <div className="mx-auto max-w-[1040px] px-8 pb-24">
        <Section title="Renkler (Theme)">
          <div className="grid grid-cols-8 gap-3">
            {Object.keys(tokens.theme).map((name) => (
              <div key={name} className="flex flex-col gap-1">
                <div
                  className="h-9 rounded-[8px] shadow-[inset_0_0_0_1px_var(--border-hairline)]"
                  style={{ background: `var(--${name.replace("/", "-")})` }}
                />
                <span className="text-caption text-fg-3">{name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Tipografi">
          <div className="flex flex-col gap-2">
            <span className="text-display font-semibold">Bugün ne üretelim, Burak?</span>
            <span className="text-title font-semibold">Kasım kampanya postları</span>
            <span className="text-prose font-semibold">Kasım planı hazır</span>
            <span className="text-prose">
              Hasat sonrası dönemde çiftçilerin en çok sorduğu konular toprak bakımı ve kışa
              hazırlık.
            </span>
            <span className="text-heading font-semibold">Ortam · Kullanım · Bağlam</span>
            <span className="text-body-lg">Yanıt sonrası öneriler</span>
            <span className="text-body font-medium">Kaydet · Vazgeç · Markaları aç</span>
            <span className="text-body">Yeni sohbet · Ara · Postlar · Takvim · Medya</span>
            <span className="text-footnote">Opus 5.5 Orta · 22:30'da sıfırlanır</span>
            <span className="text-caption">Yalnızca yerel · Zamanlandı</span>
            <span className="font-mono text-mono">"tarih": "2026-11-18T10:00"</span>
          </div>
        </Section>

        <Section title="Icon button · 28 / 32">
          {[28, 32].map((size) => (
            <div key={size} className="mb-3 flex gap-6">
              {(["Default", "Hover", "Pressed", "Selected", "Disabled", "Focus"] as const).map(
                (state) => (
                  <State key={state} label={`${size} · ${state}`}>
                    <IconButton
                      icon={<IconList size={16} strokeWidth={1.5} />}
                      label={state}
                      size={size as 28 | 32}
                      tooltip={false}
                      selected={state === "Selected"}
                      disabled={state === "Disabled"}
                      className={cn(
                        state === "Hover" && "!bg-control",
                        state === "Pressed" && "!bg-control-hover",
                        state === "Focus" && FOCUS,
                      )}
                    />
                  </State>
                ),
              )}
            </div>
          ))}
        </Section>

        <Section title="Button · kapsül 28">
          {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
            <div key={variant} className="mb-3 flex gap-4">
              {STATES.map((state) => (
                <State key={state} label={`${variant} · ${state}`}>
                  <Button
                    variant={variant}
                    disabled={state === "Disabled"}
                    className={cn(
                      state === "Hover" && HOVER[variant],
                      state === "Pressed" && PRESSED[variant],
                      state === "Focus" && FOCUS,
                    )}
                  >
                    {variant === "danger"
                      ? "Sil"
                      : variant === "ghost"
                        ? "Tümünü gör"
                        : variant === "secondary"
                          ? "Vazgeç"
                          : "Kaydet"}
                  </Button>
                </State>
              ))}
            </div>
          ))}
          <div className="flex gap-4">
            <Button size="sm" variant="secondary" icon={<IconPlus size={12} />}>
              Küçük
            </Button>
            <Button size="lg" variant="primary">
              Büyük
            </Button>
          </div>
        </Section>

        <Section title="Segment · Text field · Switch · Checkbox · Tag pill">
          <div className="flex flex-wrap items-start gap-8">
            <State label="Segmented control">
              <SegmentedControl<"chat" | "posts">
                label="Mod"
                value={segment}
                onChange={setSegment}
                options={[
                  { value: "chat", label: "Sohbet" },
                  { value: "posts", label: "Postlar" },
                ]}
              />
            </State>
            <State label="Text · default / hover / focus / disabled">
              <div className="flex flex-col gap-2">
                <TextField placeholder="Örn. MTM Agro" className="w-[220px]" />
                <TextField placeholder="Örn. MTM Agro" className="w-[220px] !bg-control" />
                <TextField
                  defaultValue="MTM Agro"
                  className="w-[220px] shadow-[inset_0_0_0_1px_var(--focus-ring),var(--shadow-focus)]"
                />
                <TextField placeholder="Örn. MTM Agro" disabled className="w-[220px]" />
              </div>
            </State>
            <State label="Search · default / focus">
              <div className="flex flex-col gap-2">
                <SearchField className="w-[220px]" />
                <SearchField
                  className="w-[220px] shadow-[inset_0_0_0_1px_var(--focus-ring),var(--shadow-focus)]"
                  defaultValue="hasat"
                />
              </div>
            </State>
            <State label="Switch · off / on / disabled">
              <div className="flex gap-3">
                <Switch label="a" checked={!toggle} onChange={(v) => setToggle(!v)} />
                <Switch label="b" checked={toggle} onChange={setToggle} />
                <Switch label="c" checked disabled onChange={() => undefined} />
              </div>
            </State>
            <State label="Checkbox · off / on / disabled">
              <div className="flex gap-3">
                <Checkbox label="a" checked={!check} onChange={(v) => setCheck(!v)} />
                <Checkbox label="b" checked={check} onChange={setCheck} />
                <Checkbox label="c" checked disabled onChange={() => undefined} />
              </div>
            </State>
            <State label="Tag pill">
              <div className="flex gap-2">
                <TagPill>Yalnızca yerel</TagPill>
                <TagPill tone="accent">Yeni</TagPill>
                <TagPill tone="success">Bağlı</TagPill>
                <TagPill tone="danger">Hata</TagPill>
              </div>
            </State>
          </div>
        </Section>

        <Section title="Kenar çubuğu">
          <div className="sidebar-surface w-[265px] rounded-[12px] py-2">
            <SidebarRow icon={<IconPlus size={16} strokeWidth={1.5} />} label="Yeni sohbet" />
            <SidebarRow
              icon={<IconSearch size={16} strokeWidth={1.5} />}
              label="Ara (hover)"
              className="!bg-control"
            />
            <SidebarRow icon={<IconList size={16} strokeWidth={1.5} />} label="Seçili" selected />
            <GroupHeader label="MTM Agro" expanded onToggle={() => undefined} />
            <ConversationRow
              conversation={{
                id: "c1",
                brandId: "b1",
                title: "Kasım kampanya postları",
                status: "active",
                activeRunId: null,
                lastSeq: 0,
                lastActivityAt: now,
                createdAt: now,
                updatedAt: now,
              }}
              selected
              running={false}
              onOpen={() => undefined}
              menu={titleMenu}
            />
            <ConversationRow
              conversation={{
                id: "c2",
                brandId: "b1",
                title: "Bayi duyurusu · LinkedIn",
                status: "active",
                activeRunId: "r1",
                lastSeq: 0,
                lastActivityAt: now,
                createdAt: now,
                updatedAt: now,
              }}
              selected={false}
              running
              onOpen={() => undefined}
              menu={titleMenu}
            />
            <GroupHeader label="Partner Agro" expanded={false} onToggle={() => undefined} />
          </div>
        </Section>

        <Section title="Menü · Toast">
          <div className="flex flex-wrap items-start gap-6">
            <Menu
              inline
              open
              anchor={null}
              entries={titleMenu}
              onClose={() => undefined}
              width={248}
            />
            <Menu
              inline
              open
              anchor={null}
              entries={modelMenu(choice, setChoice)}
              onClose={() => undefined}
              width={248}
            />
            <div className="flex flex-col gap-3">
              <Button
                onClick={() =>
                  showToast({
                    message: "Post zamanlandı · Instagram, 18 Kasım 10:00",
                    action: { label: "Geri al", run: () => undefined },
                  })
                }
              >
                Toast göster
              </Button>
              <div className="glass flex h-9 items-center gap-2 rounded-full pr-3 pl-3 text-body">
                <span className="size-2 rounded-full bg-accent" />
                Post zamanlandı · Instagram, 18 Kasım 10:00
                <span className="font-medium text-accent-text">Geri al</span>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Yazı tipi seçici (FontPicker)">
          <FontPickerDemo />
        </Section>

        <Section title="Composer · durumlar">
          <div className="flex max-w-[710px] flex-col gap-4">
            <Composer
              placeholder="Bir şey sor…"
              working={false}
              brandId={null}
              onSend={async () => true}
            />
            <Composer
              placeholder="Bir şey sor…"
              initialText="Partner Agro için de aynı planı hazırla"
              working={false}
              brandId="b1"
              onSend={async () => true}
            />
            <Composer
              placeholder="Bir şey sor…"
              workingPlaceholder="↩ sıraya al · ⌘↩ durdurup hemen gönder"
              working
              brandId="b1"
              onSend={async () => true}
            />
            <Composer
              placeholder="Bir şey sor…"
              forceFocus
              working={false}
              brandId="b1"
              onSend={async () => true}
            />
            <StatusLine choice={choice} onChoice={setChoice} presence={PRESENCE} />
            <div className="flex items-center gap-6">
              <State label="Working dots">
                <WorkingDots />
              </State>
              <State label="Queued dots">
                <WorkingDots animated={false} />
              </State>
              <State label="Spinner">
                <Spinner />
              </State>
              <State label="Usage ring 45 / 95">
                <div className="flex gap-2">
                  <UsageRing percent={45} />
                  <UsageRing percent={95} warning />
                </div>
              </State>
              <State label="Jump to latest">
                <div className="relative mt-11 h-0 w-10">
                  <JumpToLatest working onClick={() => undefined} />
                </div>
              </State>
            </div>
            <div className="glass w-fit rounded-[14px] p-3.5">
              <UsageCard presence={PRESENCE} />
            </div>
          </div>
        </Section>

        <Section title="Sohbet · adım satırları, plan, kartlar">
          <div className="max-w-[710px]">
            <WorkingLine
              working={{
                phase: { kind: "step", label: "Görseller üretiliyor" },
                since: Date.now() - 69_000,
                cancellable: false,
                groupKey: "x",
              }}
              onOpenGroup={() => undefined}
            />
            <WorkingLine
              working={{
                phase: { kind: "thinking" },
                since: null,
                cancellable: false,
                groupKey: null,
              }}
            />
            <WorkingLine
              working={{
                phase: { kind: "queued", text: "Sırada" },
                since: null,
                cancellable: true,
                groupKey: null,
              }}
              onCancel={() => undefined}
            />
            <StepLine
              group={{
                key: "g",
                steps: STEPS,
                isExpanded: false,
                thumbnails: SAMPLE_IMAGES.slice(0, 2),
                isLive: false,
                summary: stepSummary(STEPS),
                hasErrors: false,
              }}
              onToggle={() => undefined}
            />
            <StepLine
              group={{
                key: "g2",
                steps: STEPS,
                isExpanded: true,
                thumbnails: [],
                isLive: false,
                summary: stepSummary(STEPS),
                hasErrors: false,
              }}
              onToggle={() => undefined}
            />
            <EventLine text="Zamanlanmış post yayınlandı · Instagram" />
            <ProgressCard steps={PROGRESS} />
            <PlanProposalCard plan={PLAN} busy={false} controller={stub} onEdit={() => undefined} />
            <ConsentCard message={message} consent={CONSENT} busy={false} controller={stub} />
            <ConsentCard
              message={message}
              consent={{ ...CONSENT, state: "allowed" }}
              busy={false}
              controller={stub}
            />
            <QuestionCard message={message} question={QUESTION} busy={false} controller={stub} />
          </div>
        </Section>

        <Section title="Mesajlar · Markdown · Görseller">
          <div className="max-w-[710px]">
            <UserBubble
              text="Kasım için MTM Agro'ya 6 post hazırla: 3 Instagram, 2 LinkedIn, 1 Reels. Ton samimi ama bilgilendirici olsun."
              mentions={[]}
              images={[]}
              aliases={[]}
              onMention={() => undefined}
            />
            <div className="my-3">
              <UserBubble
                text="Reels için müzik önerisi de ekle."
                mentions={[]}
                images={[]}
                aliases={[]}
                onMention={() => undefined}
                muted
              />
            </div>
            <Markdown source={MARKDOWN} />
            <ImageGrid images={SAMPLE_IMAGES} className="my-3.5" />
            <ImageGrid images={SAMPLE_IMAGES.slice(1, 2)} className="my-3.5" />
            <Button onClick={() => openLightbox({ images: SAMPLE_IMAGES, index: 1 })}>
              Lightbox (2 / 3)
            </Button>
          </div>
        </Section>

        <Section title="Sağ panel">
          <div className="w-[357px] rounded-[12px] border border-hairline px-4 pt-3.5">
            <PanelSection title="Kullanım">
              <div className="mb-1.5 flex justify-between text-body-lg">
                <span>5 saatlik limit</span>
                <span className="text-body text-fg-3">%45</span>
              </div>
              <Meter percent={45} />
              <div className="mt-3 mb-1.5 flex justify-between text-body-lg">
                <span>Haftalık · tüm modeller</span>
                <span className="text-body text-fg-3">%75</span>
              </div>
              <Meter percent={75} tone="warning" />
            </PanelSection>
            <PanelSection title="Hesaplar" last>
              <PanelRow
                icon={<PlatformIcon platform="instagram" />}
                label="@mtmagro"
                value="Bağlı"
                tone="success"
              />
              <PanelRow
                icon={<PlatformIcon platform="facebook" />}
                label="MTM Agro"
                value="Bağlı"
                tone="success"
              />
              <PanelRow
                icon={<PlatformIcon platform="linkedin" />}
                label="Partner Agro"
                value="Yeniden bağla"
                tone="action"
                onClick={() => undefined}
              />
            </PanelSection>
          </div>
        </Section>
        <Section title="Kontroller (post ayrıntısı · Marka Kiti)">
          <ChecksGallery />
        </Section>
        <p className="pt-6 text-footnote text-fg-3">Varsayılan model: {FALLBACK_CHOICE.model}</p>
      </div>
    </div>
  );
}
