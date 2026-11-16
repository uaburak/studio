/**
 * Minimal, deterministic PDF writer: one page per JPEG, the image filling the page.
 * Used for LinkedIn document posts (PDF carousels). No dates and no random ids, so the
 * same slides give the same bytes.
 */

export interface PdfPageImage {
  jpeg: Uint8Array;
  /** Pixel size of the JPEG. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size in CSS px (1px = 0.75pt). */
  cssWidth: number;
  cssHeight: number;
}

export interface PdfOptions {
  title?: string;
}

const enc = new TextEncoder();

function pdfString(s: string): string {
  // ASCII only, escaped; non-ASCII titles are written as UTF-16BE hex.
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = "FEFF";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex +=
        (0xd800 + (v >> 10)).toString(16).padStart(4, "0") +
        (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else hex += cp.toString(16).padStart(4, "0");
  }
  return `<${hex.toUpperCase()}>`;
}

const pt = (px: number) => Number((px * 0.75).toFixed(3));

export function buildImagePdf(
  pages: readonly PdfPageImage[],
  options: PdfOptions = {},
): Uint8Array {
  if (pages.length === 0) throw new Error("a PDF needs at least one page");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const write = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: string | (() => void)) => {
    offsets[n] = size;
    write(`${n} 0 obj\n`);
    if (typeof body === "string") write(body);
    else body();
    write("\nendobj\n");
  };

  write("%PDF-1.7\n");
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageObj = (i: number) => 4 + i * 3;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(
    2,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  obj(
    3,
    `<< /Producer (Studio design-kit)${options.title ? ` /Title ${pdfString(options.title)}` : ""} >>`,
  );
  pages.forEach((p, i) => {
    const n = pageObj(i);
    const w = pt(p.cssWidth);
    const h = pt(p.cssHeight);
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n + 1, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
    obj(n + 2, () => {
      write(
        `<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      write(p.jpeg);
      write("\nendstream");
    });
  });
  const count = 4 + pages.length * 3;
  const xref = size;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) write(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
