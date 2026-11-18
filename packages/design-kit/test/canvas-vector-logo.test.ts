/**
 * A logo the canvas imported as its SVG file's vectors (a frame of vector layers, no picture,
 * marked `vector`): still the brand's logo for the slide HTML and the checks; without the mark,
 * or with a file outside the brand's logos, it is not.
 */
import { describe, expect, it } from "vitest";
import { type CanvasNode, canvasLayers } from "../src/canvas/index.ts";
import { canvasFacts } from "./canvas-fixture.ts";

const vectorLogo = (mark: Partial<NonNullable<CanvasNode["mark"]>> = {}) =>
  canvasFacts((nodes) =>
    nodes.map((n) =>
      n.name === "logo"
        ? {
            ...n,
            type: "frame" as const,
            wecraType: "FRAME",
            fills: [],
            mark: {
              ...(n.mark as NonNullable<CanvasNode["mark"]>),
              src: "/brand/logos/venta.svg",
              image: null,
              vector: true,
              ...mark,
            },
          }
        : n,
    ),
  );

describe("a vector logo on the canvas", () => {
  it("is the brand's logo by its file", () => {
    const logo = canvasLayers(vectorLogo()).find((l) => l.id === "logo");
    expect(logo).toMatchObject({ type: "logo", src: "/brand/logos/venta.svg", image: null });
    expect(logo?.rect).toEqual({ x: 80, y: 1180, w: 240, h: 80 });
  });

  it("is not without the vector mark or outside the brand's logos", () => {
    expect(canvasLayers(vectorLogo({ vector: undefined })).some((l) => l.type === "logo")).toBe(
      false,
    );
    expect(canvasLayers(vectorLogo({ src: "/media/x.svg" })).some((l) => l.type === "logo")).toBe(
      false,
    );
  });
});
