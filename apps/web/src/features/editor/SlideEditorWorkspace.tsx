import type { Content, ContentVersionSummary, Slide } from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../../api.ts";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconLayers,
  IconRedo,
  IconShield,
  IconSparkle,
  IconUndo,
} from "../../components/icons.tsx";
import { EmptyState, ErrorState, InlineError, Notice } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Field,
  FilterSelect,
  IconButton,
  Input,
  Mono,
  SectionTitle,
  Segmented,
  Textarea,
} from "../../components/ui.tsx";
import { contentCapabilities } from "../../lib/content-status.ts";
import { formatRelative } from "../../lib/datetime.ts";
import { VERSION_ORIGIN_LABELS } from "../../lib/labels.ts";
import {
  clearSlideSlot,
  collectSlotAssignments,
  createHistory,
  type EditorHistory,
  fillSlideSlot,
  LAYER_KIND_LABELS,
  moveSlideLayer,
  type ParsedLayer,
  parseSlideLayers,
  pushHistory,
  redoHistory,
  reorderSlideLayer,
  replacePresent,
  resizeSlideLayer,
  setSlideArtboardSize,
  undoHistory,
  updateSlideLayerStyle,
  updateSlideLayerText,
} from "../../lib/layers.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import {
  buildEditorSlideSrcdoc,
  describeArtboard,
  extractSlideAssetRefs,
  fitScale,
  SLIDE_SANDBOX,
  stepIndex,
} from "../../lib/slide-preview.ts";
import { generatePayload } from "../contents/generate.ts";
import { useContentCacheUpdate, useContentVersion } from "../contents/hooks.ts";
import { SlotFillDialog } from "./SlotFillDialog.tsx";

export interface EditableSlide {
  html: string;
  width: number;
  height: number;
  renderedAssetId: string | null;
}

const FONT_PRESETS = [
  { label: "Marka Başlık (--font-display)", value: "var(--font-display)" },
  { label: "Marka Metin (--font-text)", value: "var(--font-text)" },
  { label: "Instrument Serif", value: '"Instrument Serif", Georgia, serif' },
  { label: "Geist Sans", value: '"Geist Variable", sans-serif' },
  { label: "Geist Mono", value: '"Geist Mono Variable", monospace' },
  { label: "Inter", value: "Inter, sans-serif" },
];

