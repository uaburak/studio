/**
 * Helpers for the CLI's `stream-json` output: line splitting and incremental
 * decoding of one string field of the structured output while it streams.
 */

/** Splits a byte/char stream into complete lines; keeps the unfinished tail. */
export class LineSplitter {
  private tail = "";

  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const lines = text.split("\n");
    this.tail = lines.pop() ?? "";
    return lines.filter((l) => l.trim().length > 0);
  }

  /** The last line if the stream did not end with a newline. */
  end(): string[] {
    const rest = this.tail.trim();
    this.tail = "";
    return rest ? [rest] : [];
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Decodes the value of one top-level string field (`{"reply": "..."}`) from
 * partial JSON chunks as they arrive (`input_json_delta.partial_json`), so the
 * text can be streamed into the chat before the whole object is complete.
 * Escapes split across chunks (`\u00` + `e7`) and surrogate pairs are handled.
 */
export class JsonStringFieldStream {
  private depth = 0;
  private inString = false;
  private escape = false;
  private unicode: string | null = null;
  private highSurrogate: number | null = null;
  private role: "key" | "value" | "other" = "other";
  private keyBuffer = "";
  private lastKey: string | null = null;
  private expectKey = false;
  private expectValue = false;
  private done = false;
  private captured = "";

  constructor(readonly field: string) {}

  /** Everything decoded so far. */
  get text(): string {
    return this.captured;
  }

  /** True once the field's closing quote was seen. */
  get complete(): boolean {
    return this.done;
  }

  /** Feed the next chunk; returns the newly decoded part of the field (may be ""). */
  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (this.inString) {
        out += this.inStringChar(ch);
        continue;
      }
      switch (ch) {
        case '"':
          this.inString = true;
          if (this.depth === 1 && this.expectKey) {
            this.role = "key";
            this.keyBuffer = "";
          } else if (this.depth === 1 && this.expectValue) {
            this.role = !this.done && this.lastKey === this.field ? "value" : "other";
            this.expectValue = false;
          } else {
            this.role = "other";
          }
          break;
        case "{":
        case "[":
          this.depth++;
          if (this.depth === 1) this.expectKey = ch === "{";
          else if (this.depth === 2) this.expectValue = false;
          break;
        case "}":
        case "]":
          this.depth = Math.max(0, this.depth - 1);
          break;
        case ":":
          if (this.depth === 1) {
            this.expectKey = false;
            this.expectValue = true;
          }
          break;
        case ",":
          if (this.depth === 1) {
            this.expectKey = true;
            this.expectValue = false;
          }
          break;
        default:
          if (this.depth === 1 && this.expectValue && !/\s/.test(ch)) this.expectValue = false;
      }
    }
    this.captured += out;
    return out;
  }

  private inStringChar(ch: string): string {
    if (this.escape) {
      if (this.unicode !== null) {
        this.unicode += ch;
        if (this.unicode.length < 4) return "";
        const code = Number.parseInt(this.unicode, 16);
        this.unicode = null;
        this.escape = false;
        return this.emitCodeUnit(Number.isNaN(code) ? 0xfffd : code);
      }
      if (ch === "u") {
        this.unicode = "";
        return "";
      }
      this.escape = false;
      return this.emit(SIMPLE_ESCAPES[ch] ?? ch);
    }
    if (ch === "\\") {
      this.escape = true;
      return "";
    }
    if (ch === '"') {
      this.inString = false;
      if (this.role === "key") this.lastKey = this.keyBuffer;
      if (this.role === "value") this.done = true;
      const pending = this.flushSurrogate();
      this.role = "other";
      return pending;
    }
    return this.emit(ch);
  }

  private emitCodeUnit(code: number): string {
    if (code >= 0xd800 && code <= 0xdbff) {
      const pending = this.flushSurrogate();
      this.highSurrogate = code;
      return pending;
    }
    if (code >= 0xdc00 && code <= 0xdfff && this.highSurrogate !== null) {
      const pair = String.fromCharCode(this.highSurrogate, code);
      this.highSurrogate = null;
      return this.emitRaw(pair);
    }
    return this.emit(String.fromCharCode(code));
  }

  private flushSurrogate(): string {
    if (this.highSurrogate === null) return "";
    this.highSurrogate = null;
    return this.emitRaw("�");
  }

  private emit(text: string): string {
    return this.flushSurrogate() + this.emitRaw(text);
  }

  private emitRaw(text: string): string {
    if (this.role === "key") {
      this.keyBuffer += text;
      return "";
    }
    return this.role === "value" ? text : "";
  }
}
