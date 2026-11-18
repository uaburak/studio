// Small special-day labels (Takvim cells, week header, Planlar dates) and the "Benzer" mark of a
// plan item (Planlar view, the chat's plan card) — N5, N6.
import type { PlanItem } from "@studio/contract";
import { cn, TagPill } from "../../components/ui/controls.tsx";
import {
  type DayLabel,
  type DayLabelTone,
  similarText,
  similarTitle,
} from "./special-days-model.ts";

const LABEL_TONES: Record<DayLabelTone, string> = {
  holiday: "text-danger",
  religious: "text-accent-text",
  remembrance: "text-fg-2",
  other: "text-fg-3",
};

/** Up to `max` labels, one per line, then "+N". */
export function DayLabels({
  labels,
  max = 2,
  className,
}: {
  labels: readonly DayLabel[];
  max?: number;
  className?: string;
}) {
  if (labels.length === 0) return null;
  const rest = labels.slice(max);
  return (
    <span className={cn("flex min-w-0 flex-col", className)} data-special-days="">
      {labels.slice(0, max).map((label) => (
        <span
          key={label.key}
          title={label.title}
          className={cn("truncate text-caption leading-[14px]", LABEL_TONES[label.tone])}
        >
          {label.text}
        </span>
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((l) => l.title).join("\n")}
          className="text-caption leading-[14px] text-fg-3"
        >
          +{rest.length} özel gün
        </span>
      )}
    </span>
  );
}

/** "Benzer: 12 Ekim postu" with every match in the tooltip; nothing without marks. */
export function SimilarMark({ item }: { item: Partial<Pick<PlanItem, "similar">> }) {
  const text = similarText(item);
  if (!text) return null;
  return (
    <span title={similarTitle(item)} className="inline-flex max-w-full shrink-0">
      <TagPill tone="warning">{text}</TagPill>
    </span>
  );
}
