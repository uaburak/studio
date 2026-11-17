// QR code encoder (pure): byte mode, the smallest version (1…40) that fits, error correction
// M like the Mac's CIQRCodeGenerator (`correctionLevel = "M"`), the mask with the lowest
// penalty (ISO/IEC 18004 §7.8.3). Port of Project Nayuki's QR Code generator (MIT).

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

const ECC_INDEX: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Format information bits of each level. */
const ECC_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 is padding (versions start at 1).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

export interface QrMatrix {
  version: number;
  /** Modules per side (version × 4 + 17). */
  size: number;
  mask: number;
  /** `modules[y][x]`: true = dark. */
  modules: boolean[][];
}

const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

/** Usable data bits of a version (all modules minus function patterns and format/version). */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecl: QrErrorCorrection): number {
  const e = ECC_INDEX[ecl];
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_CODEWORDS_PER_BLOCK[e]?.[version] ?? 0) * (NUM_ERROR_CORRECTION_BLOCKS[e]?.[version] ?? 0)
  );
}

/** Character count bits of byte mode. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// --- Reed–Solomon over GF(2^8), polynomial 0x11D ------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

// --- encoding -------------------------------------------------------------------------------------

/** UTF-8 bytes → data codewords (mode, count, data, terminator, padding) for `version`. */
function dataCodewordsFor(bytes: Uint8Array, version: number, ecl: QrErrorCorrection): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = new Array(bits.length / 8).fill(0);
  bits.forEach((b, i) => {
    out[i >>> 3] = (out[i >>> 3] as number) | (b << (7 - (i & 7)));
  });
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
function withErrorCorrection(data: number[], version: number, ecl: QrErrorCorrection): number[] {
  const e = ECC_INDEX[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]?.[version] as number;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]?.[version] as number;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  const blockLen = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLen; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding byte of short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i] as number);
    });
  }
  return result;
}

class Builder {
  readonly version: number;
  readonly ecl: QrErrorCorrection;
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number, ecl: QrErrorCorrection) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  private set(x: number, y: number, dark: boolean) {
    (this.modules[y] as boolean[])[x] = dark;
    (this.isFunction[y] as boolean[])[x] = true;
  }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const positions = alignmentPositions(this.version);
    const count = positions.length;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const corner =
          (i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0);
        if (!corner) this.alignment(positions[i] as number, positions[j] as number);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private finder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.set(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private alignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask: number) {
    const data = (ECC_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i));
    this.set(8, n - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(data: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!(this.isFunction[y] as boolean[])[x] && i < data.length * 8) {
            (this.modules[y] as boolean[])[x] = bit(data[i >>> 3] as number, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        const row = this.modules[y] as boolean[];
        if (!(this.isFunction[y] as boolean[])[x] && invert) row[x] = !row[x];
      }
    }
  }

  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let result = 0;
    const line = (get: (i: number) => boolean) => {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        if (get(i) === runColor) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history, n);
          if (!runColor) result += countFinderPatterns(history) * 40;
          runColor = get(i);
          run = 1;
        }
      }
      // Terminate the line (a light border follows).
      if (runColor) {
        addHistory(run, history, n);
        run = 0;
      }
      addHistory(run + n, history, n);
      result += countFinderPatterns(history) * 40;
    };
    for (let y = 0; y < n; y++) line((x) => (m[y] as boolean[])[x] as boolean);
    for (let x = 0; x < n; x++) line((y) => (m[y] as boolean[])[x] as boolean);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = (m[y] as boolean[])[x];
        if (
          c === (m[y] as boolean[])[x + 1] &&
          c === (m[y + 1] as boolean[])[x] &&
          c === (m[y + 1] as boolean[])[x + 1]
        ) {
          result += 3;
        }
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

function addHistory(length: number, history: number[], size: number) {
  // The light border before the first run.
  const value = history[0] === 0 ? length + size : length;
  history.pop();
  history.unshift(value);
}

function countFinderPatterns(h: number[]): number {
  const n = h[1] as number;
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
  return (
    (core && (h[0] as number) >= n * 4 && (h[6] as number) >= n ? 1 : 0) +
    (core && (h[6] as number) >= n * 4 && (h[0] as number) >= n ? 1 : 0)
  );
}

/** Centre coordinates of the alignment patterns (rows and columns alike). */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/** The smallest version whose capacity holds `byteLength` bytes, or null when none does. */
export function qrVersionFor(byteLength: number, ecl: QrErrorCorrection = "M"): number | null {
  for (let version = 1; version <= 40; version++) {
    const used = 4 + countBits(version) + byteLength * 8;
    if (byteLength < 1 << countBits(version) && used <= dataCodewords(version, ecl) * 8) {
      return version;
    }
  }
  return null;
}

/**
 * Encode `text` (UTF-8, byte mode). Throws when the text does not fit version 40.
 * `forceMask` (0–7) skips the penalty search (tests).
 */
export function encodeQr(text: string, ecl: QrErrorCorrection = "M", forceMask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length, ecl);
  if (version === null) throw new Error("text is too long for a QR code");
  const builder = new Builder(version, ecl);
  builder.drawFunctionPatterns();
  builder.drawCodewords(withErrorCorrection(dataCodewordsFor(bytes, version, ecl), version, ecl));
  let best = forceMask ?? 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8 && forceMask === undefined; mask++) {
    builder.applyMask(mask);
    builder.drawFormatBits(mask);
    const penalty = builder.penalty();
    if (penalty < bestPenalty) {
      best = mask;
      bestPenalty = penalty;
    }
    builder.applyMask(mask); // XOR again: undo
  }
  builder.applyMask(best);
  builder.drawFormatBits(best);
  return { version, size: builder.size, mask: best, modules: builder.modules };
}

/** SVG path ("M x y h1 v1 h-1 z" per run of dark modules) offset by `margin` modules. */
export function qrPath(matrix: QrMatrix, margin = 0): string {
  const parts: string[] = [];
  matrix.modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x}v1h${x - end}z`);
      x = end;
    }
  });
  return parts.join("");
}
