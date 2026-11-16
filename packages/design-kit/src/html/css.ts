/**
 * A small CSS Syntax Level 3 tokenizer and rule/declaration parser that keeps source
 * ranges, so callers can check CSS (sanitiser, linter) and edit it with minimal splices
 * (style attributes). Escapes are decoded in token values, so `\75 rl(` is seen as `url(`.
 *
 * Offsets are UTF-16 indices into the original string. Isomorphic: no dependencies.
 */

export type CssTokenType =
  | "ident"
  | "function"
  | "at-keyword"
  | "hash"
  | "string"
  | "bad-string"
  | "url"
  | "bad-url"
  | "delim"
  | "number"
  | "percentage"
  | "dimension"
  | "whitespace"
  | "comment"
  | "CDO"
  | "CDC"
  | "colon"
  | "semicolon"
  | "comma"
  | "["
  | "]"
  | "("
  | ")"
  | "{"
  | "}";

export interface CssToken {
  type: CssTokenType;
  /** Decoded value: name for ident/function/at-keyword/hash, contents for string/url, char for delim, numeric text for numbers. */
  value: string;
  /** Unit of a dimension token (decoded, as written). */
  unit?: string;
  start: number;
  end: number;
}

const isWs = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isNameStart = (c: string | undefined) =>
  c !== undefined && (/^[a-zA-Z_]$/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";
const isNewline = (c: string | undefined) => c === "\n" || c === "\r" || c === "\f";
const isNonPrintable = (c: string | undefined) => {
  if (c === undefined) return false;
  const n = c.charCodeAt(0);
  return (n >= 0 && n <= 8) || n === 0x0b || (n >= 0x0e && n <= 0x1f) || n === 0x7f;
};

export function tokenizeCss(input: string): CssToken[] {
  const tokens: CssToken[] = [];
  const s = input;
  let i = 0;
  const at = (k: number) => s[k];

  const validEscape = (k: number) =>
    at(k) === "\\" && at(k + 1) !== undefined && !isNewline(at(k + 1));
  const startsIdent = (k: number) => {
    const c = at(k);
    if (c === "-") return isNameStart(at(k + 1)) || at(k + 1) === "-" || validEscape(k + 1);
    if (isNameStart(c)) return true;
    return validEscape(k);
  };
  const startsNumber = (k: number) => {
    const c = at(k);
    if (c === "+" || c === "-") {
      if (isDigit(at(k + 1))) return true;
      return at(k + 1) === "." && isDigit(at(k + 2));
    }
    if (c === ".") return isDigit(at(k + 1));
    return isDigit(c);
  };
  /** Consume an escape starting after the backslash at i; returns the decoded char. */
  const consumeEscape = (): string => {
    const c = at(i);
    if (c === undefined) return "�";
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(at(i))) hex += at(i++);
      if (at(i) === "\r" && at(i + 1) === "\n") i += 2;
      else if (isWs(at(i))) i++;
      const cp = Number.parseInt(hex, 16);
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return "�";
      return String.fromCodePoint(cp);
    }
    i++;
    return c === "\0" ? "�" : c;
  };
  const consumeName = (): string => {
    let out = "";
    for (;;) {
      const c = at(i);
      if (isName(c)) {
        out += c === "\0" ? "�" : c;
        i++;
      } else if (validEscape(i)) {
        i++;
        out += consumeEscape();
      } else return out;
    }
  };
  const consumeNumber = (): string => {
    let repr = "";
    if (at(i) === "+" || at(i) === "-") repr += at(i++);
    while (isDigit(at(i))) repr += at(i++);
    if (at(i) === "." && isDigit(at(i + 1))) {
      repr += at(i++);
      while (isDigit(at(i))) repr += at(i++);
    }
    const c = at(i);
    if (
      (c === "e" || c === "E") &&
      (isDigit(at(i + 1)) || ((at(i + 1) === "+" || at(i + 1) === "-") && isDigit(at(i + 2))))
    ) {
      repr += at(i++);
      if (at(i) === "+" || at(i) === "-") repr += at(i++);
      while (isDigit(at(i))) repr += at(i++);
    }
    return repr;
  };
  const consumeString = (quote: string, start: number): CssToken => {
    let out = "";
    for (;;) {
      const c = at(i);
      if (c === undefined) return { type: "string", value: out, start, end: i };
      if (c === quote) {
        i++;
        return { type: "string", value: out, start, end: i };
      }
      if (isNewline(c)) return { type: "bad-string", value: out, start, end: i };
      if (c === "\\") {
        const n = at(i + 1);
        if (n === undefined) {
          i++;
          continue;
        }
        if (isNewline(n)) {
          i += n === "\r" && at(i + 2) === "\n" ? 3 : 2;
          continue;
        }
        i++;
        out += consumeEscape();
        continue;
      }
      out += c === "\0" ? "�" : c;
      i++;
    }
  };
  const consumeBadUrlRemnants = () => {
    for (;;) {
      const c = at(i);
      if (c === undefined) return;
      if (c === ")") {
        i++;
        return;
      }
      if (validEscape(i)) {
        i++;
        consumeEscape();
      } else i++;
    }
  };
  const consumeUrl = (start: number): CssToken => {
    let out = "";
    while (isWs(at(i))) i++;
    for (;;) {
      const c = at(i);
      if (c === undefined) return { type: "url", value: out, start, end: i };
      if (c === ")") {
        i++;
        return { type: "url", value: out, start, end: i };
      }
      if (isWs(c)) {
        while (isWs(at(i))) i++;
        if (at(i) === ")" || at(i) === undefined) {
          if (at(i) === ")") i++;
          return { type: "url", value: out, start, end: i };
        }
        consumeBadUrlRemnants();
        return { type: "bad-url", value: out, start, end: i };
      }
      if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { type: "bad-url", value: out, start, end: i };
      }
      if (c === "\\") {
        if (validEscape(i)) {
          i++;
          out += consumeEscape();
          continue;
        }
        consumeBadUrlRemnants();
        return { type: "bad-url", value: out, start, end: i };
      }
      out += c === "\0" ? "�" : c;
      i++;
    }
  };
  const consumeIdentLike = (start: number): CssToken => {
    const name = consumeName();
    if (name.toLowerCase() === "url" && at(i) === "(") {
      i++;
      // Look past whitespace: a quoted argument makes this a normal function token.
      let k = i;
      while (isWs(at(k)) && isWs(at(k + 1))) k++;
      const n0 = at(k);
      const n1 = isWs(n0) ? at(k + 1) : n0;
      if (n1 === '"' || n1 === "'") {
        i = k;
        return { type: "function", value: name, start, end: i };
      }
      return consumeUrl(start);
    }
    if (at(i) === "(") {
      i++;
      return { type: "function", value: name, start, end: i };
    }
    return { type: "ident", value: name, start, end: i };
  };
  const consumeNumeric = (start: number): CssToken => {
    const num = consumeNumber();
    if (startsIdent(i)) {
      const unit = consumeName();
      return { type: "dimension", value: num, unit, start, end: i };
    }
    if (at(i) === "%") {
      i++;
      return { type: "percentage", value: num, start, end: i };
    }
    return { type: "number", value: num, start, end: i };
  };

  while (i < s.length) {
    const start = i;
    const c = s[i] as string;
    if (c === "/" && at(i + 1) === "*") {
      const close = s.indexOf("*/", i + 2);
      i = close === -1 ? s.length : close + 2;
      tokens.push({ type: "comment", value: "", start, end: i });
      continue;
    }
    if (isWs(c)) {
      while (isWs(at(i))) i++;
      tokens.push({ type: "whitespace", value: " ", start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      tokens.push(consumeString(c, start));
      continue;
    }
    if (c === "#") {
      if (isName(at(i + 1)) || validEscape(i + 1)) {
        i++;
        const name = consumeName();
        tokens.push({ type: "hash", value: name, start, end: i });
      } else {
        i++;
        tokens.push({ type: "delim", value: c, start, end: i });
      }
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}") {
      i++;
      tokens.push({ type: c, value: c, start, end: i });
      continue;
    }
    if (c === ",") {
      i++;
      tokens.push({ type: "comma", value: c, start, end: i });
      continue;
    }
    if (c === ":") {
      i++;
      tokens.push({ type: "colon", value: c, start, end: i });
      continue;
    }
    if (c === ";") {
      i++;
      tokens.push({ type: "semicolon", value: c, start, end: i });
      continue;
    }
    if (c === "+" || c === ".") {
      if (startsNumber(i)) tokens.push(consumeNumeric(start));
      else {
        i++;
        tokens.push({ type: "delim", value: c, start, end: i });
      }
      continue;
    }
    if (c === "-") {
      if (startsNumber(i)) tokens.push(consumeNumeric(start));
      else if (at(i + 1) === "-" && at(i + 2) === ">") {
        i += 3;
        tokens.push({ type: "CDC", value: "-->", start, end: i });
      } else if (startsIdent(i)) tokens.push(consumeIdentLike(start));
      else {
        i++;
        tokens.push({ type: "delim", value: c, start, end: i });
      }
      continue;
    }
    if (c === "<" && s.startsWith("!--", i + 1)) {
      i += 4;
      tokens.push({ type: "CDO", value: "<!--", start, end: i });
      continue;
    }
    if (c === "@") {
      if (startsIdent(i + 1)) {
        i++;
        const name = consumeName();
        tokens.push({ type: "at-keyword", value: name, start, end: i });
      } else {
        i++;
        tokens.push({ type: "delim", value: c, start, end: i });
      }
      continue;
    }
    if (c === "\\") {
      if (validEscape(i)) tokens.push(consumeIdentLike(start));
      else {
        i++;
        tokens.push({ type: "delim", value: c, start, end: i });
      }
      continue;
    }
    if (isDigit(c)) {
      tokens.push(consumeNumeric(start));
      continue;
    }
    if (isNameStart(c) || c === "\0") {
      tokens.push(consumeIdentLike(start));
      continue;
    }
    i++;
    tokens.push({ type: "delim", value: c, start, end: i });
  }
  return tokens;
}

