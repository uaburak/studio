import { env } from "cloudflare:workers";
import { Asset, BrandKit } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, BASE, createBrand, expectError, localFetch } from "./helpers.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function upload(
  brandId: string,
  kind: string,
  file: { bytes: Uint8Array<ArrayBuffer> | string; type: string; name: string },
) {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("kind", kind);
  form.set("file", new File([file.bytes], file.name, { type: file.type }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

const png = (name: string) => ({ bytes: PNG, type: "image/png", name });
const kitPath = (brandId: string) => `/api/brands/${brandId}/kit`;

describe("brand kit", () => {
  it("is empty until saved, then stores logos, fonts, palette, samples and notes", async () => {
    const brand = await createBrand();
    const empty = BrandKit.parse((await api("GET", kitPath(brand.id))).body);
    expect(empty).toEqual({
      brandId: brand.id,
      logos: [],
      fonts: [],
      palette: [],
      samples: [],
      notes: "",
      updatedAt: null,
    });

    const logo = await upload(brand.id, "logo", png("logo.png"));
    const logoDark = await upload(brand.id, "logo", png("logo-beyaz.png"));
    const font = await upload(brand.id, "font", {
      bytes: "wOF2fake",
      type: "font/woff2",
      name: "Archivo.woff2",
    });
    const samples = await Promise.all(
      ["a", "b", "c"].map((n) => upload(brand.id, "image", png(`${n}.png`))),
    );

    const res = await api("PUT", kitPath(brand.id), {
      logos: [
        { assetId: logo.id, background: "light" },
        { assetId: logoDark.id, background: "dark", label: "Beyaz" },
      ],
      fonts: [
        { assetId: font.id, family: "Archivo", role: "display", licenseNote: "SIL OFL 1.1" },
        // A font installed on the Mac: no file, used by family name.
        {
          source: "system",
          family: "Avenir Next",
          role: "text",
          styles: [
            { name: "Regular", weight: 400, postscriptName: "AvenirNext-Regular" },
            { name: "Demi Bold", weight: 600 },
          ],
        },
      ],
      palette: [{ name: "accent", hex: "#ff6a00", use: "ana vurgu" }],
      samples: samples.map((s, i) => ({
        assetId: s.id,
        ...(i === 0 ? { caption: "İlk post" } : {}),
      })),
      notes: "Kurumsal ama sıcak",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = BrandKit.parse(res.body);
    expect(saved.palette).toEqual([{ name: "accent", hex: "#FF6A00", use: "ana vurgu" }]);
    expect(saved.logos.map((l) => l.background)).toEqual(["light", "dark"]);
    expect(saved.fonts[0]?.licenseNote).toBe("SIL OFL 1.1");
    expect(saved.fonts[0]?.source).toBe("file");
    expect(saved.fonts[1]).toMatchObject({
      source: "system",
      family: "Avenir Next",
      styles: [
        { name: "Regular", weight: 400, italic: false, postscriptName: "AvenirNext-Regular" },
        { name: "Demi Bold", weight: 600, italic: false },
      ],
    });
    expect(saved.fonts[1]?.assetId).toBeUndefined();
    expect(saved.samples).toHaveLength(3);
    expect(saved.updatedAt).not.toBeNull();

    const again = BrandKit.parse((await api("GET", kitPath(brand.id))).body);
    expect(again).toEqual(saved);
    // Stored next to the brand's files, not in D1.
    expect(await env.MEDIA.head(`brands/${brand.id}/kit.json`)).not.toBeNull();
  });

  it("refuses files of another brand, wrong kinds and bad input", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const foreign = await upload(other.id, "image", png("x.png"));
    const image = await upload(brand.id, "image", png("y.png"));

    const wrongBrand = expectError(
      await api("PUT", kitPath(brand.id), { samples: [{ assetId: foreign.id }] }),
      400,
      "validation_error",
    );
    expect(wrongBrand.issues?.[0]).toMatchObject({ path: "samples.0.assetId" });

    const wrongKind = expectError(
      await api("PUT", kitPath(brand.id), {
        fonts: [{ assetId: image.id, family: "Archivo" }],
      }),
      400,
      "validation_error",
    );
    expect(wrongKind.issues?.[0]?.message).toContain("image");

    expectError(
      await api("PUT", kitPath(brand.id), { palette: [{ name: "accent", hex: "red" }] }),
      400,
      "validation_error",
    );
    // A file font needs its file; a system font has none; the same system family twice is refused.
    expectError(
      await api("PUT", kitPath(brand.id), { fonts: [{ family: "Archivo" }] }),
      400,
      "validation_error",
    );
    expectError(
      await api("PUT", kitPath(brand.id), {
        fonts: [{ source: "system", assetId: image.id, family: "Archivo" }],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("PUT", kitPath(brand.id), {
        fonts: [
          { source: "system", family: "Avenir Next" },
          { source: "system", family: "avenir next", role: "text" },
        ],
      }),
      400,
      "validation_error",
    );
    expectError(await api("GET", kitPath("missing-brand")), 404, "not_found");
    expectError(await api("PUT", kitPath("missing-brand"), {}), 404, "not_found");
  });
});
