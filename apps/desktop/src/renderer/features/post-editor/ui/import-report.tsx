// What the import changed when the post was first opened on the canvas (E11): one line over the
// canvas — "Tuvale aktarırken değişenler: 3 katman" — that opens into the list, layer by layer
// ("Kare 1 · başlık: dengeli satır kırılımı satır sonlarıyla korundu"). "Tamam" closes it for
// this version (it is not shown again for it while the app runs).
import { useState } from "react";
import { Button } from "../../../components/ui/controls.tsx";
import { IconWarning } from "../../../components/ui/icons.tsx";
import type { ImportChange } from "../wecra/fidelity.ts";

/** Versions whose report was closed (this run of the app). */
const seen = new Set<string>();

/** The report's lines, a layer's changes together: "Kare 1 · headline: a; b". */
export function reportLines(report: readonly ImportChange[]): string[] {
  const byLayer = new Map<string, string[]>();
  for (const c of report) {
    const key = `Kare ${c.slide + 1} · ${c.layer}`;
    const list = byLayer.get(key) ?? [];
    if (!list.includes(c.what)) list.push(c.what);
    byLayer.set(key, list);
  }
  return [...byLayer].map(([layer, what]) => `${layer}: ${what.join("; ")}`);
}

/** The summary: how many layers changed. */
export function reportSummary(report: readonly ImportChange[]): string {
  const layers = new Set(report.map((c) => `${c.slide}\u0000${c.layer}`)).size;
  return `Tuvale aktarırken değişenler: ${layers} katman`;
}

export function ImportReport({
  report,
  versionKey,
}: {
  report: readonly ImportChange[];
  /** The version the report is of (closing it is remembered per version). */
  versionKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(() => seen.has(versionKey));
  if (!report.length || closed) return null;
  const lines = reportLines(report);
  return (
    <div
      role="status"
      aria-label="Tuvale aktarırken değişenler"
      data-import-report=""
      className="glass pointer-events-auto absolute top-3 left-3 z-20 flex max-w-[440px] flex-col gap-2 rounded-[16px] py-2 pr-2 pl-3 text-body text-fg-2"
    >
      <div className="flex items-center gap-2">
        <IconWarning size={14} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1">{reportSummary(report)}</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Gizle" : "Göster"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            seen.add(versionKey);
            setClosed(true);
          }}
        >
          Tamam
        </Button>
      </div>
      {open && (
        <ul className="scroll-area max-h-[240px] list-disc pr-2 pl-5 text-footnote text-fg-2">
          {lines.map((line) => (
            <li key={line} className="[overflow-wrap:anywhere]">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
