// The canvas import's CSS → Wecra conversions (fidelity.ts, no engine needed), the import report
// the canvas shows, the media picker of an image slot and the kit's logos.
import type { ApiClient, Asset } from "@studio/contract";
import { parseBrandTokens } from "@studio/design-kit/brand";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { mediaKeys } from "../../src/renderer/features/media/media-data.ts";
import {
  kitLogos,
  MediaPickerDialog,
} from "../../src/renderer/features/post-editor/ui/canvas-assets.tsx";
import {
  ImportReport,
  reportLines,
  reportSummary,
} from "../../src/renderer/features/post-editor/ui/import-report.tsx";
import {
  backgroundPlacement,
  cssColor,
  decompose,
  filterEffects,
  gradientPaint,
  type Matrix,
  objectFitPlacement,
  polygonPoints,
  shadowEffects,
} from "../../src/renderer/features/post-editor/wecra/fidelity.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";

// The live job feed (StudioProvider) is not mounted here: no jobs, worker offline.
vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, useJobs: () => ({ jobs: [], presence: null, controller: {} }) };
});

/** Where a gradient paint's colour parameter is at a point of the box (Figma's model). */
const linearT = (m: Matrix, u: number, v: number) => m.m00 * u + m.m01 * v + m.m02;
const radialT = (m: Matrix, u: number, v: number) => {
  const gx = m.m00 * u + m.m01 * v + m.m02 - 0.5;
  const gy = m.m10 * u + m.m11 * v + m.m12 - 0.5;
  return 2 * Math.hypot(gx, gy);
};

describe("CSS gradients as Wecra paints", () => {
  it("runs a linear gradient at any angle as CSS does (its line through the centre, corners at 0 and 1)", () => {
    // 135deg in a 400 × 200 box: from the top-left corner's line to the bottom-right's.
    const { paint } = gradientPaint(
      "linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
      400,
      200,
    );
    const m = paint?.transform as Matrix;
    expect(paint?.type).toBe("GRADIENT_LINEAR");
    expect(linearT(m, 0, 0)).toBeCloseTo(0, 3);
    expect(linearT(m, 1, 1)).toBeCloseTo(1, 3);
    expect(linearT(m, 0.5, 0.5)).toBeCloseTo(0.5, 3);
    // "to right bottom": the 50 % line joins the other two corners (CSS's magic corners).
    const corner = gradientPaint(
      "linear-gradient(to right bottom, rgb(0, 0, 0), rgb(255, 255, 255))",
      400,
      200,
    );
    const c = corner.paint?.transform as Matrix;
    expect(linearT(c, 1, 0)).toBeCloseTo(0.5, 3);
    expect(linearT(c, 0, 1)).toBeCloseTo(0.5, 3);
    expect(linearT(c, 0, 0)).toBeCloseTo(0, 3);
    // 180deg, the old four directions, stays what Wecra's converter made.
    const down = gradientPaint(
      "linear-gradient(rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0.6))",
      100,
      100,
    );
    expect(down.paint?.transform).toEqual({ m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 });
    expect(down.paint?.stops).toEqual([
      { color: "#00000000", position: 0.4 },
      { color: "#00000099", position: 1 },
    ]);
  });

  it("places a radial gradient's centre and radius, and reads stops in px and beyond 100 %", () => {
    const { paint } = gradientPaint(
      "radial-gradient(circle at 30% 40%, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100px)",
      400,
      200,
    );
    const m = paint?.transform as Matrix;
    expect(radialT(m, 0.3, 0.4)).toBeCloseTo(0, 3);
    // The ray reaches the farthest corner (a circle: 280 × 120 px away); 100 px out is the last stop.
    expect(radialT(m, 1, 1)).toBeCloseTo(1, 3);
    const stops = (paint?.stops ?? []) as { position: number }[];
    const last = stops[1]?.position ?? 0;
    expect(radialT(m, 0.3 + 100 / 400, 0.4)).toBeCloseTo(last, 3);
    expect(last).toBeCloseTo(100 / Math.hypot(280, 120), 3);
    const far = gradientPaint(
      "radial-gradient(farthest-side at 70% 30%, rgb(255, 255, 255) 0%, rgba(255, 255, 255, 0) 100%)",
      460,
      260,
    );
    const f = far.paint?.transform as Matrix;
    // An ellipse to the farthest sides: 70 % of 460 to the left edge, 70 % of 260 to the bottom.
    expect(radialT(f, 0, 0.3)).toBeCloseTo(1, 3);
    expect(radialT(f, 0.7, 1)).toBeCloseTo(1, 3);
    const beyond = gradientPaint(
      "linear-gradient(90deg, rgb(0, 0, 0) -20%, rgb(255, 255, 255) 120%)",
      100,
      100,
    );
    expect(beyond.paint?.stops).toEqual([
      { color: "#000000FF", position: 0 },
      { color: "#FFFFFFFF", position: 1 },
    ]);
    expect(linearT(beyond.paint?.transform as Matrix, 0.5, 0.5)).toBeCloseTo(0.5, 3);
  });

  it("makes a conic gradient an angular one and says why a repeating one isn't carried over", () => {
    const conic = gradientPaint(
      "conic-gradient(from 45deg, rgb(255, 0, 0), rgb(0, 0, 255))",
      300,
      300,
    );
    expect(conic.paint?.type).toBe("GRADIENT_ANGULAR");
    const rep = gradientPaint(
      "repeating-linear-gradient(135deg, rgb(0, 0, 0) 0px 2px, rgba(0, 0, 0, 0) 2px 22px)",
      300,
      300,
    );
    expect(rep).toEqual({ paint: null, problem: "tekrarlayan renk geçişi aktarılamadı" });
  });

  it("reads the colours the browser computes (rgb, rgba, color(srgb …), hex)", () => {
    expect(cssColor("rgb(102, 176, 82)")).toBe("#66B052FF");
    expect(cssColor("rgba(0, 0, 0, 0.6)")).toBe("#00000099");
    expect(cssColor("color(srgb 1 0.5 0 / 0.07)")).toBe("#FF800012");
    expect(cssColor("#abc")).toBe("#AABBCCFF");
    expect(cssColor("oklch(0.7 0.1 120)")).toBe(null);
  });
});