// --- Parsing ---------------------------------------------------------------------

export interface CssDeclaration {
  /** Lowercased property name (custom properties keep their case). */
  name: string;
  /** Range of the whole declaration, including a trailing `;` when present. */
  start: number;
  end: number;
  /** Range of the value text (without `!important` and surrounding whitespace). */
  valueStart: number;
  valueEnd: number;
  /** Value text as written (source slice). */
  value: string;
  important: boolean;
  /** Value tokens (without the `!important` part). */
  tokens: CssToken[];
}

export interface CssRule {
  kind: "at" | "qualified";
  /** Lowercased at-rule name without `@` (`media`, `font-face`); `null` for qualified rules. */
  name: string | null;
  start: number;
  end: number;
  /** Prelude source text (selector or at-rule condition), trimmed. */
  prelude: string;
  preludeTokens: CssToken[];
  /** Block inner range (between `{` and `}`), `null` for statement at-rules (`@import ...;`). */
  block: { start: number; end: number } | null;
  /** Declarations directly in the block. */
  declarations: CssDeclaration[];
  /** Rules nested in the block (at-rule bodies, CSS nesting). */
  rules: CssRule[];
}

export interface CssStylesheet {
  rules: CssRule[];
  tokens: CssToken[];
}

const isTrivia = (t: CssToken) => t.type === "whitespace" || t.type === "comment";

