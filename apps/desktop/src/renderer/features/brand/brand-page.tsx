// "Marka profili" (port of StudioMac's brand settings sheet as a page, opened from Markalar):
// Genel (name, short name, language, archive), Marka Kiti (logos, colours, fonts, sample posts,
// notes; saved as you go), Profil (versions, tokens, voice and design rules; save, approve, new
// draft, AI analysis), Hesaplar (connection state; connecting lives in Settings), Ürünler
// (the brand's products) and Şablonlar (approved posts saved as layouts, N9). The section is part of the route, so back / forward step through
// sections too. The content uses the page's full width; only long text keeps a reading width.
import type { Brand, BrandKitLogoBackground, BrandProfile } from "@studio/contract";
import { MAX_KIT_SAMPLES, MIN_KIT_SAMPLES } from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  TextField,
} from "../../components/ui/controls.tsx";
import {
  IconClose,
  IconPlus,
  IconSparkles,
  IconUpload,
  PlatformIcon,
} from "../../components/ui/icons.tsx";
import { ZoomableImage } from "../../components/ui/zoomable-image.tsx";
import { describeError } from "../../lib/api.ts";
import { percentText } from "../../lib/format.ts";
import { type BrandTab, useAppStore } from "../../state/app-store.ts";
import { useAccounts, useBrands } from "../../state/studio.tsx";
import { ChecksSettingsSection } from "../checks/checks-settings.tsx";
import { useBrandAssets } from "../media/media-data.ts";
import { FieldLabel, PageHeader, TextLink } from "../pane-ui.tsx";
import {
  cardProfile,
  useAnalysisJob,
  useBrandActions,
  useBrandKit,
  useBrandProfiles,
  useWorkerOnline,
} from "./brand-data.ts";
import {
  analysisBlocker,
  brandCard,
  colorName,
  familyGuess,
  type KitDraft,
  kitDraft,
  kitProblem,
  looksLikeNegativeLogo,
  nextColorName,
  normalizedHex,
  PLATFORM_NAME,
  setToken,
  type TokenRow,
  tokenRows,
} from "./brand-model.ts";
import { BrandMark, LanguageSelect } from "./brand-views.tsx";
import { AddSystemFontButton, KitFontList } from "./kit-fonts.tsx";
import { ProductsTab } from "./products-tab.tsx";
import { SkillsSection } from "./skills-section.tsx";
import { TemplatesTab } from "./templates-tab.tsx";

export const BRAND_TAB_OPTIONS: { value: BrandTab; label: string }[] = [
  { value: "general", label: "Genel" },
  { value: "kit", label: "Marka Kiti" },
  { value: "profile", label: "Profil" },
  { value: "accounts", label: "Hesaplar" },
  { value: "products", label: "Ürünler" },
  { value: "templates", label: "Şablonlar" },
];

/** Text areas and long text keep a reading width; everything else uses the full width. */
const READING_WIDTH = "max-w-[960px]";

function BackToBrands() {
  const navigate = useAppStore((s) => s.navigate);
  return (
    <TextLink
      className="mb-1 text-footnote text-fg-2 hover:text-fg"
      onClick={() => navigate({ kind: "brands" })}
    >
      ‹ Markalar
    </TextLink>
  );
}

export default function BrandPage({ brandId, tab }: { brandId: string; tab: BrandTab }) {
  const brands = useBrands();
  const brand = (brands.data ?? []).find((b) => b.id === brandId);
  if (!brand) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader eyebrow={<BackToBrands />} title="Marka profili" />
        <p className="px-8 text-body text-fg-3">
          {brands.isLoading ? "Yükleniyor…" : "Marka bulunamadı."}
        </p>
      </div>
    );
  }
  return <BrandPageBody key={brand.id} brand={brand} tab={tab} />;
}

