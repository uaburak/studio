// The checks in the component gallery (/?route=gallery): the list in its states and the
// brand settings form, with sample data (no API).
import type { ContentCheckResult, ContentCheckRun } from "@studio/contract";
import { useState } from "react";
import { settingsDraft } from "./checks-model.ts";
import { ChecksList } from "./checks-panel.tsx";
import { ChecksSettingsForm } from "./checks-settings.tsx";

const at = new Date(Date.now() - 4 * 60_000).toISOString();

const row = (
  checkId: string,
  status: ContentCheckResult["status"],
  message: string,
  extra: Partial<ContentCheckResult> = {},
): ContentCheckResult => ({
  checkId,
  category: checkId.split(".")[0] as ContentCheckResult["category"],
  status,
  message,
  refs: [],
  evidence: null,
  source: "deterministic",
  fixable: false,
  ...extra,
});

const RESULTS: ContentCheckResult[] = [
  row("layout.overflow", "fail", '"headline" metni kutusuna sığmıyor.', {
    refs: [{ slide: 0, layer: "headline" }],
    fixable: true,
  }),
  row("text.banned-words", "fail", 'Açıklamada yasak ifade: "ücretsizdir" (ücretsiz).'),
  row(
    "layout.contrast",
    "warn",
    '"body" arka planın bazı yerlerinde zor okunuyor (en düşük 3.1:1).',
    { refs: [{ slide: 1, layer: "body" }] },
  ),
  row("text.language", "warn", "“topraginiz” yazımı hatalı. Öneri: toprağınız", {
    source: "model",
  }),
  row(
    "layout.safe-area",
    "fixed",
    'Düzeltildi: "logo-venta" güvenli alana taşındı (+46 px yatay)',
    {
      refs: [{ slide: 0, layer: "logo-venta" }],
    },
  ),
  ...[
    "brief.completeness",
    "brand.colors",
    "brand.fonts",
    "brand.logo",
    "layout.legibility",
    "text.caption-length",
    "text.hashtags",
    "visual.resolution",
    "visual.distortion",
  ].map((id) => row(id, "pass", "")),
  row("accuracy.products", "skipped", "Dil ve marka denetimi bu kez çalışmadı; yeniden deneyin.", {
    source: "model",
  }),
];

export const SAMPLE_CHECK_RUN: ContentCheckRun = {
  id: "run_demo",
  contentId: "content_demo",
  brandId: "brand_demo",
  version: 3,
  versionId: "ver_demo",
  trigger: "fix",
  jobId: null,
  strictness: "standard",
  summary: { fail: 2, warn: 2, fixed: 1, pass: 9, skipped: 1 },
  blocking: 2,
  results: RESULTS.map((r) => (r.status === "pass" ? { ...r, message: "Sorun bulunmadı." } : r)),
  model: "gemini-2.5-flash-lite",
  fromVersion: 2,
  fixedVersion: null,
  note: "",
  createdAt: at,
};

export function ChecksGallery() {
  const [draft, setDraft] = useState(() =>
    settingsDraft({
      brandId: "brand_demo",
      disabledChecks: ["visual.logo-legibility"],
      bannedWords: ["ücretsiz", "garantili", "1 numara"],
      strictness: "standard",
      autoFix: true,
      updatedAt: null,
    }),
  );
  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-6">
        <div className="max-w-[460px]" data-testid="checks-demo-run">
          <ChecksList
            run={SAMPLE_CHECK_RUN}
            version={3}
            onRun={() => undefined}
            onFix={() => undefined}
            onLocate={() => undefined}
          />
        </div>
        <div className="flex max-w-[460px] flex-col gap-6">
          <ChecksList run={null} version={4} onRun={() => undefined} />
          <ChecksList run={null} version={4} running="Dil, marka ve ürün denetimi…" />
          <ChecksList
            run={{
              ...SAMPLE_CHECK_RUN,
              summary: { fail: 0, warn: 0, fixed: 0, pass: 9, skipped: 0 },
              blocking: 0,
              fromVersion: null,
              results: RESULTS.filter((r) => r.status === "pass"),
            }}
            version={4}
            onRun={() => undefined}
          />
        </div>
      </div>
      <div data-testid="checks-demo-settings">
        <ChecksSettingsForm draft={draft} onChange={setDraft} />
      </div>
    </div>
  );
}
