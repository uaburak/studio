// "Ayrıntı": the original (often English) text behind a short Turkish error message, folded
// away under it (lib/api.ts `explainError`).
import { cn } from "./controls.tsx";

export function ErrorDetail({
  detail,
  className,
}: {
  detail: string | null | undefined;
  className?: string;
}) {
  if (!detail) return null;
  return (
    <details className={cn("text-caption text-fg-3", className)}>
      <summary className="w-fit cursor-default select-none hover:text-fg-2">Ayrıntı</summary>
      <div className="selectable mt-0.5 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
        {detail}
      </div>
    </details>
  );
}