/** Skip a balanced block that starts at tokens[k] (an opening token); returns the index after its closer. */
function skipBlock(tokens: CssToken[], k: number): number {
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    const t = tokens[j] as CssToken;
    if (t.type === "{" || t.type === "[" || t.type === "(" || t.type === "function") depth++;
    else if (t.type === "}" || t.type === "]" || t.type === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

interface ParseCtx {
  src: string;
  tokens: CssToken[];
}

/** Parse a list of rules from tokens[from, to). `topLevel` skips CDO/CDC like a stylesheet. */
function parseRuleList(ctx: ParseCtx, from: number, to: number): CssRule[] {
  const rules: CssRule[] = [];
  let k = from;
  while (k < to) {
    const t = ctx.tokens[k] as CssToken;
    if (isTrivia(t) || t.type === "CDO" || t.type === "CDC" || t.type === "semicolon") {
      k++;
      continue;
    }
    const res = t.type === "at-keyword" ? parseAtRule(ctx, k, to) : parseQualifiedRule(ctx, k, to);
    if (res.rule) rules.push(res.rule);
    k = res.next;
  }
  return rules;
}

function parseAtRule(ctx: ParseCtx, k: number, to: number): { rule: CssRule | null; next: number } {
  const head = ctx.tokens[k] as CssToken;
  const start = head.start;
  let j = k + 1;
  while (j < to) {
    const t = ctx.tokens[j] as CssToken;
    if (t.type === "semicolon") {
      const prelude = ctx.tokens.slice(k + 1, j);
      return {
        rule: {
          kind: "at",
          name: head.value.toLowerCase(),
          start,
          end: t.end,
          prelude: ctx.src.slice(head.end, t.start).trim(),
          preludeTokens: prelude,
          block: null,
          declarations: [],
          rules: [],
        },
        next: j + 1,
      };
    }
    if (t.type === "{") {
      const after = Math.min(skipBlock(ctx.tokens, j), to);
      const closeTok = ctx.tokens[after - 1] as CssToken;
      const closed = closeTok.type === "}" && after - 1 > j;
      const innerStart = t.end;
      const innerEnd = closed ? closeTok.start : (ctx.tokens[after - 1]?.end ?? ctx.src.length);
      const body = parseBlockContents(ctx, j + 1, closed ? after - 1 : after);
      return {
        rule: {
          kind: "at",
          name: head.value.toLowerCase(),
          start,
          end: closed ? closeTok.end : innerEnd,
          prelude: ctx.src.slice(head.end, t.start).trim(),
          preludeTokens: ctx.tokens.slice(k + 1, j),
          block: { start: innerStart, end: innerEnd },
          declarations: body.declarations,
          rules: body.rules,
        },
        next: after,
      };
    }
    if (t.type === "(" || t.type === "[" || t.type === "function") {
      j = skipBlock(ctx.tokens, j);
      continue;
    }
    j++;
  }
  // EOF inside the prelude: the at-rule extends to the end.
  const last = ctx.tokens[to - 1];
  return {
    rule: {
      kind: "at",
      name: head.value.toLowerCase(),
      start,
      end: last ? last.end : head.end,
      prelude: ctx.src.slice(head.end, last ? last.end : head.end).trim(),
      preludeTokens: ctx.tokens.slice(k + 1, to),
      block: null,
      declarations: [],
      rules: [],
    },
    next: to,
  };
}

function parseQualifiedRule(
  ctx: ParseCtx,
  k: number,
  to: number,
): { rule: CssRule | null; next: number } {
  const first = ctx.tokens[k] as CssToken;
  let j = k;
  while (j < to) {
    const t = ctx.tokens[j] as CssToken;
    if (t.type === "{") {
      const after = Math.min(skipBlock(ctx.tokens, j), to);
      const closeTok = ctx.tokens[after - 1] as CssToken;
      const closed = closeTok.type === "}" && after - 1 > j;
      const innerEnd = closed ? closeTok.start : (ctx.tokens[after - 1]?.end ?? ctx.src.length);
      const body = parseBlockContents(ctx, j + 1, closed ? after - 1 : after);
      return {
        rule: {
          kind: "qualified",
          name: null,
          start: first.start,
          end: closed ? closeTok.end : innerEnd,
          prelude: ctx.src.slice(first.start, t.start).trim(),
          preludeTokens: ctx.tokens.slice(k, j),
          block: { start: t.end, end: innerEnd },
          declarations: body.declarations,
          rules: body.rules,
        },
        next: after,
      };
    }
    if (t.type === "(" || t.type === "[" || t.type === "function") {
      j = skipBlock(ctx.tokens, j);
      continue;
    }
    j++;
  }
  // No block: invalid rule, consumed to the end (spec behaviour).
  const last = ctx.tokens[to - 1] as CssToken;
  return {
    rule: {
      kind: "qualified",
      name: null,
      start: first.start,
      end: last.end,
      prelude: ctx.src.slice(first.start, last.end).trim(),
      preludeTokens: ctx.tokens.slice(k, to),
      block: null,
      declarations: [],
      rules: [],
    },
    next: to,
  };
}

/** Block contents: declarations, nested at-rules and nested (CSS nesting) rules. */
function parseBlockContents(
  ctx: ParseCtx,
  from: number,
  to: number,
): { declarations: CssDeclaration[]; rules: CssRule[] } {
  const declarations: CssDeclaration[] = [];
  const rules: CssRule[] = [];
  let k = from;
  while (k < to) {
    const t = ctx.tokens[k] as CssToken;
    if (isTrivia(t) || t.type === "semicolon") {
      k++;
      continue;
    }
    if (t.type === "at-keyword") {
      const res = parseAtRule(ctx, k, to);
      if (res.rule) rules.push(res.rule);
      k = res.next;
      continue;
    }
    // Find the end of this item: `;` at depth 0, or a `{}` block (then it is a nested rule).
    let j = k;
    let isRule = false;
    while (j < to) {
      const u = ctx.tokens[j] as CssToken;
      if (u.type === "semicolon") break;
      if (u.type === "{") {
        isRule = true;
        break;
      }
      if (u.type === "(" || u.type === "[" || u.type === "function") {
        j = skipBlock(ctx.tokens, j);
        continue;
      }
      j++;
    }
    if (isRule) {
      const res = parseQualifiedRule(ctx, k, to);
      if (res.rule) rules.push(res.rule);
      k = res.next;
      continue;
    }
    const decl = parseDeclaration(ctx, k, j);
    if (decl) {
      const semi = ctx.tokens[j];
      if (semi && semi.type === "semicolon") decl.end = semi.end;
      declarations.push(decl);
    }
    k = j + 1;
  }
  return { declarations, rules };
}

/** tokens[from, to) hold one declaration (without the trailing `;`). */
function parseDeclaration(ctx: ParseCtx, from: number, to: number): CssDeclaration | null {
  const nameTok = ctx.tokens[from] as CssToken;
  if (nameTok.type !== "ident") return null;
  let k = from + 1;
  while (k < to && isTrivia(ctx.tokens[k] as CssToken)) k++;
  if (k >= to || (ctx.tokens[k] as CssToken).type !== "colon") return null;
  k++;
  while (k < to && isTrivia(ctx.tokens[k] as CssToken)) k++;
  // Value tokens: trim trailing trivia, detect `!important`.
  let end = to;
  while (end > k && isTrivia(ctx.tokens[end - 1] as CssToken)) end--;
  let important = false;
  {
    let e = end;
    const last = ctx.tokens[e - 1];
    if (last && last.type === "ident" && last.value.toLowerCase() === "important") {
      e--;
      while (e > k && isTrivia(ctx.tokens[e - 1] as CssToken)) e--;
      const bang = ctx.tokens[e - 1];
      if (bang && bang.type === "delim" && bang.value === "!") {
        important = true;
        end = e - 1;
        while (end > k && isTrivia(ctx.tokens[end - 1] as CssToken)) end--;
      }
    }
  }
  const valueTokens = ctx.tokens.slice(k, end);
  const valueStart = valueTokens[0]?.start ?? (ctx.tokens[k - 1] as CssToken).end;
  const valueEnd = valueTokens[valueTokens.length - 1]?.end ?? valueStart;
  const rawName = nameTok.value;
  const lastTok = ctx.tokens[to - 1] as CssToken;
  return {
    name: rawName.startsWith("--") ? rawName : rawName.toLowerCase(),
    start: nameTok.start,
    end: lastTok.end,
    valueStart,
    valueEnd,
    value: ctx.src.slice(valueStart, valueEnd),
    important,
    tokens: valueTokens,
  };
}

/** Parse a stylesheet (`<style>` contents). */
export function parseStylesheet(css: string): CssStylesheet {
  const tokens = tokenizeCss(css);
  const ctx = { src: css, tokens };
  return { rules: parseRuleList(ctx, 0, tokens.length), tokens };
}

/** Parse a declaration list (`style="..."` value). */
export function parseDeclarationList(css: string): CssDeclaration[] {
  return parseDeclarationBlock(css).declarations;
}

/** Declarations plus any (invalid in a `style` attribute) nested rules. */
export function parseDeclarationBlock(css: string): {
  declarations: CssDeclaration[];
  rules: CssRule[];
} {
  const tokens = tokenizeCss(css);
  const ctx = { src: css, tokens };
  return parseBlockContents(ctx, 0, tokens.length);
}

/** Every declaration in a stylesheet, depth-first, with the rule path for messages. */
export function* walkDeclarations(
  rules: CssRule[],
  path: string[] = [],
): Generator<{ decl: CssDeclaration; rule: CssRule; path: string[] }> {
  for (const rule of rules) {
    const label = rule.kind === "at" ? `@${rule.name}` : rule.prelude;
    const p = [...path, label];
    for (const decl of rule.declarations) yield { decl, rule, path: p };
    yield* walkDeclarations(rule.rules, p);
  }
}

/** Every rule (at and qualified), depth-first. */
export function* walkRules(rules: CssRule[]): Generator<CssRule> {
  for (const rule of rules) {
    yield rule;
    yield* walkRules(rule.rules);
  }
}

/**
 * The URL-bearing references in a value: `url(...)` tokens, `url("...")`/`src("...")`
 * functions, and string arguments of `image-set()`/`image()`/`cross-fade()`.
 * `dynamic` is true when a URL-taking function receives `var()`/`env()`/`attr()`,
 * which cannot be checked statically.
 */
export function urlReferences(tokens: CssToken[]): {
  urls: string[];
  dynamic: boolean;
  bad: boolean;
} {
  const urls: string[] = [];
  let dynamic = false;
  let bad = false;
  const URL_FUNCS = new Set(["url", "src"]);
  const IMAGE_FUNCS = new Set([
    "image-set",
    "-webkit-image-set",
    "image",
    "cross-fade",
    "-webkit-cross-fade",
  ]);
  const stack: string[] = [];
  for (const t of tokens) {
    const fn = stack[stack.length - 1];
    if (t.type === "url") urls.push(t.value);
    else if (t.type === "bad-url") bad = true;
    else if (t.type === "string" && fn && (URL_FUNCS.has(fn) || IMAGE_FUNCS.has(fn)))
      urls.push(t.value);
    if (t.type === "function") {
      const name = t.value.toLowerCase();
      if (
        (name === "var" || name === "env" || name === "attr") &&
        stack.some((f) => URL_FUNCS.has(f) || IMAGE_FUNCS.has(f))
      )
        dynamic = true;
      stack.push(name);
    } else if (t.type === "(" || t.type === "[" || t.type === "{") stack.push("");
    else if (t.type === ")" || t.type === "]" || t.type === "}") stack.pop();
  }
  return { urls, dynamic, bad };
}

/** Names of all functions used in a value (lowercased). */
export function functionNames(tokens: CssToken[]): string[] {
  return tokens.filter((t) => t.type === "function").map((t) => t.value.toLowerCase());
}

/** Escape a string for use inside a double-quoted CSS string. */
export function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}
