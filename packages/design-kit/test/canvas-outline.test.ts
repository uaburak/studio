// A canvas slide as the chat agent reads it (`canvasOutline`, S1): every layer with the Wecra id
// the canvas operations take, its kind, box, paint and text, the contract meaning the import
// kept; compact (defaults left out, long texts clipped).
import { describe, expect, it } from "vitest";
import { canvasOutline } from "../src/canvas/index.ts";
import { canvasFacts } from "./canvas-fixture.ts";

describe("canvas outline", () => {
  it("lists every layer by Wecra id with its box, paint, text and contract meaning", () => {
    const outline = canvasOutline(canvasFacts(), 2);
    expect(outline).toMatchObject({
      slide: 2,
      frameId: expect.any(String),
      width: 1080,
      height: 1350,
    });
    const [headline, body, slot, logo] = outline.layers;
    expect(headline).toEqual({
      id: "7:2",
      name: "headline",
      type: "text",
      wecraType: "TEXT",
      parent: null,
      box: [80, 200, 600, 96],
      text: {
        characters: "Hasat bitti",
        font: "Archivo Extra Bold",
        size: 80,
        weight: 800,
        color: "#1D2A1B",
        align: "left",
        lineHeight: 96,
      },
      contract: { layer: "headline", type: "text", role: "headline" },
    });
    expect(body?.text?.characters).toBe("Toprağınız için bor\nve çinko.");
    expect(slot).toMatchObject({
      id: "7:4",
      fills: ["#E0D9C8"],
      contract: { layer: "field-photo", type: "slot", slot: "Saha fotoğrafı" },
    });
    expect(logo).toMatchObject({ id: "7:5", fills: ["image(fit)"], contract: { type: "logo" } });
  });

  it("marks hidden, faded, rotated and overflowing layers; clips long texts and busy slides", () => {
    const facts = canvasFacts((nodes) =>
      nodes.map((n, i) =>
        i === 0 && n.text
          ? {
              ...n,
              visible: false,
              opacity: 0.5,
              rotation: 12,
              text: { ...n.text, characters: "x".repeat(900), overflow: true },
            }
          : n,
      ),
    );
    const outline = canvasOutline(facts, 1, 2);
    expect(outline.layers[0]).toMatchObject({
      hidden: true,
      opacity: 0.5,
      rotation: 12,
      text: { overflow: true },
    });
    expect(outline.layers[0]?.text?.characters).toHaveLength(400);
    expect(outline.layers).toHaveLength(2);
    expect(outline.more).toBe(facts.nodes.length - 2);
  });
});
