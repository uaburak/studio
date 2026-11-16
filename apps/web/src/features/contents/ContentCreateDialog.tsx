import {
  type Content,
  type ContentType,
  ContentType as ContentTypeEnum,
  type Platform,
  Platform as PlatformEnum,
} from "@studio/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconPlatform } from "../../components/icons.tsx";
import { InlineError, Notice } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Button,
  Checkbox,
  cx,
  Field,
  Input,
  Segmented,
  Select,
  Textarea,
} from "../../components/ui.tsx";
import { useBrands } from "../../lib/brand-context.tsx";
import { CONTENT_TYPE_HINTS, CONTENT_TYPE_LABELS, PLATFORM_LABELS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { generatePayload } from "./generate.ts";

export function ContentCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (content: Content) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { brandId: selectedBrand, activeBrands } = useBrands();
  const [brandId, setBrandId] = useState("");
  const [type, setType] = useState<ContentType>("post");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [platforms, setPlatforms] = useState<Platform[]>(["instagram"]);
  const [generate, setGenerate] = useState(true);

  useEffect(() => {
    if (!open) return;
    setBrandId(selectedBrand ?? activeBrands[0]?.id ?? "");
    setType("post");
    setTitle("");
    setBrief("");
    setPlatforms(["instagram"]);
    setGenerate(true);
  }, [open, selectedBrand, activeBrands]);

  const create = useMutation({
    mutationFn: async () => {
      const content = await api.contents.create({
        brandId,
        type,
        title: title.trim(),
        brief,
        targetPlatforms: platforms,
      });
      let jobError: unknown = null;
      if (generate) {
        try {
          await api.jobs.create({
            type: "content.generate",
            contentId: content.id,
            payload: generatePayload(content),
          });
        } catch (error) {
          jobError = error;
        }
      }
      return { content, jobError };
    },
    onSuccess: ({ content, jobError }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success(
        "İçerik oluşturuldu",
        generate && !jobError ? "Üretim işi kuyruğa eklendi." : undefined,
      );
      if (jobError) toast.error(jobError, "Üretim işi oluşturulamadı");
      onCreated(content);
    },
  });

  const togglePlatform = (p: Platform, on: boolean) =>
    setPlatforms((list) => (on ? [...list, p] : list.filter((x) => x !== p)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (brandId && title.trim()) create.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        create.reset();
        onClose();
      }}
      title="Yeni içerik"
      description="Brif, üretim ajanına verdiğin talimattır: ne anlatılacak, kime, hangi tonda."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="content-create-form"
            variant="primary"
            loading={create.isPending}
            disabled={!brandId || !title.trim()}
          >
            Oluştur
          </Button>
        </>
      }
    >
      {activeBrands.length === 0 ? (
        <Notice tone="warn">İçerik oluşturmak için önce bir marka ekleyin (Markalar).</Notice>
      ) : (
        <form id="content-create-form" onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="Marka">
              {(p) => (
                <Select
                  {...p}
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  required
                >
                  {activeBrands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Tür</span>
              <Segmented
                name="content-type"
                label="İçerik türü"
                value={type}
                onChange={setType}
                options={ContentTypeEnum.options.map((t) => ({
                  value: t,
                  label: CONTENT_TYPE_LABELS[t],
                  hint: CONTENT_TYPE_HINTS[t],
                }))}
              />
            </div>
          </div>

          <Field label="Başlık" hint="Kendi takibin için; paylaşılmaz.">
            {(p) => (
              <Input
                {...p}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="ör. Kasım kampanyası — tohum serisi"
                maxLength={200}
                required
                autoFocus
              />
            )}
          </Field>

          <Field
            label="Brif"
            hint="Mesaj, hedef kitle, olmazsa olmazlar, referanslar. Marka profili otomatik eklenir."
          >
            {(p) => (
              <Textarea
                {...p}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={7}
                maxLength={20000}
                placeholder="ör. Yeni buğday tohumu serisini tanıtan 5 slaytlık bir carousel. İlk slaytta güçlü bir başlık, son slaytta bayilere yönlendiren çağrı…"
                className="text-[16px]"
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13px] font-medium text-ink">Hedef platformlar</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PlatformEnum.options.map((p) => (
                <Checkbox
                  key={p}
                  checked={platforms.includes(p)}
                  onChange={(on) => togglePlatform(p, on)}
                >
                  <span className={cx("inline-flex items-center gap-1.5")}>
                    <IconPlatform platform={p} size={16} />
                    {PLATFORM_LABELS[p]}
                  </span>
                </Checkbox>
              ))}
            </div>
          </fieldset>

          <Checkbox
            checked={generate}
            onChange={setGenerate}
            description="Mac'teki üretim hattı henüz bağlı değil; iş kuyrukta bekler."
          >
            Üretim işini hemen kuyruğa ekle
          </Checkbox>

          <InlineError error={create.error} />
        </form>
      )}
    </Dialog>
  );
}
