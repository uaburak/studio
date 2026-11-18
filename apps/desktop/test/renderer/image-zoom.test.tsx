import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionGlobalConfig } from "motion/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ImageGrid } from "../../src/renderer/components/chat/images.tsx";
import { Lightbox } from "../../src/renderer/components/chat/lightbox.tsx";
import { ZoomableImage } from "../../src/renderer/components/ui/zoomable-image.tsx";
import {
  bakeTransform,
  containRect,
  DISMISS_DISTANCE,
  dismissDrag,
  parseRadius,
  shouldDismiss,
  viewerFrame,
  visibleFraction,
} from "../../src/renderer/lib/lightbox.ts";
import { measureSource, sourceImage } from "../../src/renderer/lib/zoom-source.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";

const IMAGES = [
  { assetId: "a", url: "data:,a", caption: "@bir", width: 800, height: 1000 },
  { assetId: "b", url: "data:,b", caption: "@iki", width: 1200, height: 800 },
  { assetId: "c", url: "data:,c", caption: "@üç", width: 1000, height: 1000 },
];

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
afterEach(() => {
  act(() => useAppStore.setState({ lightbox: null }));
});

const thumbnail = (name: string) =>
  screen.getByRole("button", { name: `Görseli aç: ${name}` }).querySelector("img") as HTMLElement;
const dialog = () => screen.queryByRole("dialog", { name: "Görsel" });
const gone = () => waitFor(() => expect(dialog()).toBeNull());

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

describe("zoom geometry", () => {
  it("drag to dismiss follows the pointer, shrinks going down and damps going up", () => {
    expect(dismissDrag(30, 0, 800)).toEqual({ x: 30, y: 0, scale: 1, progress: 0 });
    const half = dismissDrag(0, 200, 800);
    expect(half.progress).toBeCloseTo(0.5);
    expect(half.scale).toBeCloseTo(0.8);
    expect(dismissDrag(0, 2000, 800)).toMatchObject({ progress: 1, scale: 0.6 });
    expect(dismissDrag(0, -100, 800)).toMatchObject({ y: -30, scale: 1, progress: 0 });
  });

  it("dismisses past the distance or on a flick down, never on a flick back up", () => {
    expect(shouldDismiss(DISMISS_DISTANCE + 1, 0)).toBe(true);
    expect(shouldDismiss(60, 0)).toBe(false);
    expect(shouldDismiss(40, 900)).toBe(true);
    expect(shouldDismiss(8, 900)).toBe(false);
    expect(shouldDismiss(300, -500)).toBe(false);
  });

  it("measures what shows of a thumbnail and its corners", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(visibleFraction(box, [{ x: 0, y: 50, width: 500, height: 500 }])).toBeCloseTo(0.5);
    expect(visibleFraction(box, [{ x: 200, y: 0, width: 100, height: 100 }])).toBe(0);
    expect(parseRadius("12px", 100, 80)).toBe(12);
    expect(parseRadius("50%", 24, 24)).toBe(12);
    expect(parseRadius("3.40282e38px", 24, 30)).toBe(12);
    expect(parseRadius("", 24, 24)).toBe(0);
    // A logo drawn with object-fit: contain fills only its picture's box.
    expect(containRect({ x: 0, y: 0, width: 200, height: 100 }, { width: 50, height: 50 })).toEqual(
      { x: 50, y: 0, width: 100, height: 100 },
    );
  });

  it("folds a drag or zoom transform into the frame the close starts from", () => {
    const frame = viewerFrame({ x: 100, y: 100, width: 400, height: 500 });
    expect(bakeTransform(frame, { x: 10, y: 200, scale: 0.5 })).toEqual({
      x: 210,
      y: 425,
      width: 200,
      height: 250,
      radius: [6, 6, 6, 6],
    });
  });
});

