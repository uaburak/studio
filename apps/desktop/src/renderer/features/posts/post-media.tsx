// What a post looks like at a glance: its first rendered slide (a reel's cover), or the Wecra
// placeholder (a gradient with the brand eyebrow and the title) until a render exists.
import { type ContentVersion, readReelVersionInfo } from "@studio/contract";
import { cn } from "../../components/ui/controls.tsx";
import { IconPlay } from "../../components/ui/icons.tsx";
import { assetUrl } from "../../lib/api.ts";
import { thumbUrl } from "../../lib/thumbnail.ts";

/** CSS widths the small sizes are shown at (their thumbnails are asked for at this width). */
const CARD_WIDTH = 320;
const THUMB_WIDTH = 120;

/** The Wecra "Post card" media gradients (green, blue, orange, yellow). */
export const PLACEHOLDER_GRADIENTS = [
  "linear-gradient(180deg, #9CC57A 0%, #2F5D2A 100%)",
  "linear-gradient(180deg, #7DB3D9 0%, #2A4F6E 100%)",
  "linear-gradient(180deg, #E8A04A 0%, #8C4A16 60%, #3B2410 100%)",
  "linear-gradient(180deg, #F2D27A 0%, #A6741F 100%)",
];

/** Stable per id (FNV-1a), so a post keeps its placeholder across launches. */
export function stableIndex(id: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

/** The picture of a post: a reel's cover, else its first rendered slide. */
export function coverAssetId(version: ContentVersion | null, isReel: boolean): string | null {
  const first = version?.slides[0];
  if (!first) return null;
  if (isReel) {
    const info = readReelVersionInfo(first.html);
    return info.coverAssetId ?? first.renderedAssetId ?? null;
  }
  return first.renderedAssetId ?? null;
}

/** "0:12" */
export function durationText(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function PostMedia({
  contentId,
  title,
  brandName,
  version,
  isReel,
  size = "card",
  className,
}: {
  contentId: string;
  title: string;
  brandName?: string | undefined;
  version: ContentVersion | null;
  isReel: boolean;
  size?: "card" | "large" | "thumb";
  /** Positions it (`absolute inset-0` in a sized box, or `relative` with a size). */
  className?: string;
}) {
  const assetId = coverAssetId(version, isReel);
  const reel = isReel && version?.slides[0] ? readReelVersionInfo(version.slides[0].html) : null;
  const duration = durationText(reel?.durationMs);
  return (
    <div
      className={cn("overflow-hidden bg-control", className)}
      style={
        assetId
          ? undefined
          : {
              background:
                PLACEHOLDER_GRADIENTS[stableIndex(contentId, PLACEHOLDER_GRADIENTS.length)],
            }
      }
    >
      {assetId ? (
        <img
          src={
            size === "large"
              ? assetUrl(assetId)
              : thumbUrl(assetId, size === "thumb" ? THUMB_WIDTH : CARD_WIDTH)
          }
          alt=""
          draggable={false}
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        size !== "thumb" && (
          <>
            {brandName && (
              <span
                className={cn(
                  "absolute font-semibold text-white uppercase",
                  size === "large"
                    ? "top-7 left-7 text-heading"
                    : "top-3.5 left-3.5 text-[10px] tracking-[1px]",
                )}
              >
                {brandName}
              </span>
            )}
            <span
              className={cn(
                "absolute right-3.5 font-bold text-white [overflow-wrap:anywhere]",
                size === "large"
                  ? "bottom-10 left-7 text-[40px] leading-[46px]"
                  : "bottom-7 left-3.5 line-clamp-3 text-[20px] leading-6",
              )}
            >
              {title}
            </span>
          </>
        )
      )}
      {isReel && size !== "large" && (
        <span className="absolute right-2 bottom-2 flex h-5 items-center gap-1 rounded-full bg-black/55 px-1.5 text-caption text-white">
          <IconPlay size={10} fill="currentColor" strokeWidth={0} />
          {duration ?? "Reels"}
        </span>
      )}
    </div>
  );
}
