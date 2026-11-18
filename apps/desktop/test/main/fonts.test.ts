import { describe, expect, it } from "vitest";
import { FontLister, parseAppKitFonts } from "../../src/main/fonts.ts";
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
