// The heart next to an approved post's "Onaylandı": Instagram's filled heart, which takes the
// approval back (after a short confirmation). On a scheduled post it is disabled and says why
// ("Önce zamanlamayı iptal et").
import { cn } from "../../components/ui/controls.tsx";
import { InstaLikeFilled } from "../../components/ui/insta-icons.tsx";

/** The opened post's "Onayı geri al": the heart in the title bar and the "…" menu's entry. */
export interface RevokeControl {
  /** "ok", or why the approval cannot be taken back; null: the post has no approval. */
  state: "ok" | string | null;
  /** Asks first (the post layer's confirmation); null when there is nothing to take back. */
  onRevoke: (() => void) | null;
}

export function ApprovalHeart({
  state,
  onRevoke,
  className,
}: {
  /** "ok", or why the approval cannot be taken back; null: no approval (nothing is shown). */
  state: "ok" | string | null;
  onRevoke: (() => void) | null;
  className?: string;
}) {
  if (state === null || !onRevoke) return null;
  const can = state === "ok";
  const label = can ? "Onayı geri al" : `Onayı geri al: ${state}`;
  // The tooltip sits on a wrapper: a disabled button shows none.
  return (
    <span title={can ? "Onayı geri al" : state} className={cn("inline-flex shrink-0", className)}>
      <button
        type="button"
        aria-label={label}
        disabled={!can}
        onClick={onRevoke}
        className={cn(
          "no-drag flex size-7 items-center justify-center rounded-full text-danger transition-colors",
          can ? "hover:bg-control" : "opacity-50",
        )}
      >
        <InstaLikeFilled size={16} />
      </button>
    </span>
  );
}