function BrandPageBody({ brand, tab }: { brand: Brand; tab: BrandTab }) {
  const navigate = useAppStore((s) => s.navigate);
  const setTab = (next: BrandTab) => navigate({ kind: "brand", id: brand.id, tab: next });
  const kit = useBrandKit(brand.id);
  const profiles = useBrandProfiles(brand.id);
  const accounts = useAccounts();
  const card = brandCard({
    brand,
    kit: kit.data,
    profile: cardProfile(profiles.data),
    accounts: accounts.data ?? [],
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow={<BackToBrands />}
        title={
          <span className="flex items-center gap-3">
            <BrandMark
              name={card.name}
              initials={card.initials}
              logoAssetId={card.logoAssetId}
              color={card.swatches[0]?.hex ?? null}
              size={36}
            />
            <span className="truncate">{brand.name}</span>
            {brand.status === "archived" && (
              <span className="rounded-full bg-control px-2 text-footnote font-normal text-fg-2">
                Arşivde
              </span>
            )}
          </span>
        }
        subtitle={`${card.subtitle} · ${card.profileLine}`}
        actions={<AnalyzeButton brand={brand} />}
      >
        <div className="mt-4">
          <SegmentedControl<BrandTab>
            label="Bölüm"
            value={tab}
            onChange={setTab}
            options={BRAND_TAB_OPTIONS}
          />
        </div>
      </PageHeader>
      <div className="scroll-area min-h-0 flex-1 px-8 pb-12">
        <div className="w-full min-w-0">
          {tab === "general" && <GeneralTab brand={brand} />}
          {tab === "kit" && <KitTab brand={brand} />}
          {tab === "profile" && <ProfileTab brand={brand} profiles={profiles.data ?? []} />}
          {tab === "accounts" && <AccountsTab lines={card.platforms} />}
          {tab === "products" && <ProductsTab brand={brand} />}
          {tab === "templates" && <TemplatesTab brand={brand} />}
        </div>
      </div>
    </div>
  );
}

// --- analysis -----------------------------------------------------------------------------------------

function AnalyzeButton({ brand }: { brand: Brand }) {
  const kit = useBrandKit(brand.id);
  const actions = useBrandActions();
  const analysis = useAnalysisJob(brand.id);
  const workerOnline = useWorkerOnline();
  const showToast = useAppStore((s) => s.showToast);
  const [starting, setStarting] = useState(false);
  const blocker = analysisBlocker({ brand, kit: kit.data, workerOnline });
  if (analysis) {
    return (
      <span className="flex items-center gap-2 text-body text-fg-2" role="status">
        <Spinner size={13} />
        {analysis.progressMessage ?? "Marka analiz ediliyor…"}
        {analysis.progress !== undefined && (
          <span className="text-fg-3 tabular-nums">{percentText(analysis.progress * 100)}</span>
        )}
      </span>
    );
  }
  return (
    <Button
      variant="primary"
      icon={<IconSparkles size={14} strokeWidth={1.75} />}
      title={blocker ?? undefined}
      disabled={starting}
      onClick={async () => {
        if (blocker) {
          showToast({ message: blocker });
          return;
        }
        setStarting(true);
        try {
          await actions.analyze(brand.id);
          showToast({ message: "Marka analizi başladı; bitince taslak profil hazır olur." });
        } catch (error) {
          showToast({ message: describeError(error), tone: "danger" });
        } finally {
          setStarting(false);
        }
      }}
    >
      AI ile analiz et
    </Button>
  );
}

// --- Genel ---------------------------------------------------------------------------------------------

function Row({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[60px] items-center gap-6 border-b border-hairline py-3">
      <div className="min-w-0 flex-1">
        <div className="text-body-lg text-fg">{label}</div>
        {detail && <div className="text-body text-fg-2">{detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function GeneralTab({ brand }: { brand: Brand }) {
  const actions = useBrandActions();
  const showToast = useAppStore((s) => s.showToast);
  const [name, setName] = useState(brand.name);
  const [slug, setSlug] = useState(brand.slug);
  const [language, setLanguage] = useState(brand.defaultLanguage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed =
    name.trim() !== brand.name || slug.trim() !== brand.slug || language !== brand.defaultLanguage;
  const save = async (input: Parameters<typeof actions.update>[1], message: string) => {
    setBusy(true);
    setError(null);
    try {
      await actions.update(brand.id, input);
      showToast({ message });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col">
      <Row label="Marka adı" detail="Sohbetlerde ve kartlarda görünen ad.">
        <TextField className="w-[240px]" value={name} onChange={(e) => setName(e.target.value)} />
      </Row>
      <Row label="Kısa ad" detail="Küçük harf, rakam ve tire (mtm-agro).">
        <TextField className="w-[240px]" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </Row>
      <Row label="İçerik dili" detail="Postlar bu dilde yazılır.">
        <LanguageSelect className="w-[240px]" value={language} onChange={setLanguage} />
      </Row>
      <div className="flex items-center gap-3 pt-4">
        <Button
          variant="primary"
          disabled={!changed || busy || !name.trim()}
          onClick={() =>
            void save(
              {
                ...(name.trim() !== brand.name ? { name: name.trim() } : {}),
                ...(slug.trim() !== brand.slug ? { slug: slug.trim() } : {}),
                ...(language !== brand.defaultLanguage ? { defaultLanguage: language } : {}),
              },
              "Marka kaydedildi.",
            )
          }
        >
          Kaydet
        </Button>
        {error && <span className="text-body text-danger">{error}</span>}
      </div>
      <div className="mt-8 border-t border-hairline pt-4">
        <Row
          label={brand.status === "archived" ? "Arşivden çıkar" : "Arşivle"}
          detail={
            brand.status === "archived"
              ? "Marka yeniden listelerde görünür."
              : "Marka silinmez; listelerden kalkar, sonra geri getirilebilir."
          }
        >
          <Button
            variant={brand.status === "archived" ? "secondary" : "danger"}
            disabled={busy}
            onClick={() =>
              void save(
                { status: brand.status === "archived" ? "active" : "archived" },
                brand.status === "archived" ? "Marka arşivden çıkarıldı." : "Marka arşivlendi.",
              )
            }
          >
            {brand.status === "archived" ? "Arşivden çıkar" : "Arşivle"}
          </Button>
        </Row>
      </div>
    </div>
  );
}

// --- Marka kiti ------------------------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | { error: string };

function KitTab({ brand }: { brand: Brand }) {
  const kit = useBrandKit(brand.id);
  const actions = useBrandActions();
  const assets = useBrandAssets(brand.id);
  const fileName = (id: string) => assets.data?.find((a) => a.id === id)?.originalFilename ?? "";
  const [draft, setDraft] = useState<KitDraft | null>(null);
  const [dirty, setDirty] = useState(0);
  const [save, setSave] = useState<SaveState>("idle");
  const [uploads, setUploads] = useState(0);
  const draftRef = useRef<KitDraft | null>(null);
  draftRef.current = draft;

  useEffect(() => {
    if (kit.data && draft === null) setDraft(kitDraft(kit.data));
  }, [kit.data, draft]);

  const problem = draft ? kitProblem(draft) : null;
  const putKit = useRef(actions.putKit);
  putKit.current = actions.putKit;
  const brandId = brand.id;

  // Saved as you go: a short pause after the last change (`dirty` counts the edits).
  const pending = useRef(false);
  useEffect(() => {
    if (dirty === 0 || problem) return;
    pending.current = true;
    const timer = setTimeout(async () => {
      const current = draftRef.current;
      if (!current) return;
      pending.current = false;
      setSave("saving");
      try {
        await putKit.current(brandId, current);
        setSave("saved");
      } catch (error) {
        setSave({ error: describeError(error) });
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [dirty, problem, brandId]);
  // Leaving the tab (or the page) right after an edit still saves it; the tab is gone by then,
  // so a failure is said in a toast (with the way back to the kit).
  useEffect(
    () => () => {
      const current = draftRef.current;
      if (pending.current && current && !kitProblem(current)) {
        pending.current = false;
        void putKit.current(brandId, current).catch((error: unknown) =>
          useAppStore.getState().showToast({
            message: `Marka kitindeki son değişiklik kaydedilemedi: ${describeError(error)}`,
            tone: "danger",
            action: {
              label: "Kite dön",
              run: () =>
                useAppStore.getState().navigate({ kind: "brand", id: brandId, tab: "kit" }),
            },
          }),
        );
      }
    },
    [brandId],
  );

  if (!draft) {
    return (
      <p className="pt-2 text-body text-fg-3">
        {kit.error ? describeError(kit.error) : "Yükleniyor…"}
      </p>
    );
  }

  const change = (update: (d: KitDraft) => KitDraft) => {
    setDraft((d) => (d ? update(d) : d));
    setDirty((n) => n + 1);
  };

  const uploadFiles = async (files: File[], kind: "logo" | "font" | "image") => {
    setUploads((n) => n + files.length);
    for (const file of files) {
      try {
        const asset = await actions.upload(brand.id, file, kind);
        change((d) => {
          if (kind === "logo") {
            const background: BrandKitLogoBackground = looksLikeNegativeLogo(file.name)
              ? "dark"
              : "any";
            return { ...d, logos: [...d.logos, { assetId: asset.id, background }] };
          }
          if (kind === "font") {
            return {
              ...d,
              fonts: [
                ...d.fonts,
                {
                  source: "file",
                  assetId: asset.id,
                  family: familyGuess(file.name),
                  role: "any",
                  styles: [],
                  licenseNote: "",
                },
              ],
            };
          }
          return { ...d, samples: [...d.samples, { assetId: asset.id }].slice(0, MAX_KIT_SAMPLES) };
        });
      } catch (error) {
        setSave({ error: `${file.name}: ${describeError(error)}` });
      } finally {
        setUploads((n) => n - 1);
      }
    }
  };

  const status =
    problem ??
    (uploads > 0
      ? `${uploads} dosya yükleniyor…`
      : save === "saving"
        ? "Kaydediliyor…"
        : save === "saved"
          ? "Kaydedildi"
          : typeof save === "object"
            ? save.error
            : null);

  return (
    <div className="flex flex-col gap-7 pt-1">
      {status && (
        <p
          className={cn(
            "text-footnote",
            problem || typeof save === "object" ? "text-danger" : "text-fg-3",
          )}
          role="status"
        >
          {status}
        </p>
      )}

      <KitSection
        title="Logolar"
        detail="Açık ve koyu zemin için ayrı dosyalar varsa ikisini de ekle."
        action={
          <UploadButton
            label="Logo yükle"
            accept="image/png,image/svg+xml,image/jpeg,image/webp"
            onFiles={(f) => void uploadFiles(f, "logo")}
          />
        }
      >
        {draft.logos.length === 0 ? (
          <Empty>Logo yok.</Empty>
        ) : (
          <div className="flex flex-wrap gap-3">
            {draft.logos.map((logo) => (
              <div key={logo.assetId} className="flex w-[148px] flex-col gap-1.5">
                <div
                  className={cn(
                    "relative flex h-24 items-center justify-center rounded-[10px] shadow-[inset_0_0_0_1px_var(--border-hairline)]",
                    logo.background === "dark" ? "bg-[#151515]" : "bg-white",
                  )}
                >
                  <ZoomableImage
                    image={{
                      assetId: logo.assetId,
                      background: logo.background === "dark" ? "#151515" : "#fff",
                    }}
                    label="Logoyu aç"
                    alt=""
                    className="absolute inset-0 flex items-center justify-center"
                    imgClassName="max-h-[70%] max-w-[80%] object-contain"
                  />
                  <RemoveButton
                    label="Logoyu kaldır"
                    onClick={() =>
                      change((d) => ({
                        ...d,
                        logos: d.logos.filter((l) => l.assetId !== logo.assetId),
                      }))
                    }
                  />
                </div>
                <select
                  aria-label="Zemin"
                  value={logo.background}
                  onChange={(e) =>
                    change((d) => ({
                      ...d,
                      logos: d.logos.map((l) =>
                        l.assetId === logo.assetId
                          ? { ...l, background: e.target.value as BrandKitLogoBackground }
                          : l,
                      ),
                    }))
                  }
                  className="h-6 rounded-full bg-field px-2 text-footnote text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none"
                >
                  <option value="any">Her zemin</option>
                  <option value="light">Açık zemin</option>
                  <option value="dark">Koyu zemin</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </KitSection>

      <KitSection
        title="Renkler"
        detail="Ad küçük harf ve tire ile (ana-vurgu); kullanım alanı isteğe bağlı."
        action={
          <Button
            size="sm"
            icon={<IconPlus size={12} strokeWidth={2} />}
            onClick={() =>
              change((d) => ({
                ...d,
                palette: [...d.palette, { name: nextColorName(d), hex: "#FF6A00" }],
              }))
            }
          >
            Renk ekle
          </Button>
        }
      >
        {draft.palette.length === 0 ? (
          <Empty>Renk yok.</Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] gap-x-6 gap-y-2">
            {draft.palette.map((color, index) => (
              <ColorRow
                key={index}
                name={color.name}
                hex={color.hex}
                use={color.use ?? ""}
                onChange={(next) =>
                  change((d) => ({
                    ...d,
                    palette: d.palette.map((c, i) => (i === index ? { ...c, ...next } : c)),
                  }))
                }
                onRemove={() =>
                  change((d) => ({ ...d, palette: d.palette.filter((_, i) => i !== index) }))
                }
              />
            ))}
          </div>
        )}
      </KitSection>

      <KitSection
        title="Yazı tipleri"
        detail="Mac'te yüklü yazı tipleri adıyla kullanılır; aynı ailenin dosyası, yüklü olmayan bir Mac için yedektir."
        action={
          <div className="flex items-center gap-2">
            <AddSystemFontButton
              fonts={draft.fonts}
              onChange={(fonts) => change((d) => ({ ...d, fonts }))}
            />
            <UploadButton
              label="Font yükle"
              accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
              onFiles={(f) => void uploadFiles(f, "font")}
            />
          </div>
        }
      >
        <KitFontList
          fonts={draft.fonts}
          fileName={fileName}
          onChange={(fonts) => change((d) => ({ ...d, fonts }))}
        />
      </KitSection>

      <KitSection
        title={`Örnek postlar · ${draft.samples.length}/${MAX_KIT_SAMPLES}`}
        detail={`AI analizi için en az ${MIN_KIT_SAMPLES} paylaşılmış post görseli; altına paylaşılan metni yazabilirsin.`}
        action={
          <UploadButton
            label="Görsel ekle"
            accept="image/png,image/jpeg,image/webp"
            onFiles={(f) => void uploadFiles(f, "image")}
          />
        }
      >
        {draft.samples.length === 0 ? (
          <Empty>Örnek post yok.</Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {draft.samples.map((sample) => (
              <div key={sample.assetId} className="flex flex-col gap-1.5">
                <div className="relative aspect-[4/5] overflow-hidden rounded-[10px] bg-control">
                  <ZoomableImage
                    image={{ assetId: sample.assetId }}
                    label="Örneği aç"
                    alt=""
                    loading="lazy"
                    className="block size-full"
                  />
                  <RemoveButton
                    label="Örneği kaldır"
                    onClick={() =>
                      change((d) => ({
                        ...d,
                        samples: d.samples.filter((s) => s.assetId !== sample.assetId),
                      }))
                    }
                  />
                </div>
                <textarea
                  aria-label="Paylaşılan metin"
                  rows={2}
                  placeholder="Paylaşılan metin"
                  value={sample.caption ?? ""}
                  onChange={(e) =>
                    change((d) => ({
                      ...d,
                      samples: d.samples.map((s) =>
                        s.assetId === sample.assetId ? { ...s, caption: e.target.value } : s,
                      ),
                    }))
                  }
                  className="selectable resize-none rounded-[8px] bg-field px-2 py-1 text-footnote text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3"
                />
              </div>
            ))}
          </div>
        )}
      </KitSection>

      <KitSection
        title="Notlar"
        detail="Markayı anlatan serbest notlar (hedef kitle, kaçınılacaklar …)."
      >
        <textarea
          aria-label="Notlar"
          rows={5}
          value={draft.notes}
          onChange={(e) => change((d) => ({ ...d, notes: e.target.value }))}
          className={cn(
            "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none",
            READING_WIDTH,
          )}
        />
      </KitSection>

      <SkillsSection brand={brand} />

      <ChecksSettingsSection brand={brand} />
    </div>
  );
}

function KitSection({
  title,
  detail,
  action,
  children,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-fg">{title}</h2>
          {detail && <p className="text-body text-fg-2">{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-body text-fg-3">{children}</p>;
}

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
    >
      <IconClose size={12} strokeWidth={2} />
    </button>
  );
}

function UploadButton({
  label,
  accept,
  onFiles,
}: {
  label: string;
  accept: string;
  onFiles(files: File[]): void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        size="sm"
        icon={<IconUpload size={12} strokeWidth={2} />}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );
}

function ColorRow({
  name,
  hex,
  use,
  onChange,
  onRemove,
}: {
  name: string;
  hex: string;
  use: string;
  onChange(next: { name?: string; hex?: string; use?: string }): void;
  onRemove(): void;
}) {
  const [hexText, setHexText] = useState(hex);
  useEffect(() => setHexText(hex), [hex]);
  return (
    <div className="flex items-center gap-2">
      <label
        className="relative size-7 shrink-0 overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--border-default)]"
        style={{ background: normalizedHex(hex) ?? "transparent" }}
        title="Renk seç"
      >
        <input
          type="color"
          aria-label="Renk seç"
          value={normalizedHex(hex)?.toLowerCase() ?? "#000000"}
          onChange={(e) => onChange({ hex: e.target.value.toUpperCase() })}
          className="absolute inset-0 cursor-default opacity-0"
        />
      </label>
      <TextField
        aria-label="Renk kodu"
        className="w-[110px] font-mono"
        value={hexText}
        invalid={!normalizedHex(hexText)}
        onChange={(e) => {
          setHexText(e.target.value);
          const normalized = normalizedHex(e.target.value);
          if (normalized) onChange({ hex: normalized });
        }}
      />
      <TextField
        aria-label="Renk adı"
        className="w-[150px]"
        value={name}
        onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
        onBlur={() => {
          const clean = colorName(name);
          if (clean && clean !== name) onChange({ name: clean });
        }}
      />
      <TextField
        aria-label="Kullanım"
        className="min-w-0 flex-1"
        placeholder="Kullanım (ana vurgu, zemin …)"
        value={use}
        onChange={(e) => onChange({ use: e.target.value })}
      />
      <IconButton
        icon={<IconClose size={14} strokeWidth={1.75} />}
        label="Rengi kaldır"
        onClick={onRemove}
      />
    </div>
  );
}

// --- Profil ------------------------------------------------------------------------------------------------

function ProfileTab({ brand, profiles }: { brand: Brand; profiles: BrandProfile[] }) {
  const actions = useBrandActions();
  const showToast = useAppStore((s) => s.showToast);
  const initial = cardProfile(profiles);
  const [version, setVersion] = useState<number | null>(initial?.version ?? null);
  const selected = profiles.find((p) => p.version === version) ?? initial;
  const [tokens, setTokens] = useState<Record<string, unknown>>(selected?.tokens ?? {});
  const [voice, setVoice] = useState(selected?.voice ?? "");
  const [rules, setRules] = useState(selected?.designRules ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different version (or a fresh copy from the server) resets the editor.
  const selectedKey = selected ? `${selected.version}:${selected.updatedAt}` : "";
  useEffect(() => {
    setTokens(selected?.tokens ?? {});
    setVoice(selected?.voice ?? "");
    setRules(selected?.designRules ?? "");
    setError(null);
  }, [selectedKey]);

  const rows = useMemo(() => tokenRows(tokens), [tokens]);

  if (!selected) {
    return (
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-body text-fg-2">
          Bu markanın profili yok. Marka kitine örnek postlar ekleyip “AI ile analiz et” ile bir
          taslak çıkarabilir ya da boş bir taslakla başlayabilirsin.
        </p>
        <div>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await actions.profiles.create(brand.id, {});
                setVersion(created.version);
              } catch (e) {
                setError(describeError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Boş taslak oluştur
          </Button>
        </div>
        {error && <p className="text-body text-danger">{error}</p>}
      </div>
    );
  }

  const isDraft = selected.status === "draft";
  const dirty =
    isDraft &&
    (JSON.stringify(tokens) !== JSON.stringify(selected.tokens) ||
      voice !== selected.voice ||
      rules !== selected.designRules);

  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      showToast({ message });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () =>
    actions.profiles.update(brand.id, selected.version, { tokens, voice, designRules: rules });

  return (
    <div className="flex flex-col gap-6 pt-1">
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Profil sürümü"
          value={selected.version}
          onChange={(e) => setVersion(Number(e.target.value))}
          className="h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none"
        >
          {profiles.map((p) => (
            <option key={p.version} value={p.version}>
              v{p.version} · {p.status === "approved" ? "Onaylı" : "Taslak"}
              {p.isCurrent ? " · güncel" : ""}
            </option>
          ))}
        </select>
        <span className="text-body text-fg-2">
          {isDraft
            ? "Taslak: düzenleyip onaylayınca postlar bu profille üretilir."
            : selected.isCurrent
              ? "Onaylı ve güncel; değiştirmek için yeni taslak aç."
              : "Eski bir onaylı sürüm."}
        </span>
        <div className="flex-1" />
        {isDraft ? (
          <>
            <Button
              disabled={!dirty || busy}
              onClick={() => void run(saveDraft, "Taslak kaydedildi.")}
            >
              Taslağı kaydet
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (dirty) await saveDraft();
                  await actions.profiles.approve(brand.id, selected.version);
                }, `v${selected.version} onaylandı.`)
              }
            >
              Onayla
            </Button>
          </>
        ) : (
          <>
            {!selected.isCurrent && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => actions.profiles.approve(brand.id, selected.version),
                    `v${selected.version} yeniden güncel.`,
                  )
                }
              >
                Güncel yap
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const created = await actions.profiles.create(brand.id, {
                    tokens: selected.tokens,
                    voice: selected.voice,
                    designRules: selected.designRules,
                  });
                  setVersion(created.version);
                }, "Yeni taslak açıldı.")
              }
            >
              Yeni taslak
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="text-body text-danger" role="alert">
          {error}
        </p>
      )}
      <TokenEditor
        rows={rows}
        editable={isDraft}
        onSet={(row, value) => {
          const next = setToken(tokens, row, value);
          if (!next.ok) return next.reason;
          setTokens(next.tokens);
          return null;
        }}
      />
      <section className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-fg">Ton ve ses</h2>
        <textarea
          aria-label="Ton ve ses"
          rows={8}
          readOnly={!isDraft}
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          className={cn(
            "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none read-only:text-fg-2",
            READING_WIDTH,
          )}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-heading font-semibold text-fg">Tasarım kuralları</h2>
        <textarea
          aria-label="Tasarım kuralları"
          rows={8}
          readOnly={!isDraft}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          className={cn(
            "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 font-mono text-mono text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none read-only:text-fg-2",
            READING_WIDTH,
          )}
        />
      </section>
    </div>
  );
}

function TokenEditor({
  rows,
  editable,
  onSet,
}: {
  rows: TokenRow[];
  editable: boolean;
  onSet(row: TokenRow, value: string): string | null;
}) {
  const groups = [...new Set(rows.map((r) => r.group))];
  if (rows.length === 0) return <p className="text-body text-fg-3">Profilde tasarım değeri yok.</p>;
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group} className="flex flex-col gap-1.5">
          <FieldLabel>{group}</FieldLabel>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-1.5">
            {rows
              .filter((r) => r.group === group)
              .map((row) => (
                <TokenField key={row.path.join(".")} row={row} editable={editable} onSet={onSet} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TokenField({
  row,
  editable,
  onSet,
}: {
  row: TokenRow;
  editable: boolean;
  onSet(row: TokenRow, value: string): string | null;
}) {
  const [text, setText] = useState(row.value);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(row.value), [row.value]);
  const commit = () => {
    if (text === row.value) return;
    const reason = onSet(row, text);
    setProblem(reason);
  };
  return (
    <div className="flex min-w-0 items-center gap-2" title={problem ?? row.note ?? undefined}>
      {row.kind === "color" && (
        <span
          className="size-5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border-default)]"
          style={{ background: normalizedHex(row.value) ?? "transparent" }}
        />
      )}
      <span className="w-[96px] shrink-0 truncate text-body text-fg-2">{row.label}</span>
      <TextField
        aria-label={row.label}
        className="min-w-0 flex-1"
        value={text}
        disabled={!editable}
        invalid={problem !== null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {row.note && row.kind === "number" && (
        <span className="text-footnote text-fg-3">{row.note}</span>
      )}
    </div>
  );
}

// --- Hesaplar ----------------------------------------------------------------------------------------------

function AccountsTab({ lines }: { lines: ReturnType<typeof brandCard>["platforms"] }) {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  return (
    <div className="flex flex-col">
      {lines.map((line) => (
        <div key={line.platform} className="flex h-12 items-center gap-3 border-b border-hairline">
          <span className="flex size-4 items-center justify-center text-icon">
            <PlatformIcon platform={line.platform} size={16} />
          </span>
          <span className="flex-1 text-body-lg text-fg">{PLATFORM_NAME[line.platform]}</span>
          <span
            className={cn(
              "text-body",
              line.needsOwner ? "text-accent-text" : line.connected ? "text-success" : "text-fg-3",
            )}
          >
            {line.value}
          </span>
        </div>
      ))}
      <div className="pt-4">
        <Button onClick={() => setSettingsOpen(true)}>Hesapları Ayarlar'da yönet</Button>
      </div>
    </div>
  );
}
