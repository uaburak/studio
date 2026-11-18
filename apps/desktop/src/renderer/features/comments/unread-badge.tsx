// The sidebar's unread comment count ("Yorumlar 3"); nothing when there are none.
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-label={`${count} okunmamış yorum`}
      className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-caption font-medium text-on-accent tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
