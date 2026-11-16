import type { Content } from "@studio/contract";
import { SlideFrame } from "../../components/slide-preview.tsx";
import { CONTENT_TYPE_LABELS } from "../../lib/labels.ts";
import { useInView } from "../../lib/use-in-view.ts";
import { useContentVersion } from "./hooks.ts";

/** First slide of the current version, fetched only when scrolled into view. */
export function ContentThumb({ content }: { content: Content }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const version = useContentVersion(content.id, content.currentVersion?.version, inView);
  const slide = version.data?.slides[0];
  const count = version.data?.slides.length ?? 0;

  return (
    <div
      ref={ref}
      className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-stage p-4"
    >
      {slide ? (
        <SlideFrame
          slide={slide}
          label={`${content.title} önizlemesi`}
          className="h-full items-center"
          maxHeight={260}
        />
      ) : content.currentVersion ? (
        <div className="skeleton h-4/5 w-3/4 rounded" />
      ) : (
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-display text-[34px] leading-none text-ink-3 italic">
            {CONTENT_TYPE_LABELS[content.type]}
          </span>
          <span className="text-[12px] text-ink-3">Henüz sürüm yok</span>
        </div>
      )}
      {count > 1 && (
        <span className="absolute top-2.5 right-2.5 rounded-full bg-ink/75 px-2 py-0.5 font-mono text-[11px] text-bg">
          1/{count}
        </span>
      )}
    </div>
  );
}
