import { describe, expect, it } from "vitest";
import {
  FontFiles,
  FontLister,
  faceOfFile,
  parseAppKitFonts,
  postscriptNameAt,
} from "../../src/main/fonts.ts";
import {
  cssWeightFromAppKit,
  defaultStyle,
  isKitFamilyName,
  weightFromStyle,
} from "../../src/shared/fonts.ts";

// What `osascript -l JavaScript` prints for NSFontManager (postscript, style, weight, traits).
const RAW = JSON.stringify([
  [
    "Avenir Next",
    [
      ["AvenirNext-Regular", "Regular", 5, 0],
      ["AvenirNext-DemiBoldItalic", "Demi Bold Italic", 8, 3],
      ["AvenirNext-UltraLight", "Ultra Light", 3, 0],
      ["AvenirNext-Heavy", "Heavy", 11, 2],
      ["AvenirNext-Regular", "Regular", 5, 0],
    ],
  ],
  [".SF NS", [["SFNS", "Regular", 5, 0]]],
  ["Andale Mono", [["AndaleMono", "Regular", 5, 1024]]],
  ["Söhne", [["Soehne-Kraftig", "Kräftig", 6, 0]]],
  ["Empty", []],
  "garbage",
]);

describe("installed fonts (AppKit)", () => {
  it("parses families and styles, sorted, without hidden or empty families", () => {
    const families = parseAppKitFonts(RAW);
    expect(families.map((f) => f.family)).toEqual(["Andale Mono", "Avenir Next", "Söhne"]);
    const avenir = families[1];
    expect(avenir?.styles).toEqual([
      { name: "Ultra Light", postscriptName: "AvenirNext-UltraLight", weight: 200, italic: false },
      { name: "Regular", postscriptName: "AvenirNext-Regular", weight: 400, italic: false },
      {
        name: "Demi Bold Italic",
        postscriptName: "AvenirNext-DemiBoldItalic",
        weight: 600,
        italic: true,
      },
      { name: "Heavy", postscriptName: "AvenirNext-Heavy", weight: 900, italic: false },
    ]);
    // A style name AppKit knows but the keyword table does not: AppKit's weight decides.
    expect(families[2]?.styles[0]?.weight).toBe(500);
    expect(avenir && defaultStyle(avenir)?.name).toBe("Regular");
  });

  it("maps style names and AppKit weights to CSS weights", () => {
    expect(weightFromStyle("SemiBold")).toBe(600);
    expect(weightFromStyle("Condensed ExtraBold")).toBe(800);
    expect(weightFromStyle("Book")).toBe(400);
    expect(weightFromStyle("Black Italic")).toBe(900);
    expect(weightFromStyle("W6", 8)).toBe(600);
    expect(cssWeightFromAppKit(9)).toBe(700);
    expect(isKitFamilyName("Söhne")).toBe(true);
    expect(isKitFamilyName("Bad'Name")).toBe(false);
  });

  it("caches the list until a font folder changes or a refresh is asked", async () => {
    let runs = 0;
    let signature = "a";
    const lister = new FontLister({
      run: async () => {
        runs++;
        return RAW;
      },
      signature: async () => signature,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const first = await lister.list();
    expect(first).toMatchObject({ source: "appkit", scannedAt: "2026-11-18T10:00:00.000Z" });
    expect(first.families).toHaveLength(3);
    await lister.list();
    expect(runs).toBe(1);
    signature = "b"; // a font was installed
    await lister.list();
    expect(runs).toBe(2);
    await lister.list({ refresh: true });
    expect(runs).toBe(3);
  });

  it("keeps the last good list when a rescan fails, and explains an empty one", async () => {
    let fail = false;
    let signature = "a";
    const lister = new FontLister({
      run: async () => {
        if (fail) throw new Error("osascript gone");
        return RAW;
      },
      signature: async () => signature,
    });
    await lister.list();
    fail = true;
    signature = "b";
    const again = await lister.list();
    expect(again.families).toHaveLength(3);
    expect(again.error).toContain("osascript gone");

    const empty = await new FontLister({
      run: async () => {
        throw new Error("no AppKit");
      },
      signature: async () => "x",
    }).list();
    expect(empty.families).toEqual([]);
    expect(empty.error).toContain("Yazı tipleri okunamadı");
  });
});

describe("one face's file (the post editor's text engine)", () => {
  /** A minimal sfnt with a `name` table carrying `ps` as its PostScript name (Windows, UTF-16BE). */
  function face(ps: string, extra = "XXXX"): Uint8Array {
    const nameStr = new Uint8Array(ps.length * 2);
    for (let i = 0; i < ps.length; i++) nameStr[i * 2 + 1] = ps.charCodeAt(i);
    const name = new Uint8Array(6 + 12 + nameStr.length);
    const nv = new DataView(name.buffer);
    nv.setUint16(2, 1); // count
    nv.setUint16(4, 18); // string offset
    nv.setUint16(6, 3); // platform: Windows
    nv.setUint16(12, 6); // name ID 6
    nv.setUint16(14, nameStr.length);
    name.set(nameStr, 18);
    const other = new TextEncoder().encode(extra);
    return { name, other } as unknown as Uint8Array;
  }
  /** A collection of faces (ttcf) built from `face()` parts. */
  function collection(names: string[]): Uint8Array {
    const parts = names.map((n) => face(n) as unknown as { name: Uint8Array; other: Uint8Array });
    const header = 12 + names.length * 4;
    const dirSize = 12 + 2 * 16;
    let size = header + names.length * dirSize;
    const offsets: { dir: number; name: number; other: number }[] = [];
    for (const p of parts) {
      offsets.push({ dir: 0, name: size, other: size + ((p.name.length + 3) & ~3) });
      size += ((p.name.length + 3) & ~3) + ((p.other.length + 3) & ~3);
    }
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out.set(new TextEncoder().encode("ttcf"), 0);
    v.setUint32(8, names.length);
    parts.forEach((p, i) => {
      const at = offsets[i] ?? { dir: 0, name: 0, other: 0 };
      const dir = header + i * dirSize;
      at.dir = dir;
      v.setUint32(12 + i * 4, dir);
      v.setUint32(dir, 0x00010000);
      v.setUint16(dir + 4, 2);
      out.set(new TextEncoder().encode("name"), dir + 12);
      v.setUint32(dir + 12 + 8, at.name);
      v.setUint32(dir + 12 + 12, p.name.length);
      out.set(new TextEncoder().encode("zzzz"), dir + 28);
      v.setUint32(dir + 28 + 8, at.other);
      v.setUint32(dir + 28 + 12, p.other.length);
      out.set(p.name, at.name);
      out.set(p.other, at.other);
    });
    return out;
  }

  it("cuts the named face out of a collection as a font file of its own", () => {
    const ttc = collection(["Brand-Regular", "Brand-Bold"]);
    const bold = faceOfFile(ttc, "Brand-Bold");
    expect(bold).not.toBeNull();
    const b = bold as Uint8Array;
    expect(new DataView(b.buffer).getUint32(0)).toBe(0x00010000);
    expect(postscriptNameAt(b, 0)).toBe("Brand-Bold");
    expect(faceOfFile(ttc, "Brand-Black")).toBeNull();
    const single = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(faceOfFile(single, "Anything")).toBe(single);
  });

  it("reads a face by PostScript name through the located file", async () => {
    const ttc = collection(["Brand-Regular", "Brand-Bold"]);
    const files = new FontFiles({
      locate: async (names) =>
        Object.fromEntries(
          names.map((n) => [n, n.startsWith("Brand") ? "/Library/Fonts/Brand.ttc" : null]),
        ),
      read: async () => ttc,
    });
    expect(postscriptNameAt((await files.read("Brand-Regular")) as Uint8Array, 0)).toBe(
      "Brand-Regular",
    );
    expect(await files.read("Missing-Font")).toBeNull();
    expect(await files.read("../../etc/passwd")).toBeNull();
  });
});
