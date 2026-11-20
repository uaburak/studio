// Brand building blocks: the logo tile (logo file, else initials on the brand colour), colour
// swatches, platform icons with their state, and the new-brand sheet.
import { type GenerationEngine, slugify } from "@studio/contract";
import { useState } from "react";
import { Button, cn, TextField } from "../../components/ui/controls.tsx";
import { PlatformIcon } from "../../components/ui/icons.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { assetUrl } from "../../lib/api.ts";
import {
  engineChoice,
  engineOptions,
  LANGUAGES,
  PLATFORM_NAME,
  type PlatformLine,
  type Swatch,
} from "./brand-model.ts";
import { useCreateBrandFlow } from "./use-create-brand.ts";

export function BrandMark({
  name,
  initials,
  logoAssetId,
  color,
  size = 44,
}: {
  name: string;
  initials: string;
  logoAssetId: string | null;
  color?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const radius = size * 0.27;
  if (logoAssetId && !broken) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-[inset_0_0_0_1px_var(--border-hairline)]"
        style={{ width: size, height: size, borderRadius: radius }}
      >
        <img
          src={assetUrl(logoAssetId)}
          alt={`${name} logosu`}
          className="size-[78%] object-contain"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center font-bold text-on-accent"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: size * 0.42,
        background: color
          ? `linear-gradient(180deg, color-mix(in srgb, ${color} 72%, white), ${color})`
          : "var(--accent-default)",
      }}
    >
      {initials}
    </span>
  );
}

export function Swatches({ swatches, size = 24 }: { swatches: Swatch[]; size?: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {swatches.map((s) => (
        <span
          key={`${s.name}-${s.hex}`}
          title={`${s.name} · ${s.hex}`}
          className="rounded-full shadow-[inset_0_0_0_1px_var(--border-default)]"
          style={{ width: size, height: size, background: s.hex }}
        />
      ))}
    </div>
  );
}

export function PlatformIcons({ lines }: { lines: PlatformLine[] }) {
  return (
    <span className="flex items-center gap-2">
      {lines.map((line) => (
        <span
          key={line.platform}
          title={`${PLATFORM_NAME[line.platform]}: ${line.value}`}
          className={cn(
            "flex size-4 items-center justify-center",
            line.needsOwner
              ? "text-accent-text"
              : line.connected
                ? "text-icon"
                : "text-fg-3 opacity-60",
          )}
        >
          <PlatformIcon platform={line.platform} size={16} />
        </span>
      ))}
    </span>
  );
}

/** "Yeni marka": name, short name (slug), language. */
export function NewBrandSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [language, setLanguage] = useState("tr");
  const flow = useCreateBrandFlow();
  const submit = async () => {
    if (await flow.create(name, slug, language)) {
      setName("");
      setSlug("");
      onClose();
    }
  };
  return (
    <Sheet
      open={open}
      title="Yeni marka"
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            disabled={flow.busy || !name.trim()}
            onClick={() => void submit()}
          >
            {flow.busy ? "Oluşturuluyor…" : "Oluştur"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">Marka adı</span>
          <TextField
            aria-label="Marka adı"
            value={name}
            placeholder="Örn. MTM Agro"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">Kısa ad</span>
          <TextField
            aria-label="Kısa ad"
            value={slug}
            placeholder={slugify(name) || "mtm-agro"}
            onChange={(event) => setSlug(event.target.value)}
          />
          <span className="text-caption text-fg-3">
            Küçük harf, rakam ve tire; boş bırakılırsa addan üretilir.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">İçerik dili</span>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
        {flow.error && (
          <p className="text-footnote text-danger" role="alert">
            {flow.error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

export function LanguageSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange(value: string): void;
  className?: string;
}) {
  return (
    <select
      aria-label="İçerik dili"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "no-drag h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none hover:bg-control",
        className,
      )}
    >
      {LANGUAGES.map((l) => (
        <option key={l.tag} value={l.tag}>
          {l.label}
        </option>
      ))}
      {!LANGUAGES.some((l) => l.tag === value) && <option value={value}>{value}</option>}
    </select>
  );
}

/**
 * "Varsayılan üretim motoru": Sor (null: the agent asks each time) or an engine. Engines that do
 * not run yet are listed as "yakında" and cannot be picked (one saved elsewhere stays shown).
 */
export function EngineSelect({
  value,
  onChange,
  className,
}: {
  value: GenerationEngine | null;
  onChange(value: GenerationEngine | null): void;
  className?: string;
}) {
  return (
    <select
      aria-label="Varsayılan üretim motoru"
      value={value ?? ""}
      onChange={(event) => onChange(engineChoice(event.target.value))}
      className={cn(
        "no-drag h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none hover:bg-control",
        className,
      )}
    >
      <option value="">Sor</option>
      {engineOptions().map((o) => (
        <option key={o.value} value={o.value} disabled={!o.ready && o.value !== value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
