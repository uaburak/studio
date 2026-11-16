import type { Slide } from "@studio/contract";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildSlideSrcdoc,
  describeArtboard,
  fitScale,
  SLIDE_SANDBOX,
  stepIndex,
} from "../lib/slide-preview.ts";
import { IconChevronLeft, IconChevronRight } from "./icons.tsx";
import { cx, IconButton } from "./ui.tsx";

type SlideLike = Pick<Slide, "html" | "width" | "height">;

/** Width of the element, tracked with ResizeObserver. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || undefined);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * One artboard, rendered at native size inside a script-less sandboxed iframe
 * with a no-network CSP, scaled down to fit. Not interactive.
 */
export function SlideFrame({
  slide,
  label,
  maxHeight,
  fixedWidth,
  className,
}: {
  slide: SlideLike;
  label: string;
  /** Cap on rendered height in CSS px. */
  maxHeight?: number;
  /** Render at exactly this width (thumbnails) instead of measuring. */
  fixedWidth?: number;
  className?: string;
}) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const boxWidth = fixedWidth ?? measured;
  const scale = fitScale(slide, {
    ...(boxWidth !== undefined ? { width: boxWidth } : {}),
    ...(maxHeight !== undefined ? { height: maxHeight } : {}),
  });
  const srcDoc = useMemo(() => buildSlideSrcdoc(slide.html), [slide.html]);
  const w = Math.floor(slide.width * scale);
  const h = Math.floor(slide.height * scale);

  return (
    <div
      ref={ref}
      className={cx("flex w-full justify-center", className)}
      style={fixedWidth ? { width: fixedWidth } : undefined}
    >
      <div
        role="img"
        aria-label={label}
        className="checker relative overflow-hidden rounded-[4px] shadow-card ring-1 ring-black/5"
        style={{
          width: w || "100%",
          height: h || undefined,
          aspectRatio: h ? undefined : `${slide.width} / ${slide.height}`,
        }}
      >
        {scale > 0 && (
          <iframe
            title={label}
            sandbox={SLIDE_SANDBOX}
            srcDoc={srcDoc}
            referrerPolicy="no-referrer"
            loading="lazy"
            tabIndex={-1}
            aria-hidden="true"
            width={slide.width}
            height={slide.height}
            className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-white"
            style={{ transform: `scale(${scale})` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Carousel of slides: arrows, keyboard (← →), counter and a thumbnail strip.
 */
export function SlideCarousel({
  slides,
  maxHeight = 640,
  title = "Önizleme",
}: {
  slides: SlideLike[];
  maxHeight?: number;
  title?: string;
}) {
  const [index, setIndex] = useState(0);
  const count = slides.length;

  useEffect(() => {
    if (index >= count) setIndex(Math.max(0, count - 1));
  }, [count, index]);

  const current = slides[Math.min(index, count - 1)];
  if (!current) return null;

  const go = (delta: number) => setIndex((i) => stepIndex(i, delta, count));
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    }
  };

  return (
    // ← → work while focus is on any carousel control (arrows or thumbnails).
    <section
      aria-roledescription="carousel"
      aria-label={title}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4"
    >
      <div className="relative rounded-2xl bg-stage px-3 py-6 sm:px-10 sm:py-8">
        <SlideFrame
          key={index}
          slide={current}
          label={`Slayt ${index + 1} / ${count}`}
          maxHeight={maxHeight}
        />
        {count > 1 && (
          <>
            <IconButton
              label="Önceki slayt"
              onClick={() => go(-1)}
              disabled={index === 0}
              className="absolute top-1/2 left-1 -translate-y-1/2 bg-surface/90 shadow-card backdrop-blur sm:left-2"
            >
              <IconChevronLeft />
            </IconButton>
            <IconButton
              label="Sonraki slayt"
              onClick={() => go(1)}
              disabled={index === count - 1}
              className="absolute top-1/2 right-1 -translate-y-1/2 bg-surface/90 shadow-card backdrop-blur sm:right-2"
            >
              <IconChevronRight />
            </IconButton>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 text-[13px] text-ink-3">
        <span aria-live="polite" className="font-mono tabular-nums">
          {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
        </span>
        <span className="font-mono">{describeArtboard(current)}</span>
      </div>

      {count > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {slides.map((slide, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Slayt ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => setIndex(i)}
              className={cx(
                "shrink-0 rounded-md p-0.5 ring-2 transition-[box-shadow,opacity]",
                i === index ? "ring-accent" : "opacity-60 ring-transparent hover:opacity-100",
              )}
            >
              <SlideFrame slide={slide} label={`Slayt ${i + 1} küçük resmi`} fixedWidth={56} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