describe("pictures, effects and transforms", () => {
  it("keeps an off-centre crop as a Crop window, a centred cover as Fill", () => {
    expect(objectFitPlacement("cover", "50% 50%", [1200, 1200], { w: 600, h: 400 })).toEqual({
      scaleMode: "FILL",
    });
    const off = objectFitPlacement("cover", "20% 80%", [1200, 1200], { w: 600, h: 400 });
    expect(off.scaleMode).toBe("CROP");
    expect(off.transform?.m11).toBeCloseTo(400 / 600, 4);
    expect(off.transform?.m12).toBeCloseTo(160 / 600, 4);
    expect(objectFitPlacement("contain", "0% 0%", [1200, 600], { w: 600, h: 600 })).toEqual({
      scaleMode: "FIT",
      problem: "görselin konumu ortalandı",
    });
    expect(objectFitPlacement("fill", undefined, [10, 10], { w: 600, h: 600 }).scaleMode).toBe(
      "CROP",
    );
    const bg = backgroundPlacement("cover", "50% 30%", "no-repeat", [1200, 1200], {
      w: 960,
      h: 360,
    });
    expect(bg.transform?.m12).toBeCloseTo(180 / 960, 4);
    expect(
      backgroundPlacement("100px 100px", "0% 0%", "repeat", [50, 50], { w: 400, h: 400 }).problem,
    ).toBe("döşenen arka plan görseli tek görsel olarak aktarıldı");
  });

  it("turns text-shadow and filters into Wecra's effects, the rest into the report", () => {
    expect(shadowEffects("rgba(0, 0, 0, 0.45) 0px 2px 12px")).toEqual([
      {
        type: "DROP_SHADOW",
        color: "#00000073",
        offset: { x: 0, y: 2 },
        radius: 12,
        spread: 0,
        visible: true,
        blendMode: "NORMAL",
      },
    ]);
    expect(filterEffects("blur(4px) grayscale(1)")).toEqual({
      effects: [{ type: "LAYER_BLUR", radius: 8, visible: true }],
      unsupported: ["grayscale"],
    });
    expect(polygonPoints("polygon(25% 0%, 75% 0%, 100% 50%)", 200, 100)).toBe("50,0 150,0 200,50");
    expect(
      decompose([Math.cos(0.3), Math.sin(0.3), -Math.sin(0.3), Math.cos(0.3), 0, 0]).rotation,
    ).toBeCloseTo(17.19, 1);
    expect(decompose([-1, 0, 0, 1, 0, 0]).mirrored).toBe(true);
  });
});