describe("thumbnail measuring", () => {
  it("finds the picture and the rounded tile clipping it; null when gone or scrolled away", () => {
    render(
      <div data-testid="list" style={{ overflowY: "auto" }}>
        <div
          data-testid="tile"
          style={{
            overflowX: "hidden",
            overflowY: "hidden",
            borderTopLeftRadius: "12px",
            borderBottomRightRadius: "50%",
          }}
        >
          <img alt="" src="data:,x" />
        </div>
      </div>,
    );
    const tile = screen.getByTestId("tile");
    const img = sourceImage(tile) as HTMLElement;
    expect(img.tagName).toBe("IMG");
    const list = screen.getByTestId("list");
    list.getBoundingClientRect = () => rect(0, 0, 400, 600);
    tile.getBoundingClientRect = () => rect(20, 30, 160, 200);
    img.getBoundingClientRect = () => rect(20, 30, 160, 200);
    expect(measureSource(img)).toEqual({
      x: 20,
      y: 30,
      width: 160,
      height: 200,
      radius: [12, 0, 80, 0],
    });
    // Scrolled up out of the list.
    tile.getBoundingClientRect = () => rect(20, -190, 160, 200);
    img.getBoundingClientRect = () => rect(20, -190, 160, 200);
    expect(measureSource(img)).toBeNull();
    expect(measureSource(null)).toBeNull();
    expect(measureSource(document.createElement("img"))).toBeNull();
  });
});

describe("image viewer", () => {
  it("opens a grid's picture, hides its thumbnail, pages and closes with Escape", async () => {
    render(
      <>
        <ImageGrid images={IMAGES} />
        <Lightbox />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Görseli aç: @iki" }));
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(thumbnail("@iki").style.visibility).toBe("hidden");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sonraki" })).toBeDisabled();
    expect(thumbnail("@iki").style.visibility).toBe("");
    expect(thumbnail("@üç").style.visibility).toBe("hidden");
    await userEvent.click(screen.getByRole("button", { name: "Önceki" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().lightbox).toBeNull();
    await gone();
    for (const name of ["@bir", "@iki", "@üç"]) expect(thumbnail(name).style.visibility).toBe("");
  });

  it("starts on the thumbnail: its place, size and corner radius", async () => {
    render(
      <>
        <ZoomableImage
          image={IMAGES[1] as (typeof IMAGES)[number]}
          // jsdom only computes longhands.
          style={{ overflowX: "hidden", overflowY: "hidden", borderTopLeftRadius: "8px" }}
        />
        <Lightbox />
      </>,
    );
    const button = screen.getByRole("button", { name: "Görseli aç: @iki" });
    const img = thumbnail("@iki");
    button.getBoundingClientRect = () => rect(40, 60, 168, 112);
    img.getBoundingClientRect = () => rect(40, 60, 168, 112);
    await userEvent.click(button);
    const frame = screen.getByTestId("lightbox-frame");
    expect(frame.style.left).toBe("40px");
    expect(frame.style.top).toBe("60px");
    expect(frame.style.width).toBe("168px");
    expect(frame.style.height).toBe("112px");
    expect(frame.style.borderTopLeftRadius).toBe("8px");
    expect(frame.style.opacity).toBe("1");
    fireEvent.keyDown(window, { key: "Escape" });
    await gone();
    expect(img.style.visibility).toBe("");
  });

  it("un-zooms on the first Escape, closes on a click outside", async () => {
    render(
      <>
        <ZoomableImage image={IMAGES[0] as (typeof IMAGES)[number]} />
        <Lightbox />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Görseli aç: @bir" }));
    expect(screen.queryByText("1 / 1")).toBeNull(); // alone: no paging
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().lightbox).not.toBeNull();
    fireEvent.mouseDown(dialog() as HTMLElement);
    expect(useAppStore.getState().lightbox).toBeNull();
    await gone();
  });

  it("fades without a thumbnail (none, or removed meanwhile) and does not crash", async () => {
    render(<Lightbox />);
    act(() => useAppStore.getState().openLightbox({ images: IMAGES, index: 0 }));
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    await gone();

    const detached = document.createElement("img");
    act(() =>
      useAppStore.getState().openLightbox({ images: IMAGES, index: 2, sourceOf: () => detached }),
    );
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    detached.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    await gone();
    expect(detached.style.visibility).toBe("");
  });

  it("drag down: a short drag springs back, a long one closes", async () => {
    render(<Lightbox />);
    act(() => useAppStore.getState().openLightbox({ images: IMAGES, index: 0 }));
    const frame = screen.getByTestId("lightbox-frame");
    const drag = (dy: number) => {
      fireEvent.pointerDown(frame, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
      fireEvent.pointerMove(frame, { pointerId: 1, clientX: 300, clientY: 300 + dy });
      fireEvent.pointerUp(frame, { pointerId: 1, clientX: 300, clientY: 300 + dy });
    };
    drag(40);
    expect(useAppStore.getState().lightbox).not.toBeNull();
    drag(DISMISS_DISTANCE + 60);
    expect(useAppStore.getState().lightbox).toBeNull();
    await gone();
  });
});
