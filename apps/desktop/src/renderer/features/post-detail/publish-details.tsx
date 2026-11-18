// "Yayın ayrıntıları" (N13): first comment, alternative texts (filled from the slides, editable),
// location, collaborators, people tags (a click on the picture sets the spot), the Reels cover and
// "Akışta da göster". Only the fields the post's platforms take are shown. Saving does not revoke
// the approval; a publishing or published post shows them read only.
import {
  type Content,
  type KnownLocation,
  PUBLISH_DETAIL_LIMITS,
  type PublishDetails,
  readReelVersionInfo,
  type Slide,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  SegmentedControl,
  Switch,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { IconChevronDown, IconChevronRight, IconClose } from "../../components/ui/icons.tsx";
import { assetUrl, describeError, useApi } from "../../lib/api.ts";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { useAppStore } from "../../state/app-store.ts";
import { storeContent } from "../posts/data.ts";
import { isLocked } from "./editor.ts";
import {
  anyField,
  autoAltTexts,
  commentUsage,
  detailFields,
  detailsPayload,
  detailsSummary,
  editAltText,
  issueLines,
  normalizeUsername,
  parseUsernames,
  publishKinds,
  sameDetails,
  secondsLabel,
  tagPosition,
  tagsHavePositions,
} from "./publish-details-model.ts";

const FIELD =
  "selectable w-full resize-none rounded-[10px] bg-field px-3 py-2 text-body text-fg outline-none shadow-[inset_0_0_0_1px_var(--border-hairline)] placeholder:text-fg-3 disabled:opacity-60";

const LOCATION_NOTE =
  "Instagram'da konum bir Facebook sayfasıdır. Bütün yerleri aramak Meta'nın ek iznini istiyor; bu yüzden yer, Facebook sayfasının kimliğiyle (sayfanın Hakkında bölümündeki rakamlar) eklenir.";

export const publishDetailKeys = {
  locations: (brandId: string) => ["publish-details", "locations", brandId] as const,
  images: (brandId: string) => ["publish-details", "images", brandId] as const,
};

function Label({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-footnote font-medium text-fg-2">{children}</span>
      {hint && <span className="text-footnote text-fg-3">{hint}</span>}
    </div>
  );
}

function SlideThumb({
  slide,
  index,
  width = 56,
  selected,
  onClick,
}: {
  slide: Slide;
  index: number;
  width?: number;
  selected?: boolean;
  onClick?: () => void;
}) {
  const ratio = slide.width && slide.height ? slide.height / slide.width : 1.25;
  const body = slide.renderedAssetId ? (
    <img
      src={thumbUrl(slide.renderedAssetId, width)}
      alt=""
      draggable={false}
      className="size-full object-cover"
    />
  ) : (
    <span className="flex size-full items-center justify-center text-footnote text-fg-3">
      {index + 1}
    </span>
  );
  const className = cn(
    "shrink-0 overflow-hidden rounded-[6px] bg-control shadow-[inset_0_0_0_1px_var(--border-hairline)]",
    selected && "outline outline-2 outline-accent",
  );
  return onClick ? (
    <button
      type="button"
      aria-label={`${index + 1}. kare`}
      aria-pressed={selected}
      className={className}
      style={{ width, height: Math.round(width * ratio) }}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <span className={className} style={{ width, height: Math.round(width * ratio) }}>
      {body}
    </span>
  );
}

export function PublishDetailsSection({
  content,
  slides,
  onSaved,
  collapsible = false,
  defaultOpen = true,
}: {
  content: Content;
  /** The current version's slides (alternative texts, people tags, the Reels duration). */
  slides: readonly Slide[];
  onSaved?: (content: Content) => void;
  /** Starts folded with a one-line summary (the schedule sheet). */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const slideCount = Math.max(slides.length, 1);
  const kinds = useMemo(() => publishKinds(content, slideCount), [content, slideCount]);
  const fields = useMemo(() => detailFields(kinds), [kinds]);
  const locked = isLocked(content);
  const stored = content.publishDetails ?? null;
  const storedKey = JSON.stringify(stored ?? {});
  const fill = (d: PublishDetails) =>
    fields.altText && !locked && slides.length ? autoAltTexts(d, slides) : d;
  const [draft, setDraft] = useState<PublishDetails>(() => fill(stored ?? {}));
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !sameDetails(draft, stored);

  // The stored details changed elsewhere (chat, the other view): start from them again.
  const lastStored = useRef(storedKey);
  useEffect(() => {
    if (lastStored.current === storedKey) return;
    lastStored.current = storedKey;
    setDraft(fill(stored ?? {}));
  }, [storedKey]);
  // Slides arrive (or change): fill the alternative texts nobody wrote.
  const slidesKey = slides.map((s) => s.html.length).join(",");
  useEffect(() => {
    if (!fields.altText || locked || slides.length === 0) return;
    setDraft((d) => autoAltTexts(d, slides));
  }, [slidesKey, fields.altText, locked]);

  if (!anyField(fields)) return null;

  const update = (patch: Partial<PublishDetails>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const fresh = await api.contents.setPublishDetails(content.id, detailsPayload(draft));
      storeContent(queryClient, fresh);
      lastStored.current = JSON.stringify(fresh.publishDetails ?? {});
      setDraft(fresh.publishDetails ?? {});
      onSaved?.(fresh);
      showToast({ message: "Yayın ayrıntıları kaydedildi." });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  const issues = issueLines(
    draft,
    kinds,
    slideCount,
    content.type === "reel" && slides[0] ? readReelVersionInfo(slides[0].html).durationMs : null,
  );
  const blocking = issues.some((i) => i.tone === "danger");

  const header = (
    <div className="flex items-center gap-2">
      {collapsible ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span className="text-body font-medium text-fg">Yayın ayrıntıları</span>
          {!open && (
            <span className="min-w-0 truncate text-footnote text-fg-3">
              {detailsSummary(stored, fields)}
            </span>
          )}
        </button>
      ) : (
        <h3 className="min-w-0 flex-1 text-body font-medium text-fg">Yayın ayrıntıları</h3>
      )}
      {dirty && !locked && <TagPill tone="warning">Kaydedilmedi</TagPill>}
    </div>
  );

  return (
    <section
      aria-label="Yayın ayrıntıları"
      className="flex flex-col gap-3 rounded-[12px] p-3.5 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
    >
      {header}
      {open && (
        <>
          {locked && (
            <p className="text-footnote text-fg-2">
              Post yayınlandı ya da yayınlanıyor; yayın ayrıntıları artık değiştirilemez.
            </p>
          )}
          {fields.firstComment && (
            <FirstComment
              value={draft.firstComment ?? ""}
              kinds={kinds}
              disabled={locked}
              onChange={(firstComment) => update({ firstComment })}
            />
          )}
          {fields.altText && slides.length > 0 && (
            <AltTexts draft={draft} slides={slides} disabled={locked} onChange={setDraft} />
          )}
          {fields.location && (
            <LocationField
              brandId={content.brandId}
              value={draft.location ?? null}
              disabled={locked}
              onChange={(location) => update({ location })}
            />
          )}
          {fields.collaborators && (
            <Collaborators
              value={draft.collaborators ?? []}
              disabled={locked}
              onChange={(collaborators) => update({ collaborators })}
            />
          )}
          {fields.userTags && (
            <PeopleTags
              tags={draft.userTags ?? []}
              slides={slides}
              positions={tagsHavePositions(kinds)}
              disabled={locked}
              onChange={(userTags) => update({ userTags })}
            />
          )}
          {fields.reelCover && (
            <ReelCoverField
              brandId={content.brandId}
              value={draft.reelCover ?? null}
              durationMs={slides[0] ? readReelVersionInfo(slides[0].html).durationMs : null}
              disabled={locked}
              onChange={(reelCover) => update({ reelCover })}
            />
          )}
          {fields.shareToFeed && (
            <div className="flex items-center gap-2">
              <Switch
                label="Akışta da göster"
                checked={draft.shareToFeed !== false}
                disabled={locked}
                onChange={(on) => update({ shareToFeed: on })}
              />
              <span className="text-body text-fg">Akışta da göster</span>
              <span className="text-footnote text-fg-3">Reels profil ızgarasında da görünür.</span>
            </div>
          )}
          {issues.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {issues.map((i) => (
                <li
                  key={i.text}
                  className={cn("text-footnote", i.tone === "danger" ? "text-danger" : "text-fg-2")}
                >
                  {i.tone === "danger" ? "✕" : "!"} {i.text}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="selectable text-footnote text-danger">
              {error}
            </p>
          )}
          {!locked && (
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-footnote text-fg-3">Onayı değiştirmez.</span>
              <Button
                size="sm"
                variant="secondary"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(stored ?? {});
                  setError(null);
                }}
              >
                Geri al
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!dirty || saving || blocking}
                onClick={() => void save()}
              >
                {saving ? "Kaydediliyor…" : "Kaydet"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// --- fields -----------------------------------------------------------------------------------

function FirstComment({
  value,
  kinds,
  disabled,
  onChange,
}: {
  value: string;
  kinds: ReturnType<typeof publishKinds>;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const usage = commentUsage(value, kinds);
  return (
    <div className="flex flex-col gap-1.5">
      <Label hint={<span className={usage.over ? "text-danger" : undefined}>{usage.label}</span>}>
        İlk yorum
      </Label>
      <textarea
        aria-label="İlk yorum"
        className={FIELD}
        rows={2}
        placeholder="Yayından hemen sonra postun altına yazılır (ör. etiketler)"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function AltTexts({
  draft,
  slides,
  disabled,
  onChange,
}: {
  draft: PublishDetails;
  slides: readonly Slide[];
  disabled: boolean;
  onChange(d: PublishDetails): void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        hint={
          !disabled && (
            <button
              type="button"
              className="text-accent-text hover:underline"
              onClick={() => onChange(autoAltTexts(draft, slides, { force: true }))}
            >
              Karelerden yeniden doldur
            </button>
          )
        }
      >
        Alternatif metin
      </Label>
      {slides.map((slide, i) => {
        const text = draft.altTexts?.[i] ?? "";
        const auto = draft.altTextSources?.[i] === "auto";
        return (
          <div key={i} className="flex items-start gap-2">
            <SlideThumb slide={slide} index={i} width={40} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <textarea
                aria-label={`${i + 1}. karenin alternatif metni`}
                className={FIELD}
                rows={2}
                maxLength={PUBLISH_DETAIL_LIMITS.altText}
                placeholder="Görselde ne var? Kısaca anlat."
                value={text}
                disabled={disabled}
                onChange={(e) => onChange(editAltText(draft, i, e.target.value))}
              />
              {auto && text && (
                <span className="text-footnote text-fg-3">
                  Karedeki yazıdan dolduruldu; düzenleyebilirsin.
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LocationField({
  brandId,
  value,
  disabled,
  onChange,
}: {
  brandId: string;
  value: PublishDetails["location"] | null;
  disabled: boolean;
  onChange(location: PublishDetails["location"] | null): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const known = useQuery({
    queryKey: publishDetailKeys.locations(brandId),
    queryFn: async (): Promise<KnownLocation[]> => (await api.publishLocations.list(brandId)).items,
    staleTime: 60_000,
  });
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = known.data ?? [];
  const options =
    value && !list.some((l) => l.id === value.id)
      ? [{ ...value, source: "used" as const, lastUsedAt: null }, ...list]
      : list;
  const add = async () => {
    const cleanId = id.replace(/\D/g, "");
    if (!cleanId || !name.trim()) {
      setError("Sayfa kimliği (rakam) ve ad gerekli.");
      return;
    }
    try {
      const res = await api.publishLocations.add(brandId, { id: cleanId, name: name.trim() });
      queryClient.setQueryData(publishDetailKeys.locations(brandId), res.items);
      onChange({ id: cleanId, name: name.trim() });
      setAdding(false);
      setId("");
      setName("");
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Konum</Label>
      <div className="flex items-center gap-2">
        <select
          aria-label="Konum"
          className="h-7 min-w-0 flex-1 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] disabled:opacity-60"
          value={value?.id ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const picked = options.find((l) => l.id === e.target.value);
            onChange(picked ? { id: picked.id, name: picked.name } : null);
          }}
        >
          <option value="">Konum yok</option>
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.source === "page" ? " (markanın sayfası)" : ""}
            </option>
          ))}
        </select>
        {!disabled && !adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Elle ekle
          </Button>
        )}
      </div>
      {adding && (
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-control/40 p-2">
          <p className="text-footnote text-fg-2">{LOCATION_NOTE}</p>
          <div className="flex items-center gap-2">
            <TextField
              aria-label="Facebook sayfa kimliği"
              placeholder="Sayfa kimliği"
              inputMode="numeric"
              className="w-[140px]"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <TextField
              aria-label="Konum adı"
              placeholder="Ad (ör. Konya Ovası)"
              className="min-w-0 flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <span className="text-footnote text-danger">{error}</span>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Vazgeç
            </Button>
            <Button size="sm" variant="primary" onClick={() => void add()}>
              Ekle
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Collaborators({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange(list: string[]): void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const max = PUBLISH_DETAIL_LIMITS.collaborators;
  const add = () => {
    const { usernames, invalid } = parseUsernames(text);
    const next = [...new Set([...value, ...usernames])];
    if (invalid.length) setError(`Geçersiz kullanıcı adı: ${invalid.join(", ")}`);
    else if (next.length > max) setError(`En fazla ${max} ortak hesap eklenebilir.`);
    else setError(null);
    onChange(next.slice(0, max));
    if (!invalid.length) setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label hint={`${value.length}/${max}`}>Ortak paylaşım</Label>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((u) => (
            <span
              key={u}
              className="inline-flex items-center gap-1 rounded-full bg-control px-2 py-0.5 text-footnote text-fg"
            >
              @{u}
              {!disabled && (
                <IconButton
                  icon={<IconClose size={10} />}
                  label={`@${u} kaldır`}
                  size={24}
                  tooltip={false}
                  onClick={() => onChange(value.filter((x) => x !== u))}
                />
              )}
            </span>
          ))}
        </div>
      )}
      {!disabled && value.length < max && (
        <div className="flex items-center gap-2">
          <TextField
            aria-label="Ortak hesap"
            placeholder="@kullaniciadi"
            className="min-w-0 flex-1"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button size="sm" variant="secondary" disabled={!text.trim()} onClick={add}>
            Ekle
          </Button>
        </div>
      )}
      {error && <span className="text-footnote text-danger">{error}</span>}
      <span className="text-footnote text-fg-3">
        Davet edilen hesap kabul ederse post onun profilinde de görünür.
      </span>
    </div>
  );
}

function PeopleTags({
  tags,
  slides,
  positions,
  disabled,
  onChange,
}: {
  tags: NonNullable<PublishDetails["userTags"]>;
  slides: readonly Slide[];
  positions: boolean;
  disabled: boolean;
  onChange(tags: NonNullable<PublishDetails["userTags"]>): void;
}) {
  const [slide, setSlide] = useState(0);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = slides[slide] ?? null;
  const add = () => {
    const username = normalizeUsername(name);
    if (!username) {
      setError("Geçerli bir Instagram kullanıcı adı yazın.");
      return;
    }
    if (positions && !spot) {
      setError("Önce görselde kişinin yerine tıklayın.");
      return;
    }
    const at = positions ? slide : 0;
    const onSlide = tags.filter((t) => t.slide === at);
    if (onSlide.length >= PUBLISH_DETAIL_LIMITS.userTagsPerSlide) {
      setError(
        `Bir görselde en fazla ${PUBLISH_DETAIL_LIMITS.userTagsPerSlide} kişi etiketlenebilir.`,
      );
      return;
    }
    const tag = { slide: at, username, x: spot?.x ?? 0.5, y: spot?.y ?? 0.5 };
    onChange([...tags.filter((t) => !(t.slide === at && t.username === username)), tag]);
    setName("");
    setSpot(null);
    setError(null);
  };
  const shown = positions ? tags.filter((t) => t.slide === slide) : tags;
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        hint={positions ? "Görselde kişinin yerine tıklayın" : "Reels'te yalnızca kullanıcı adı"}
      >
        Kişi etiketleri
      </Label>
      {positions && slides.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {slides.map((s, i) => (
            <SlideThumb
              key={i}
              slide={s}
              index={i}
              width={36}
              selected={i === slide}
              onClick={() => {
                setSlide(i);
                setSpot(null);
              }}
            />
          ))}
        </div>
      )}
      {positions && current && (
        <div className="relative self-start">
          <button
            type="button"
            aria-label={`${slide + 1}. karede etiket yeri seç`}
            disabled={disabled}
            className="block overflow-hidden rounded-[8px] bg-control"
            style={{
              width: 200,
              height: Math.round(200 * ((current.height || 1350) / (current.width || 1080))),
            }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setSpot(tagPosition(rect, e.clientX, e.clientY));
            }}
          >
            {current.renderedAssetId && (
              <img
                src={assetUrl(current.renderedAssetId)}
                alt=""
                draggable={false}
                className="size-full object-cover"
              />
            )}
          </button>
          {[
            ...shown.map((t) => ({ key: t.username, x: t.x, y: t.y, label: `@${t.username}` })),
            ...(spot ? [{ key: "_new", x: spot.x, y: spot.y, label: "Yeni" }] : []),
          ].map((m) => (
            <span
              key={m.key}
              className={cn(
                "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 text-[10px] leading-4 text-white",
                m.key === "_new" ? "bg-accent" : "bg-black/70",
              )}
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="flex items-center gap-2">
          <TextField
            aria-label="Etiketlenecek kişi"
            placeholder="@kullaniciadi"
            className="min-w-0 flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button size="sm" variant="secondary" disabled={!name.trim()} onClick={add}>
            Etiketle
          </Button>
        </div>
      )}
      {error && <span className="text-footnote text-danger">{error}</span>}
      {tags.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {tags.map((t) => (
            <li key={`${t.slide}:${t.username}`} className="flex items-center gap-2 text-body">
              <span className="min-w-0 flex-1 truncate text-fg">
                @{t.username}
                <span className="text-fg-3">{positions ? ` · ${t.slide + 1}. kare` : ""}</span>
              </span>
              {!disabled && (
                <IconButton
                  icon={<IconClose size={11} />}
                  label={`@${t.username} etiketini kaldır`}
                  size={24}
                  tooltip={false}
                  onClick={() =>
                    onChange(
                      tags.filter((x) => !(x.slide === t.slide && x.username === t.username)),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type CoverMode = "none" | "frame" | "image";

function ReelCoverField({
  brandId,
  value,
  durationMs,
  disabled,
  onChange,
}: {
  brandId: string;
  value: PublishDetails["reelCover"] | null;
  durationMs: number | null;
  disabled: boolean;
  onChange(cover: PublishDetails["reelCover"] | null): void;
}) {
  const api = useApi();
  const [pickImage, setPickImage] = useState(value?.kind === "image");
  const mode: CoverMode = value ? value.kind : pickImage ? "image" : "none";
  const images = useQuery({
    queryKey: publishDetailKeys.images(brandId),
    queryFn: async () => (await api.assets.list({ brandId, kind: "image", limit: 40 })).items,
    enabled: mode === "image" && !disabled,
    staleTime: 30_000,
  });
  const max = durationMs ?? 90_000;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Reels kapağı</Label>
      <SegmentedControl<CoverMode>
        className="self-start"
        label="Reels kapağı"
        value={mode}
        onChange={(m) => {
          if (disabled) return;
          setPickImage(m === "image");
          if (m === "frame")
            onChange({ kind: "frame", offsetMs: value?.kind === "frame" ? value.offsetMs : 500 });
          else if (m === "none" || value?.kind === "frame") onChange(null);
        }}
        options={[
          { value: "none", label: "Varsayılan" },
          { value: "frame", label: "Videodan kare" },
          { value: "image", label: "Görsel" },
        ]}
      />
      {value?.kind === "frame" && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Kapak karesi"
            min={0}
            max={max}
            step={100}
            disabled={disabled}
            value={Math.min(value.offsetMs, max)}
            onChange={(e) => onChange({ kind: "frame", offsetMs: Number(e.target.value) })}
            className="min-w-0 flex-1"
          />
          <span className="w-14 text-right text-footnote text-fg-2 tabular-nums">
            {secondsLabel(value.offsetMs)}
          </span>
        </div>
      )}
      {mode === "image" && (
        <>
          <div className="grid grid-cols-6 gap-1.5">
            {(images.data ?? []).map((a) => (
              <button
                key={a.id}
                type="button"
                aria-label={a.originalFilename ?? "Görsel"}
                aria-pressed={value?.kind === "image" && value.assetId === a.id}
                disabled={disabled}
                className={cn(
                  "aspect-[9/16] overflow-hidden rounded-[6px] bg-control",
                  value?.kind === "image" &&
                    value.assetId === a.id &&
                    "outline outline-2 outline-accent",
                )}
                onClick={() => onChange({ kind: "image", assetId: a.id })}
              >
                <img src={thumbUrl(a.id, 60)} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
          {images.data?.length === 0 && (
            <span className="text-footnote text-fg-3">Markanın medyasında görsel yok.</span>
          )}
          <span className="text-footnote text-fg-3">
            Kapak görseli bulut yayıncıyla gönderilir; Mac'ten yayında videonun karesi kullanılır.
          </span>
        </>
      )}
    </div>
  );
}
