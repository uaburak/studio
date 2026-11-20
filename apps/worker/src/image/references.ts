/**
 * Which of a product's photos go to the image model (docs/URETIM-RESIM.md §7): the ones that
 * show the side the request asks for ("sola bakan" → a left / side photo, by the photo's
 * `angleHint` from `productPhotoAngle()`); when nothing decides it, the first few (the cover
 * first), at most MAX_PRODUCT_REFERENCES.
 */

/** Product photos sent when the request does not decide which. */
export const MAX_PRODUCT_REFERENCES = 3;

export interface ProductPhotoRef {
  assetId: string;
  /** Order in the product (0 = cover). */
  position: number;
  /** "ön", "arka, etiket", "sol" … (null: unknown). */
  angleHint: string | null;
}

export interface ReferenceChoice {
  assetIds: string[];
  /** True when the photos were picked for the requested side. */
  decided: boolean;
  /** The sides asked for, best first ("sol", "yan"). */
  wanted: string[];
  /** One Turkish sentence for logs and the tool result. */
  reason: string;
}

const word = (alternatives: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])(${alternatives})([^\\p{L}\\p{N}]|$)`, "iu");

/**
 * Words of a request that name a view, and the photo angles that show it (best first). Only
 * directional forms: "arka planda" (background) or "masanın üstünde" (on the table) name no view.
 */
const VIEWS: Array<[RegExp, string[]]> = [
  [word("sola|soldan|sol taraf\\p{L}*|sol yan\\p{L}*|sol profil\\p{L}*|left"), ["sol", "yan"]],
  [
    word("sağa|saga|sağdan|sagdan|sağ taraf\\p{L}*|sag taraf\\p{L}*|sağ yan\\p{L}*|right"),
    ["sağ", "yan"],
  ],
  [
    word("yandan|yan taraf\\p{L}*|yan yüz\\p{L}*|yan etiket\\p{L}*|profil\\p{L}*|side"),
    ["yan", "sol", "sağ"],
  ],
  [
    word(
      "arkadan|arka yüz\\p{L}*|arka taraf\\p{L}*|arka etiket\\p{L}*|arkası\\p{L}*|back side|back label|rear",
    ),
    ["arka"],
  ],
  [word("önden|onden|ön yüz\\p{L}*|ön taraf\\p{L}*|ön etiket\\p{L}*|karşıdan|front"), ["ön"]],
  [word("üstten|ustten|yukarıdan|tepeden|kuşbakışı|kusbakisi|top view|from above"), ["üst"]],
  [word("alttan|aşağıdan|bottom view|from below"), ["alt"]],
  [word("yakın plan\\p{L}*|yakından|detay\\p{L}*|close-up|closeup|macro"), ["yakın plan"]],
];

/** The views a request (and the agent's own `view` word) asks for, best first. */
export function requestedViews(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const text = texts.filter(Boolean).join(" ");
  const out: string[] = [];
  for (const [re, angles] of VIEWS) {
    if (!re.test(text)) continue;
    for (const a of angles) if (!out.includes(a)) out.push(a);
  }
  // A bare angle word the agent passed as `view` ("sol", "arka").
  for (const bare of texts) {
    const v = bare?.trim().toLocaleLowerCase("tr-TR");
    if (v && ["ön", "arka", "sol", "sağ", "yan", "üst", "alt", "etiket"].includes(v)) {
      if (!out.includes(v)) out.unshift(v);
    }
  }
  return out;
}

function angles(photo: ProductPhotoRef): string[] {
  return (photo.angleHint ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Pick the photos for a request. With wanted views: the photos showing the best-ranked view
 * that any photo has (up to `max`); otherwise the first `max` photos.
 */
export function selectProductReferences(
  photos: readonly ProductPhotoRef[],
  request: { prompt?: string | null; view?: string | null },
  max = MAX_PRODUCT_REFERENCES,
): ReferenceChoice {
  const ordered = [...photos].sort((a, b) => a.position - b.position);
  const wanted = requestedViews(request.view, request.prompt);
  for (const view of wanted) {
    const hits = ordered.filter((p) => angles(p).includes(view));
    if (hits.length > 0) {
      return {
        assetIds: hits.slice(0, max).map((p) => p.assetId),
        decided: true,
        wanted,
        reason: `İstenen açı (${wanted[0]}) için "${view}" fotoğrafı seçildi.`,
      };
    }
  }
  return {
    assetIds: ordered.slice(0, max).map((p) => p.assetId),
    decided: false,
    wanted,
    reason:
      wanted.length > 0
        ? `İstenen açıya (${wanted[0]}) uyan fotoğraf bulunamadı; ilk ${Math.min(max, ordered.length)} fotoğraf gönderildi.`
        : `Açı belirtilmedi; ilk ${Math.min(max, ordered.length)} fotoğraf gönderildi.`,
  };
}