const ARTBOARD_PRESETS = [
  { key: "1080x1350", label: "4:5 Post (1080×1350)", width: 1080, height: 1350 },
  { key: "1080x1080", label: "1:1 Kare (1080×1080)", width: 1080, height: 1080 },
  { key: "1080x1920", label: "9:16 Story/Reels (1080×1920)", width: 1080, height: 1920 },
] as const;

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || undefined);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Resolve `/media/<id>` and `/api/assets/<id>/content` into `blob:` URLs for the sandboxed iframe. */
function useResolvedAssetBlobs(
  slides: ReadonlyArray<EditableSlide>,
  localBlobs: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const api = useApi();
  const [fetched, setFetched] = useState<Map<string, string>>(() => new Map());

  const allRefs = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of slides) {
      for (const ref of extractSlideAssetRefs(s.html)) {
        map.set(ref.rawUrl, ref.assetId);
      }
    }
    return map;
  }, [slides]);

  useEffect(() => {
    if (typeof fetch !== "function" || typeof URL.createObjectURL !== "function") return;
    let alive = true;
    for (const [rawUrl, assetId] of allRefs) {
      if (localBlobs.has(rawUrl) || fetched.has(rawUrl)) continue;
      const targetUrl = api.assets.contentUrl(assetId);
      void fetch(targetUrl)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (!alive || !blob) return;
          const objectUrl = URL.createObjectURL(blob);
          setFetched((prev) => {
            const next = new Map(prev);
            next.set(rawUrl, objectUrl);
            return next;
          });
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [allRefs, api, fetched, localBlobs]);

  return useMemo(() => {
    const merged = new Map(fetched);
    for (const [k, v] of localBlobs) merged.set(k, v);
    return merged;
  }, [fetched, localBlobs]);
}

function toEditableSlides(slides: ReadonlyArray<Slide>): EditableSlide[] {
  return slides.map((s) => ({
    html: s.html,
    width: s.width,
    height: s.height,
    renderedAssetId: s.renderedAssetId,
  }));
}

export function SlideEditorWorkspace({ content }: { content: Content }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const updateCache = useContentCacheUpdate();
  const caps = contentCapabilities(content);

  const currentNo = content.currentVersion?.version ?? null;
  const [selectedVersion, setSelectedVersion] = useState<number | null>(currentNo);
  const [slideIndex, setSlideIndex] = useState(0);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [slotDialogLayer, setSlotDialogLayer] = useState<ParsedLayer | null>(null);
  const [versionNote, setVersionNote] = useState("");
  const [aiInstructions, setAiInstructions] = useState("");
  const [localBlobs, setLocalBlobs] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    setSelectedVersion(currentNo);
  }, [currentNo]);

  const versions = useQuery({
    queryKey: queryKeys.contents.versions(content.id),
    queryFn: ({ signal }) => api.contents.versions.list(content.id, { limit: 100 }, { signal }),
  });

  const versionQuery = useContentVersion(content.id, selectedVersion);
  const summary = versions.data?.items.find((v) => v.version === selectedVersion);

  const [history, setHistory] = useState<EditorHistory<EditableSlide[]>>(() => createHistory([]));
  const baselineJsonRef = useRef<string>("[]");

  // Reset editor history whenever a new version's slides finish loading
  useEffect(() => {
    if (!versionQuery.data) return;
    const initial = toEditableSlides(versionQuery.data.slides);
    baselineJsonRef.current = JSON.stringify(
      initial.map((s) => ({ html: s.html, width: s.width, height: s.height })),
    );
    setHistory(createHistory(initial));
    setSlideIndex((idx) => Math.min(idx, Math.max(0, initial.length - 1)));
    setSelectedLayerId(null);
    setInlineEditingId(null);
  }, [versionQuery.data]);

  const slides = history.present;
  const count = slides.length;
  const currentSlide = slides[Math.min(slideIndex, Math.max(0, count - 1))];

  const isDirty = useMemo(() => {
    if (slides.length === 0) return false;
    const nowJson = JSON.stringify(
      slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
    );
    return nowJson !== baselineJsonRef.current;
  }, [slides]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);

  const handleUndo = useCallback(() => {
    coalesceRef.current = null;
    setHistory((h) => undoHistory(h));
  }, []);

  const handleRedo = useCallback(() => {
    coalesceRef.current = null;
    setHistory((h) => redoHistory(h));
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

  const parsed = useMemo(
    () =>
      currentSlide
        ? parseSlideLayers(currentSlide.html, {
            width: currentSlide.width,
            height: currentSlide.height,
          })
        : { artboard: { width: 1080, height: 1350 }, layers: [] },
    [currentSlide],
  );

  const selectedLayer = useMemo(
    () => parsed.layers.find((l) => l.id === selectedLayerId) ?? null,
    [parsed.layers, selectedLayerId],
  );

  const emptySlotsCount = useMemo(
    () =>
      slides.reduce((sum, s) => {
        const p = parseSlideLayers(s.html, { width: s.width, height: s.height });
        return sum + p.layers.filter((l) => l.type === "slot" && l.slotState === "empty").length;
      }, 0),
    [slides],
  );

  const applySlideEdit = useCallback(
    (updater: (slide: EditableSlide) => EditableSlide, commit = true, coalesceKey?: string) => {
      const now = Date.now();
      const shouldCoalesce =
        Boolean(coalesceKey) &&
        coalesceRef.current?.key === coalesceKey &&
        now - (coalesceRef.current?.at ?? 0) < 1500;
      coalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;

      setHistory((h) => {
        const idx = Math.min(slideIndex, Math.max(0, h.present.length - 1));
        const target = h.present[idx];
        if (!target) return h;
        const updated = updater(target);
        if (
          updated.html === target.html &&
          updated.width === target.width &&
          updated.height === target.height
        ) {
          return h;
        }
        const nextSlides = h.present.map((s, i) => (i === idx ? updated : s));
        if (!commit) return replacePresent(h, nextSlides);
        if (shouldCoalesce && h.past.length > 0 && h.future.length === 0) {
          return replacePresent(h, nextSlides);
        }
        return pushHistory(h, nextSlides);
      });
    },
    [slideIndex],
  );

  const resolvedBlobs = useResolvedAssetBlobs(slides, localBlobs);
  const [stageRef, measuredWidth] = useElementWidth<HTMLDivElement>();
  const scale = currentSlide
    ? fitScale(currentSlide, {
        ...(measuredWidth !== undefined ? { width: measuredWidth } : {}),
        height: 640,
      })
    : 0;

  const srcDoc = useMemo(
    () => (currentSlide ? buildEditorSlideSrcdoc(currentSlide.html, resolvedBlobs) : ""),
    [currentSlide, resolvedBlobs],
  );

  // Drag / Resize gesture state
  const dragRef = useRef<{
    mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";
    layerId: string;
    startClientX: number;
    startClientY: number;
    startSlides: EditableSlide[];
    startBounds: ParsedLayer["bounds"];
    moved: boolean;
  } | null>(null);

  const startGesture = (
    e: ReactPointerEvent<HTMLElement>,
    layer: ParsedLayer,
    mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se",
  ) => {
    if (!caps.canAddVersion || inlineEditingId === layer.id) return;
    e.stopPropagation();
    setSelectedLayerId(layer.id);
    dragRef.current = {
      mode,
      layerId: layer.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startSlides: history.present,
      startBounds: { ...layer.bounds },
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onStagePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = dragRef.current;
    if (!g || scale <= 0) return;
    const dx = (e.clientX - g.startClientX) / scale;
    const dy = (e.clientY - g.startClientY) / scale;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !g.moved) return;
    g.moved = true;

    const idx = Math.min(slideIndex, Math.max(0, g.startSlides.length - 1));
    const baseSlide = g.startSlides[idx];
    if (!baseSlide) return;

    let patchedHtml = baseSlide.html;
    if (g.mode === "move") {
      patchedHtml = moveSlideLayer(baseSlide.html, g.layerId, { dx, dy });
    } else {
      const b = g.startBounds;
      let nx = b.x;
      let ny = b.y;
      let nw = b.width;
      let nh = b.height;
      if (g.mode === "resize-se") {
        nw = Math.max(32, b.width + dx);
        nh = Math.max(32, b.height + dy);
      } else if (g.mode === "resize-sw") {
        nx = b.x + dx;
        nw = Math.max(32, b.width - dx);
        nh = Math.max(32, b.height + dy);
      } else if (g.mode === "resize-ne") {
        ny = b.y + dy;
        nw = Math.max(32, b.width + dx);
        nh = Math.max(32, b.height - dy);
      } else if (g.mode === "resize-nw") {
        nx = b.x + dx;
        ny = b.y + dy;
        nw = Math.max(32, b.width - dx);
        nh = Math.max(32, b.height - dy);
      }
      patchedHtml = resizeSlideLayer(baseSlide.html, g.layerId, {
        x: nx,
        y: ny,
        width: nw,
        height: nh,
      });
    }

    const nextSlides = g.startSlides.map((s, i) => (i === idx ? { ...s, html: patchedHtml } : s));
    setHistory((h) => replacePresent(h, nextSlides));
  };

  const endGesture = () => {
    const g = dragRef.current;
    dragRef.current = null;
    if (!g?.moved) return;
    setHistory((h) => ({
      past: [...h.past, g.startSlides].slice(-50),
      present: h.present,
      future: [],
    }));
  };

  // Save edits as a new ContentVersion (`manual_edit`)
  const saveVersion = useMutation({
    mutationFn: async () => {
      const created = await api.contents.versions.create(content.id, {
        origin: "manual_edit",
        slides: slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
        ...(versionNote.trim() ? { note: versionNote.trim() } : {}),
      });
      const refreshedContent = await api.contents.get(content.id);
      return { created, refreshedContent };
    },
    onSuccess: ({ created, refreshedContent }) => {
      setVersionNote("");
      baselineJsonRef.current = JSON.stringify(
        slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
      );
      qc.setQueryData(queryKeys.contents.version(content.id, created.version), created);
      updateCache(refreshedContent);
      setSelectedVersion(created.version);
      toast.success(`Sürüm v${created.version} kaydedildi`);
    },
    onError: (e) => toast.error(e, "Yeni sürüm kaydedilemedi"),
  });

  // Trigger `content.render` (JPEG or LinkedIn PDF carousel)
  const triggerRender = useMutation({
    mutationFn: async (format: "jpeg" | "pdf") => {
      let targetVersion = selectedVersion ?? currentNo ?? 1;
      if (isDirty && caps.canAddVersion) {
        const saved = await api.contents.versions.create(content.id, {
          origin: "manual_edit",
          slides: slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
          note: "Render öncesi otomatik kayıt",
        });
        targetVersion = saved.version;
        const refreshed = await api.contents.get(content.id);
        updateCache(refreshed);
        setSelectedVersion(saved.version);
      }
      const slotAssignments = collectSlotAssignments(slides);
      return api.jobs.create({
        type: "content.render",
        brandId: content.brandId,
        contentId: content.id,
        payload: {
          version: targetVersion,
          format,
          ...(Object.keys(slotAssignments).length > 0 ? { slotAssignments } : {}),
        },
      });
    },
    onSuccess: (_job, format) => {
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success(
        format === "pdf"
          ? "LinkedIn PDF Carousel render kuyruğa alındı"
          : "JPEG render kuyruğa alındı",
        "Mac worker çıktıyı hazırlayıp R2'ye yükleyecek.",
      );
    },
    onError: (e) => toast.error(e, "Render işi başlatılamadı"),
  });

  // "Prompt ile düzelt": preserve manual edits by saving dirty state as baseVersion first!
  const promptFix = useMutation({
    mutationFn: async () => {
      let baseVersion = selectedVersion ?? currentNo ?? undefined;
      if (isDirty && caps.canAddVersion) {
        const saved = await api.contents.versions.create(content.id, {
          origin: "manual_edit",
          slides: slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
          note: "Prompt ile düzeltme öncesi elle düzenlemeler",
        });
        baseVersion = saved.version;
        baselineJsonRef.current = JSON.stringify(
          slides.map((s) => ({ html: s.html, width: s.width, height: s.height })),
        );
        const refreshed = await api.contents.get(content.id);
        updateCache(refreshed);
        setSelectedVersion(saved.version);
      }
      return api.jobs.create({
        type: "content.generate",
        brandId: content.brandId,
        contentId: content.id,
        payload: {
          ...generatePayload(content),
          ...(baseVersion !== undefined ? { baseVersion } : {}),
          instructions: aiInstructions.trim(),
        },
      });
    },
    onSuccess: () => {
      setAiInstructions("");
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success(
        "AI düzeltme işi kuyruğa eklendi",
        "Elle yaptığınız değişiklikler baseVersion olarak korundu.",
      );
    },
    onError: (e) => toast.error(e, "Prompt ile düzeltme başlatılamadı"),
  });

  const handlePromptFixSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (aiInstructions.trim() && caps.canAddVersion) promptFix.mutate();
  };

  if (!content.currentVersion) {
    return (
      <Card className="p-5 sm:p-6">
        <SectionTitle>Önizleme ve Tasarım Editörü</SectionTitle>
        <div className="mt-4">
          <EmptyState title="Henüz tasarım yok" glyph={<IconSparkle size={24} />}>
            Üretim hattı (Mac worker) bağlandığında “Üret” ile oluşan sürümler burada katman katman
            düzenlenebilir.
          </EmptyState>
        </div>
      </Card>
    );
  }

  const goSlide = (delta: number) => {
    setInlineEditingId(null);
    setSelectedLayerId(null);
    setSlideIndex((i) => stepIndex(i, delta, count));
  };

  const onCarouselKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (
      (e.target as HTMLElement)?.tagName === "TEXTAREA" ||
      (e.target as HTMLElement)?.tagName === "INPUT"
    ) {
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      goSlide(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goSlide(-1);
    }
  };

  const stageW = currentSlide ? Math.floor(currentSlide.width * scale) : 0;
  const stageH = currentSlide ? Math.floor(currentSlide.height * scale) : 0;

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SectionTitle>Tasarım Editörü</SectionTitle>
          {isDirty && <Badge tone="warn">Kaydedilmemiş düzenleme</Badge>}
          {emptySlotsCount > 0 && <Badge tone="info">{emptySlotsCount} boş görsel yuvası</Badge>}
        </div>

        {/* Editor Toolbar: Undo / Redo / Render JPEG / LinkedIn PDF */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<IconUndo size={15} />}
            disabled={!canUndo}
            onClick={handleUndo}
            title="Geri al (⌘Z)"
          >
            Geri al
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRedo size={15} />}
            disabled={!canRedo}
            onClick={handleRedo}
            title="Yinele (⇧⌘Z)"
          >
            Yinele
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<IconDownload size={15} />}
            loading={triggerRender.isPending && triggerRender.variables === "jpeg"}
            onClick={() => triggerRender.mutate("jpeg")}
          >
            JPEG Render
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<IconDownload size={15} />}
            loading={triggerRender.isPending && triggerRender.variables === "pdf"}
            onClick={() => triggerRender.mutate("pdf")}
          >
            LinkedIn PDF
          </Button>
        </div>
      </div>

      {/* Version History Switcher */}
      <nav aria-label="Sürümler" className="mt-4">
        <h3 className="mb-2 text-[12px] font-medium text-ink-3">Sürümler</h3>
        {versions.error ? (
          <ErrorState error={versions.error} compact />
        ) : (
          <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {(versions.data?.items ?? []).map((v) => (
              <li key={v.id} className="shrink-0">
                <VersionButton
                  v={v}
                  active={v.version === selectedVersion}
                  current={v.version === currentNo}
                  approved={content.approval?.versionId === v.id}
                  onSelect={() => setSelectedVersion(v.version)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      {/* Save edited version bar */}
      {isDirty && caps.canAddVersion && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 p-3 ring-1 ring-line">
          <Input
            aria-label="Sürüm notu"
            value={versionNote}
            onChange={(e) => setVersionNote(e.target.value)}
            placeholder="Sürüm notu (isteğe bağlı, ör. Başlık küçültüldü)…"
            className="h-9 min-w-48 flex-1 text-sm"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (versionQuery.data) {
                setHistory(createHistory(toEditableSlides(versionQuery.data.slides)));
              }
            }}
          >
            Sıfırla
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconCheck size={15} />}
            loading={saveVersion.isPending}
            onClick={() => saveVersion.mutate()}
          >
            Yeni sürüm kaydet
          </Button>
        </div>
      )}

      {versionQuery.isPending ? (
        <div className="skeleton mt-4 aspect-[4/5] max-h-[640px] rounded-2xl" />
      ) : versionQuery.error ? (
        <div className="mt-4">
          <ErrorState error={versionQuery.error} onRetry={() => void versionQuery.refetch()} />
        </div>
      ) : currentSlide ? (
        <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
          {/* Artboard Stage + Slide Carousel Navigation */}
          <section
            aria-roledescription="carousel"
            aria-label={`Sürüm ${versionQuery.data.version} önizlemesi`}
            onKeyDown={onCarouselKeyDown}
            className="flex min-w-0 flex-col gap-4"
          >
            <div className="relative rounded-2xl bg-stage px-3 py-6 sm:px-8 sm:py-8">
              <div ref={stageRef} className="flex w-full justify-center">
                <div
                  role="img"
                  aria-label={`Slayt ${slideIndex + 1} / ${count}`}
                  onPointerMove={onStagePointerMove}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  className="checker relative overflow-hidden rounded-[4px] shadow-card ring-1 ring-black/5 select-none"
                  style={{
                    width: stageW || "100%",
                    height: stageH || undefined,
                    aspectRatio: stageH
                      ? undefined
                      : `${currentSlide.width} / ${currentSlide.height}`,
                  }}
                >
                  {scale > 0 && (
                    <>
                      <iframe
                        title={`Slayt ${slideIndex + 1} / ${count}`}
                        sandbox={SLIDE_SANDBOX}
                        srcDoc={srcDoc}
                        referrerPolicy="no-referrer"
                        tabIndex={-1}
                        aria-hidden="true"
                        width={currentSlide.width}
                        height={currentSlide.height}
                        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-white"
                        style={{ transform: `scale(${scale})` }}
                      />

                      {/* Interactive Layer Selection & Manipulation Overlay */}
                      <div
                        data-testid="layer-overlay"
                        className="absolute inset-0"
                        style={{ pointerEvents: "auto" }}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Katman seçimini kaldır"
                          onClick={() => {
                            setSelectedLayerId(null);
                            setInlineEditingId(null);
                          }}
                          className="absolute inset-0 cursor-default"
                        />
                        {parsed.layers.map((layer) => {
                          if (layer.type === "group") return null;
                          const isSelected = layer.id === selectedLayerId;
                          const isInline = layer.id === inlineEditingId;
                          const left = layer.bounds.x * scale;
                          const top = layer.bounds.y * scale;
                          const width = Math.max(20, layer.bounds.width * scale);
                          const height = Math.max(20, layer.bounds.height * scale);

                          if (isInline && layer.type === "text") {
                            return (
                              <div
                                key={layer.id}
                                data-layer-overlay={layer.id}
                                style={{ left, top, width, height }}
                                className="absolute z-20"
                              >
                                <textarea
                                  aria-label={`${layer.id} yerinde metin düzenle`}
                                  value={layer.text}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    applySlideEdit(
                                      (s) => ({
                                        ...s,
                                        html: updateSlideLayerText(s.html, layer.id, val),
                                      }),
                                      true,
                                      `text:${layer.id}`,
                                    );
                                  }}
                                  onBlur={() => setInlineEditingId(null)}
                                  className="size-full resize-none rounded bg-surface/95 p-1.5 text-xs text-ink ring-2 ring-accent focus:outline-none"
                                />
                              </div>
                            );
                          }

                          return (
                            <button
                              key={layer.id}
                              type="button"
                              aria-label={`${layer.id} katmanı`}
                              data-layer-overlay={layer.id}
                              style={{ left, top, width, height }}
                              onPointerDown={(e) => startGesture(e, layer, "move")}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.stopPropagation();
                                  setSelectedLayerId(null);
                                  setInlineEditingId(null);
                                }
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLayerId(layer.id);
                                if (layer.type === "slot" && layer.slotState === "empty") {
                                  setSlotDialogLayer(layer);
                                }
                              }}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (layer.type === "text" && caps.canAddVersion) {
                                  setSelectedLayerId(layer.id);
                                  setInlineEditingId(layer.id);
                                } else if (
                                  (layer.type === "slot" ||
                                    layer.type === "image" ||
                                    layer.type === "logo") &&
                                  caps.canAddVersion
                                ) {
                                  setSlotDialogLayer(layer);
                                }
                              }}
                              className={cx(
                                "group/box absolute cursor-move bg-transparent p-0 text-left transition-shadow",
                                isSelected
                                  ? "z-20 ring-2 ring-accent"
                                  : "z-10 hover:ring-1 hover:ring-accent/70",
                                layer.type === "slot" &&
                                  layer.slotState === "empty" &&
                                  "flex items-center justify-center bg-accent/10 ring-2 ring-accent/60 ring-inset",
                              )}
                            >
                              {layer.type === "slot" && layer.slotState === "empty" && (
                                <span className="pointer-events-none rounded-lg bg-ink/85 px-2.5 py-1 text-[11px] font-medium text-bg shadow">
                                  + {layer.slotLabel ?? "Görsel ekle"}
                                </span>
                              )}

                              {isSelected && (
                                <>
                                  <span className="pointer-events-none absolute -top-6 left-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap text-accent-ink shadow">
                                    {layer.id}
                                  </span>
                                  {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                                    <span
                                      key={corner}
                                      data-resize-handle={corner}
                                      onPointerDown={(e) =>
                                        startGesture(e, layer, `resize-${corner}`)
                                      }
                                      className={cx(
                                        "absolute size-3 rounded-full border-2 border-accent bg-surface shadow",
                                        corner === "nw" && "-top-1.5 -left-1.5 cursor-nwse-resize",
                                        corner === "ne" && "-top-1.5 -right-1.5 cursor-nesw-resize",
                                        corner === "sw" &&
                                          "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                                        corner === "se" &&
                                          "-right-1.5 -bottom-1.5 cursor-nwse-resize",
                                      )}
                                    />
                                  ))}
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {count > 1 && (
                <>
                  <IconButton
                    label="Önceki slayt"
                    onClick={() => goSlide(-1)}
                    disabled={slideIndex === 0}
                    className="absolute top-1/2 left-1 -translate-y-1/2 bg-surface/90 shadow-card backdrop-blur sm:left-2"
                  >
                    <IconChevronLeft />
                  </IconButton>
                  <IconButton
                    label="Sonraki slayt"
                    onClick={() => goSlide(1)}
                    disabled={slideIndex === count - 1}
                    className="absolute top-1/2 right-1 -translate-y-1/2 bg-surface/90 shadow-card backdrop-blur sm:right-2"
                  >
                    <IconChevronRight />
                  </IconButton>
                </>
              )}
            </div>

            {/* Artboard status + ratio preset selector */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3">
              <span aria-live="polite" className="font-mono tabular-nums">
                {String(slideIndex + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono">{describeArtboard(currentSlide)}</span>
                {caps.canAddVersion && (
                  <FilterSelect
                    label="Çalışma yüzeyi boyutu"
                    value={`${currentSlide.width}x${currentSlide.height}`}
                    onChange={(e) => {
                      const preset = ARTBOARD_PRESETS.find((p) => p.key === e.target.value);
                      if (!preset) return;
                      applySlideEdit((s) => ({
                        ...s,
                        width: preset.width,
                        height: preset.height,
                        html: setSlideArtboardSize(s.html, preset.width, preset.height),
                      }));
                    }}
                  >
                    {ARTBOARD_PRESETS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </FilterSelect>
                )}
              </div>
            </div>

            {count > 1 && (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {slides.map((_, i) => (
                  <button
                    key={`thumb-${i}`}
                    type="button"
                    aria-label={`Slayt ${i + 1}`}
                    aria-current={i === slideIndex ? "true" : undefined}
                    onClick={() => {
                      setSelectedLayerId(null);
                      setInlineEditingId(null);
                      setSlideIndex(i);
                    }}
                    className={cx(
                      "flex h-9 min-w-12 items-center justify-center rounded-lg px-2.5 font-mono text-xs font-medium ring-1 transition-colors",
                      i === slideIndex
                        ? "bg-ink text-bg ring-ink"
                        : "bg-surface-2 text-ink-2 ring-line hover:text-ink",
                    )}
                  >
                    #{i + 1}
                  </button>
                ))}
              </div>
            )}

            {selectedVersion !== currentNo && (
              <Notice tone="warn">
                Eski bir sürüme bakıyorsunuz (v{selectedVersion}). Onay yalnızca güncel sürüme (v
                {currentNo}) verilebilir; bu sürümden düzenleme kaydederek yeni güncel sürüm
                oluşturabilirsiniz.
              </Notice>
            )}
            {summary?.note && <p className="text-sm text-ink-2">Not: {summary.note}</p>}

            {/* "Prompt ile düzelt" bar */}
            {caps.canAddVersion && (
              <form
                onSubmit={handlePromptFixSubmit}
                className="flex flex-col gap-2.5 rounded-2xl bg-surface-2 p-3.5 ring-1 ring-line"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                    <IconSparkle size={15} className="text-accent" />
                    Prompt ile düzelt
                  </span>
                  <span className="text-[11px] text-ink-3">
                    Elle yaptığınız düzenlemeler korunarak yamalanır
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label="Prompt ile düzeltme talimatı"
                    value={aiInstructions}
                    onChange={(e) => setAiInstructions(e.target.value)}
                    placeholder={
                      selectedLayer
                        ? `ör. "${selectedLayer.id}" katmanındaki başlığı daha kısa ve vurucu yap…`
                        : "ör. Başlığı büyüt, alt metni iki satıra indir, kontrastı artır…"
                    }
                    className="h-10 flex-1 text-sm"
                  />
                  <Button
                    type="submit"
                    variant="accent"
                    icon={<IconSparkle size={15} />}
                    loading={promptFix.isPending}
                    disabled={!aiInstructions.trim()}
                  >
                    Prompt ile düzelt
                  </Button>
                </div>
                <InlineError error={promptFix.error} />
              </form>
            )}
          </section>

          {/* Right Column: Layer List & Layer Inspector */}
          <aside aria-label="Katman denetçisi" className="flex flex-col gap-4">
            <div className="rounded-2xl bg-surface-2 p-3.5 ring-1 ring-line">
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-2 uppercase">
                  <IconLayers size={14} /> Katmanlar ({parsed.layers.length})
                </span>
              </div>
              {parsed.layers.length === 0 ? (
                <p className="text-xs text-ink-3">
                  Bu slaytta <Mono>[data-layer]</Mono> etiketi bulunamadı.
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {parsed.layers.map((layer) => {
                    const active = layer.id === selectedLayerId;
                    return (
                      <li key={layer.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedLayerId(layer.id)}
                          aria-pressed={active}
                          className={cx(
                            "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                            active ? "bg-ink text-bg font-medium" : "text-ink hover:bg-surface",
                            layer.hidden && "opacity-50",
                          )}
                        >
                          <span className="truncate font-mono">{layer.id}</span>
                          <span
                            className={cx(
                              "shrink-0 text-[11px]",
                              active ? "opacity-75" : "text-ink-3",
                            )}
                          >
                            {LAYER_KIND_LABELS[layer.type]}
                            {layer.type === "slot" && layer.slotState === "empty" ? " (boş)" : ""}
                          </span>
                        </button>
                        {caps.canAddVersion && (
                          <button
                            type="button"
                            aria-label={
                              layer.hidden
                                ? `${layer.id} katmanını göster`
                                : `${layer.id} katmanını gizle`
                            }
                            onClick={() =>
                              applySlideEdit((s) => ({
                                ...s,
                                html: updateSlideLayerStyle(s.html, layer.id, {
                                  hidden: !layer.hidden,
                                }),
                              }))
                            }
                            className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
                          >
                            {layer.hidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Selected Layer Inspector */}
            {selectedLayer ? (
              <LayerInspector
                layer={selectedLayer}
                editable={caps.canAddVersion}
                onChangeText={(text) =>
                  applySlideEdit(
                    (s) => ({
                      ...s,
                      html: updateSlideLayerText(s.html, selectedLayer.id, text),
                    }),
                    true,
                    `text:${selectedLayer.id}`,
                  )
                }
                onChangeStyle={(patch) =>
                  applySlideEdit(
                    (s) => ({
                      ...s,
                      html: updateSlideLayerStyle(s.html, selectedLayer.id, patch),
                    }),
                    true,
                    patch.hidden !== undefined || patch.textAlign !== undefined
                      ? undefined
                      : `style:${selectedLayer.id}:${Object.keys(patch).join(",")}`,
                  )
                }
                onMove={(dx, dy) =>
                  applySlideEdit((s) => ({
                    ...s,
                    html: moveSlideLayer(s.html, selectedLayer.id, { dx, dy }),
                  }))
                }
                onResize={(width, height) =>
                  applySlideEdit((s) => ({
                    ...s,
                    html: resizeSlideLayer(s.html, selectedLayer.id, { width, height }),
                  }))
                }
                onReorder={(dir) =>
                  applySlideEdit((s) => ({
                    ...s,
                    html: reorderSlideLayer(s.html, selectedLayer.id, dir),
                  }))
                }
                onOpenSlotFill={() => setSlotDialogLayer(selectedLayer)}
                onClearSlot={() =>
                  applySlideEdit((s) => ({
                    ...s,
                    html: clearSlideSlot(s.html, selectedLayer.id),
                  }))
                }
                onInlineEdit={() => setInlineEditingId(selectedLayer.id)}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-line-strong p-4 text-center text-xs text-ink-3">
                Özelliklerini düzenlemek, taşımak ya da görsel yerleştirmek için tuvalden veya
                yukarıdaki listeden bir katman seçin.
              </div>
            )}
          </aside>
        </div>
      ) : null}

      <InlineError error={saveVersion.error ?? triggerRender.error} />

      <SlotFillDialog
        open={slotDialogLayer !== null}
        onClose={() => setSlotDialogLayer(null)}
        brandId={content.brandId}
        contentId={content.id}
        layerId={slotDialogLayer?.id ?? ""}
        slotLabel={slotDialogLayer?.slotLabel}
        defaultRatio={slotDialogLayer?.slotRatio}
        onSelectImage={({ src, assetId, alt, blobUrl }) => {
          if (!slotDialogLayer) return;
          if (blobUrl) {
            setLocalBlobs((prev) => {
              const next = new Map(prev);
              next.set(src, blobUrl);
              return next;
            });
          }
          applySlideEdit((s) => ({
            ...s,
            html: fillSlideSlot(s.html, slotDialogLayer.id, { src, alt, assetId }),
          }));
        }}
      />
    </Card>
  );
}

function LayerInspector({
  layer,
  editable,
  onChangeText,
  onChangeStyle,
  onMove,
  onResize,
  onReorder,
  onOpenSlotFill,
  onClearSlot,
  onInlineEdit,
}: {
  layer: ParsedLayer;
  editable: boolean;
  onChangeText: (text: string) => void;
  onChangeStyle: (patch: Parameters<typeof updateSlideLayerStyle>[2]) => void;
  onMove: (dx: number, dy: number) => void;
  onResize: (width: number, height: number) => void;
  onReorder: (dir: "up" | "down" | "front" | "back") => void;
  onOpenSlotFill: () => void;
  onClearSlot: () => void;
  onInlineEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-ink">{layer.id}</p>
          <p className="text-[11px] text-ink-3">{LAYER_KIND_LABELS[layer.type]}</p>
        </div>
        {editable && (
          <div className="flex items-center gap-1">
            <IconButton
              label="Katmanı arkaya gönder"
              disabled={layer.index === 0}
              onClick={() => onReorder("down")}
              className="size-7"
            >
              <IconArrowDown size={14} />
            </IconButton>
            <IconButton
              label="Katmanı öne getir"
              disabled={layer.index >= layer.siblingCount - 1}
              onClick={() => onReorder("up")}
              className="size-7"
            >
              <IconArrowUp size={14} />
            </IconButton>
            <IconButton
              label={layer.hidden ? "Katmanı göster" : "Katmanı gizle"}
              onClick={() => onChangeStyle({ hidden: !layer.hidden })}
              className="size-7"
            >
              {layer.hidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </IconButton>
          </div>
        )}
      </div>

      {/* Text editing & typography */}
      {layer.type === "text" && (
        <>
          <Field label="Metin">
            {(p) => (
              <Textarea
                {...p}
                value={layer.text}
                disabled={!editable}
                onChange={(e) => onChangeText(e.target.value)}
                rows={3}
                className="text-sm"
              />
            )}
          </Field>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconEdit size={14} />}
              onClick={onInlineEdit}
              className="self-start"
            >
              Tuval üzerinde düzenle
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Font ailesi">
              {(p) => (
                <select
                  {...p}
                  disabled={!editable}
                  value={layer.fontFamily}
                  onChange={(e) => onChangeStyle({ fontFamily: e.target.value })}
                  className="h-9 w-full rounded-lg bg-surface px-2 text-xs text-ink ring-1 ring-line-strong"
                >
                  <option value="">Varsayılan</option>
                  {FONT_PRESETS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                  {layer.fontFamily && !FONT_PRESETS.some((f) => f.value === layer.fontFamily) && (
                    <option value={layer.fontFamily}>{layer.fontFamily}</option>
                  )}
                </select>
              )}
            </Field>
            <Field label="Boyut (px)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={12}
                  max={400}
                  disabled={!editable}
                  value={layer.fontSize ?? ""}
                  onChange={(e) =>
                    onChangeStyle({
                      fontSize: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  className="h-9 px-2.5 text-xs"
                />
              )}
            </Field>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink">Hizalama</span>
            <Segmented
              name="layer-align"
              label="Metin hizalaması"
              size="sm"
              value={layer.textAlign}
              onChange={(align) => editable && onChangeStyle({ textAlign: align })}
              options={[
                { value: "left", label: "Sol" },
                { value: "center", label: "Orta" },
                { value: "right", label: "Sağ" },
              ]}
            />
          </div>
        </>
      )}

      {/* Visual slot / image replacement */}
      {(layer.type === "slot" || layer.type === "image" || layer.type === "logo") && (
        <div className="flex flex-col gap-2 rounded-xl bg-surface p-3 ring-1 ring-line">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">
              {layer.type === "slot"
                ? layer.slotState === "filled"
                  ? "Yuva dolu"
                  : "Yuva boş — görsel bekliyor"
                : "Görsel kaynağı"}
            </span>
            {layer.slotRatio && <Mono className="text-ink-3">{layer.slotRatio}</Mono>}
          </div>
          {layer.src && <Mono className="truncate text-[11px] text-ink-3">{layer.src}</Mono>}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={onOpenSlotFill}>
                {layer.type === "slot" && layer.slotState === "empty"
                  ? "Yuvayı doldur"
                  : "Görseli değiştir"}
              </Button>
              {layer.type === "slot" && layer.slotState === "filled" && (
                <Button size="sm" variant="ghost" onClick={onClearSlot}>
                  Boşalt
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Yazı rengi">
          {(p) => (
            <Input
              {...p}
              disabled={!editable}
              value={layer.color}
              onChange={(e) => onChangeStyle({ color: e.target.value })}
              placeholder="#1b1a17 / var(--...)"
              className="h-9 px-2.5 font-mono text-xs"
            />
          )}
        </Field>
        <Field label="Arka plan">
          {(p) => (
            <Input
              {...p}
              disabled={!editable}
              value={layer.backgroundColor}
              onChange={(e) => onChangeStyle({ backgroundColor: e.target.value })}
              placeholder="#ffffff / transparent"
              className="h-9 px-2.5 font-mono text-xs"
            />
          )}
        </Field>
      </div>

      {/* Geometry & Opacity */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Genişlik (px)">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={24}
              max={4096}
              disabled={!editable}
              value={layer.bounds.width}
              onChange={(e) =>
                onResize(Math.max(24, Number(e.target.value) || 24), layer.bounds.height)
              }
              className="h-9 px-2.5 font-mono text-xs"
            />
          )}
        </Field>
        <Field label="Yükseklik (px)">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={24}
              max={4096}
              disabled={!editable}
              value={layer.bounds.height}
              onChange={(e) =>
                onResize(layer.bounds.width, Math.max(24, Number(e.target.value) || 24))
              }
              className="h-9 px-2.5 font-mono text-xs"
            />
          )}
        </Field>
      </div>

      <Field label={`Saydamlık (%${Math.round(layer.opacity * 100)})`}>
        {(p) => (
          <input
            {...p}
            type="range"
            min={0}
            max={100}
            disabled={!editable}
            value={Math.round(layer.opacity * 100)}
            onChange={(e) => onChangeStyle({ opacity: Number(e.target.value) / 100 })}
            className="w-full accent-[var(--accent)]"
          />
        )}
      </Field>

      {editable && (
        <div className="flex items-center justify-between gap-1 text-xs">
          <span className="text-ink-3">Konum taşı:</span>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => onMove(-10, 0)}>
              ←
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onMove(10, 0)}>
              →
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onMove(0, -10)}>
              ↑
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onMove(0, 10)}>
              ↓
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function VersionButton({
  v,
  active,
  current,
  approved,
  onSelect,
}: {
  v: ContentVersionSummary;
  active: boolean;
  current: boolean;
  approved: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cx(
        "flex w-44 flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left ring-1 ring-inset transition-colors",
        active ? "bg-ink text-bg ring-ink" : "bg-surface ring-line hover:ring-line-strong",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">v{v.version}</span>
        {current && (
          <span className={cx("text-[11px]", active ? "opacity-70" : "text-accent")}>güncel</span>
        )}
        {approved && (
          <IconShield size={14} className={active ? "" : "text-good"} aria-label="onaylı" />
        )}
      </span>
      <span className={cx("text-[12px]", active ? "opacity-70" : "text-ink-3")}>
        {VERSION_ORIGIN_LABELS[v.origin]} · {v.slideCount} slayt
      </span>
      <span className={cx("text-[11px]", active ? "opacity-60" : "text-ink-3")}>
        {formatRelative(v.createdAt)}
      </span>
    </button>
  );
}
