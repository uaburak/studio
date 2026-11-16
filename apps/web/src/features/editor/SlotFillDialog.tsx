import type { Asset } from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconSparkle, IconUpload } from "../../components/icons.tsx";
import { EmptyState, InlineError } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Button,
  Checkbox,
  cx,
  Field,
  Progress,
  Segmented,
  Textarea,
} from "../../components/ui.tsx";
import { formatPercent } from "../../lib/format.ts";
import { CancelJobButton, useLiveJobs } from "../../lib/live-jobs.tsx";
import { queryKeys } from "../../lib/query-keys.ts";
import { checkFile, readMediaMetadata, withMimeType } from "../media/upload.ts";

type Tab = "yukle" | "kutuphane" | "ai";
type Ratio = "4:5" | "9:16" | "1:1";

function extFromMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/svg+xml") return ".svg";
  return ".jpg";
}

export function mediaVirtualPath(asset: Pick<Asset, "id" | "mimeType">): string {
  return `/media/${asset.id}${extFromMime(asset.mimeType)}`;
}

export function SlotFillDialog({
  open,
  onClose,
  brandId,
  contentId,
  layerId,
  slotLabel,
  defaultRatio,
  onSelectImage,
}: {
  open: boolean;
  onClose: () => void;
  brandId: string;
  contentId: string;
  layerId: string;
  slotLabel?: string | null;
  defaultRatio?: string | null;
  onSelectImage: (selection: {
    src: string;
    assetId: string;
    alt: string;
    blobUrl?: string;
  }) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { jobsById, streamStatus } = useLiveJobs();

  const [tab, setTab] = useState<Tab>("yukle");
  const [uploading, setUploading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiRatio, setAiRatio] = useState<Ratio>("4:5");
  const [preserveLabel, setPreserveLabel] = useState(false);
  const [refAssetIds, setRefAssetIds] = useState<string[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab("yukle");
    setAiPrompt(slotLabel ?? "");
    setAiRatio(defaultRatio === "9:16" ? "9:16" : defaultRatio === "1:1" ? "1:1" : "4:5");
    setPreserveLabel(false);
    setRefAssetIds([]);
    setActiveJobId(null);
  }, [open, slotLabel, defaultRatio]);

  const assetsQuery = useQuery({
    queryKey: queryKeys.assets.list({ brandId, kind: "image" }),
    queryFn: ({ signal }) => api.assets.list({ brandId, kind: "image", limit: 48 }, { signal }),
    enabled: open && (tab === "kutuphane" || tab === "ai"),
  });

  const jobPoll = useQuery({
    queryKey: queryKeys.jobs.one(activeJobId ?? ""),
    queryFn: ({ signal }) => api.jobs.get(activeJobId ?? "", { signal }),
    enabled: open && Boolean(activeJobId) && streamStatus !== "open",
    refetchInterval: 2000,
  });

  const trackedJob = activeJobId ? (jobsById.get(activeJobId) ?? jobPoll.data ?? null) : null;

  // Automatically apply when Gemini image.generate finishes with an assetId
  useEffect(() => {
    if (trackedJob?.status !== "succeeded") return;
    const assetId =
      typeof trackedJob.output?.assetId === "string" ? trackedJob.output.assetId : null;
    if (!assetId) return;
    setActiveJobId(null);
    void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
    onSelectImage({
      src: `/media/${assetId}.jpg`,
      assetId,
      alt: aiPrompt.trim() || slotLabel || "AI görsel",
    });
    toast.success("AI görsel üretildi ve katmana yerleştirildi");
    onClose();
  }, [trackedJob, aiPrompt, slotLabel, onSelectImage, onClose, qc, toast]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const check = checkFile(file);
    if (!check.ok) {
      toast.error(new Error(check.error));
      return;
    }
    setUploading(true);
    try {
      const meta = await readMediaMetadata(file, check.mimeType);
      const asset = await api.assets.upload({
        brandId,
        file: withMimeType(file, check.mimeType),
        ...meta,
      });
      void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
      const blobUrl =
        typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      onSelectImage({
        src: mediaVirtualPath(asset),
        assetId: asset.id,
        alt: file.name,
        ...(blobUrl ? { blobUrl } : {}),
      });
      toast.success("Görsel yüklendi ve katmana yerleştirildi");
      onClose();
    } catch (error) {
      toast.error(error, "Görsel yüklenemedi");
    } finally {
      setUploading(false);
    }
  };

  const generateAi = useMutation({
    mutationFn: () =>
      api.jobs.create({
        type: "image.generate",
        brandId,
        payload: {
          prompt: aiPrompt.trim(),
          aspectRatio: aiRatio,
          imageSize: "2K",
          preserveProductLabel: preserveLabel,
          referenceAssetIds: refAssetIds,
          targetContentId: contentId,
          targetSlotId: layerId,
        },
      }),
    onSuccess: (job) => {
      setActiveJobId(job.id);
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success("Gemini görsel üretimi başlatıldı", "2K çözünürlükte hazırlanıyor.");
    },
  });

  const submitAi = (e: FormEvent) => {
    e.preventDefault();
    if (aiPrompt.trim()) generateAi.mutate();
  };

  const toggleRefAsset = (id: string) => {
    setRefAssetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 4 ? [...prev, id] : prev,
    );
  };

  const libraryAssets = assetsQuery.data?.items ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={slotLabel ? `Görsel yuvası: ${slotLabel}` : "Görsel seç / üret"}
      description={`Katman: ${layerId} · Fotoğraf yükleyin, kütüphaneden seçin ya da Gemini ile üretin.`}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Vazgeç
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Segmented
          name="slot-fill-tab"
          label="Görsel kaynağı"
          value={tab}
          onChange={setTab}
          options={[
            { value: "yukle", label: "Fotoğraf yükle" },
            { value: "kutuphane", label: "Marka medyası" },
            { value: "ai", label: "Gemini ile üret" },
          ]}
        />

        {tab === "yukle" && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line-strong bg-surface-2/50 px-6 py-10 text-center">
            <IconUpload size={28} className="text-ink-2" />
            <p className="font-display text-2xl text-ink">Bilgisayardan fotoğraf seçin</p>
            <p className="text-sm text-ink-2">JPEG, PNG veya WebP · En fazla 20 MB</p>
            <Button variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}>
              Fotoğraf seç ve yerleştir
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Katman için fotoğraf yükle"
              className="sr-only"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {tab === "kutuphane" && (
          <div>
            {assetsQuery.isPending ? (
              <div className="skeleton h-40 rounded-2xl" />
            ) : libraryAssets.length === 0 ? (
              <EmptyState title="Bu markada henüz görsel yok" compact>
                “Fotoğraf yükle” sekmesinden ilk görseli ekleyebilirsiniz.
              </EmptyState>
            ) : (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {libraryAssets.map((asset) => (
                  <li key={asset.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectImage({
                          src: mediaVirtualPath(asset),
                          assetId: asset.id,
                          alt: asset.originalFilename ?? slotLabel ?? "Görsel",
                        });
                        onClose();
                      }}
                      className="group flex w-full flex-col overflow-hidden rounded-xl bg-surface-2 text-left ring-1 ring-line hover:ring-2 hover:ring-accent"
                    >
                      <div className="checker aspect-square w-full overflow-hidden">
                        <img
                          src={api.assets.contentUrl(asset.id)}
                          alt={asset.originalFilename ?? asset.id}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      <span className="truncate px-2 py-1.5 text-xs text-ink">
                        {asset.originalFilename ?? asset.id}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "ai" && (
          <form onSubmit={submitAi} className="flex flex-col gap-4">
            <Field label="Görsel istemi (prompt)" hint="Gemini 2K çözünürlükte sahne üretir.">
              {(p) => (
                <Textarea
                  {...p}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  rows={4}
                  placeholder="ör. Güneşli buğday tarlasında sabah ışığı, doğal editorial fotoğraf…"
                  required
                />
              )}
            </Field>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-ink">En / Boy oranı</span>
                <Segmented
                  name="ai-aspect-ratio"
                  label="Görsel oranı"
                  size="sm"
                  value={aiRatio}
                  onChange={setAiRatio}
                  options={[
                    { value: "4:5", label: "4:5 Dikey" },
                    { value: "9:16", label: "9:16 Story" },
                    { value: "1:1", label: "1:1 Kare" },
                  ]}
                />
              </div>
            </div>

            <Checkbox
              checked={preserveLabel}
              onChange={setPreserveLabel}
              description="Sahneyi AI üretir; referans ürün fotoğrafındaki küçük etiket yazılarını yeniden çizmeden korur."
            >
              Ürün etiketini koru
            </Checkbox>

            {libraryAssets.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-medium text-ink">
                  Referans görseller ({refAssetIds.length}/4 seçili, isteğe bağlı)
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {libraryAssets.slice(0, 12).map((a) => {
                    const selected = refAssetIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleRefAsset(a.id)}
                        className={cx(
                          "size-16 shrink-0 overflow-hidden rounded-xl ring-2",
                          selected
                            ? "ring-accent"
                            : "opacity-65 ring-transparent hover:opacity-100",
                        )}
                      >
                        <img
                          src={api.assets.contentUrl(a.id)}
                          alt={a.originalFilename ?? a.id}
                          className="size-full object-cover"
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {trackedJob && (
              <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-ink">
                    {trackedJob.progressMessage ??
                      (trackedJob.status === "queued"
                        ? "Mac worker sırasında bekliyor…"
                        : trackedJob.status === "failed"
                          ? `Hata: ${trackedJob.error ?? "Üretim başarısız"}`
                          : "Görsel üretiliyor…")}
                  </span>
                  {trackedJob.progress !== undefined && (
                    <span className="font-mono text-ink-2">
                      {formatPercent(trackedJob.progress)}
                    </span>
                  )}
                </div>
                {trackedJob.progress !== undefined && (
                  <Progress value={trackedJob.progress} label="AI görsel ilerlemesi" />
                )}
                <div className="flex justify-end">
                  <CancelJobButton job={trackedJob} size="sm" />
                </div>
              </div>
            )}

            <InlineError error={generateAi.error} />

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="accent"
                icon={<IconSparkle size={16} />}
                loading={generateAi.isPending}
                disabled={
                  !aiPrompt.trim() ||
                  trackedJob?.status === "queued" ||
                  trackedJob?.status === "running"
                }
              >
                Gemini ile üret
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