describe("the import report", () => {
  const report = [
    { slide: 0, layer: "headline", what: "dengeli satır kırılımı satır sonlarıyla korundu" },
    { slide: 0, layer: "photo", what: "filtre aktarılamadı (grayscale)" },
    { slide: 0, layer: "photo", what: "görselin konumu ortalandı" },
    { slide: 1, layer: "scrim", what: "maske aktarılamadı" },
  ];

  it("says it per layer, in Turkish", () => {
    expect(reportSummary(report)).toBe("Tuvale aktarırken değişenler: 3 katman");
    expect(reportLines(report)).toEqual([
      "Kare 1 · headline: dengeli satır kırılımı satır sonlarıyla korundu",
      "Kare 1 · photo: filtre aktarılamadı (grayscale); görselin konumu ortalandı",
      "Kare 2 · scrim: maske aktarılamadı",
    ]);
  });

  it("shows the summary, opens into the list and closes for this version", () => {
    const { unmount } = render(<ImportReport report={report} versionKey="v-7" />);
    expect(screen.getByText("Tuvale aktarırken değişenler: 3 katman")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Göster" }));
    expect(screen.getByText("Kare 2 · scrim: maske aktarılamadı")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tamam" }));
    expect(screen.queryByText(/Tuvale aktarırken/)).toBe(null);
    unmount();
    // Not again for that version.
    render(<ImportReport report={report} versionKey="v-7" />);
    expect(screen.queryByText(/Tuvale aktarırken/)).toBe(null);
  });
});

const asset = (id: string, name: string): Asset => ({
  id,
  brandId: "b1",
  kind: "image",
  source: "upload",
  objectKey: id,
  mimeType: "image/jpeg",
  bytes: 10,
  sha256: "0".repeat(64),
  width: 100,
  height: 100,
  durationMs: null,
  originalFilename: name,
  createdAt: "2026-11-17T10:00:00.000Z",
});

function providers(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(mediaKeys.assets("b1"), [
    asset("a1", "tarla.jpg"),
    asset("a2", "paket.jpg"),
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={{} as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

describe("an image slot's media picker", () => {
  it("lists the brand's pictures to pick one, or a file to upload", () => {
    const onPick = vi.fn();
    providers(
      <MediaPickerDialog open brandId="b1" onPick={onPick} onFile={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("dialog", { name: "Görsel seç" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Medyada ara"), { target: { value: "tarla" } });
    const tiles = screen.getAllByRole("button", { name: /Görseli aç/ });
    expect(tiles).toHaveLength(1);
    fireEvent.click(tiles[0] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    expect(screen.getByRole("button", { name: "Bilgisayardan yükle…" })).toBeTruthy();
  });

  it("offers the kit's logos that have a file", () => {
    const tokens = parseBrandTokens({
      color: { ink: "#111111" },
      font: { text: { family: "Inter" } },
      logos: {
        dark: { path: "logos/a.png", intrinsic: [600, 100], on: "light" },
        light: { path: "logos/b.png", aspect: 6, on: "dark" },
        missing: { path: "logos/c.png" },
      },
    });
    expect(kitLogos({ tokens, files: { "logos/a.png": "x", "logos/b.png": "y" } })).toEqual([
      { token: "dark", path: "logos/a.png", aspect: 6, on: "light" },
      { token: "light", path: "logos/b.png", aspect: 6, on: "dark" },
    ]);
  });
});
